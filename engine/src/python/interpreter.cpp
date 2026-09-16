#include "python/interpreter.h"

#include <cstdio>
#include <cstdlib>

#include <filesystem>
#include <fstream>
#include <optional>
#include <stdexcept>

#include <pybind11/embed.h>

namespace py = pybind11;

namespace latent {

namespace {

std::filesystem::path config_dir() {
  const char* config_home = std::getenv("XDG_CONFIG_HOME");
  if (config_home != nullptr && config_home[0] != '\0') {
    return std::filesystem::path(config_home) / "latent";
  }
  const char* home = std::getenv("HOME");
  const std::filesystem::path base = home == nullptr ? std::filesystem::current_path() : home;
  return base / ".config" / "latent";
}

// Drops the GIL for its scope when this thread holds it, and does nothing when it does
// not. PyEval_SaveThread crashes if called without the GIL, and both call paths exist.
class DropGilIfHeld {
 public:
  DropGilIfHeld() {
    if (PyGILState_Check() != 0) released_.emplace();
  }

 private:
  std::optional<py::gil_scoped_release> released_;
};

}  // namespace

// Owns py::scoped_interpreter plus the GIL release that lets other threads in. Hidden in
// the .cpp so no other engine header drags in Python.h.
class PythonHost::Interpreter {
 public:
  Interpreter() {
    // The bundled interpreter lives under the vcpkg prefix; without `home` CPython derives
    // sys.prefix from argv[0] and finds neither its stdlib nor site-packages.
    PyConfig config;
    PyConfig_InitPythonConfig(&config);
    PyConfig_SetBytesString(&config, &config.home, LATENT_PYTHON_HOME);
    scoped_ = std::make_unique<py::scoped_interpreter>(&config);
    PyConfig_Clear(&config);
  }

  ~Interpreter() {
    released_.reset();
    if (!leak_) return;
    // A running MCP thread is still inside the interpreter. Finalising under it crashes,
    // and the process is exiting anyway, so the interpreter is deliberately leaked.
    [[maybe_unused]] const py::scoped_interpreter* leaked = scoped_.release();
  }

  Interpreter(const Interpreter&) = delete;
  Interpreter& operator=(const Interpreter&) = delete;

  void release_gil() { released_.emplace(); }
  void leak_on_exit() { leak_ = true; }

 private:
  std::unique_ptr<py::scoped_interpreter> scoped_;
  std::optional<py::gil_scoped_release> released_;
  bool leak_ = false;
};

PythonHost::PythonHost(EngineApi& api, const std::string& package_dir)
    : interpreter_(std::make_unique<Interpreter>()) {
  python_module::bind_engine(&api);
  py::module_ latent = py::module_::import("latent");
  py::list path;
  path.append(package_dir);
  // Turning the C++ module into a package is what makes `import latent.mcp_server` find
  // engine/python/latent/mcp_server.py while `latent` itself stays the pybind11 module.
  latent.attr("__path__") = path;
  py::module_::import("sys").attr("argv") = py::make_tuple("latentd");
  // MCP tool calls run their code through here too, so an agent's runaway loop hits the
  // same watchdog a console script does.
  python_module::set_script_runner(
      [this](const std::string& code, int64_t photo_id, const std::string& source) {
        return run_watched(code, photo_id, source, kDefaultTimeoutMs, {});
      });
  interpreter_->release_gil();
  watchdog_ = std::thread([this] { watchdog(); });
}

PythonHost::~PythonHost() {
  detach();
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    stopping_ = true;
  }
  wake_.notify_all();
  watchdog_.join();
  if (port_file_.empty()) return;
  std::error_code error;
  std::filesystem::remove(port_file_, error);
}

python_module::RunResult PythonHost::run_watched(const std::string& code, int64_t photo_id,
                                                 const std::string& source, int timeout_ms,
                                                 const python_module::OutputSink& sink) {
  {
    // The MCP path calls in holding the GIL; the watchdog takes mutex_ and then the GIL,
    // so nothing may wait for mutex_ while holding it.
    const DropGilIfHeld drop;
    const std::lock_guard<std::mutex> lock(mutex_);
    running_ = true;
    ++generation_;
    script_thread_ = PyThread_get_thread_ident();
    deadline_ = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  }
  wake_.notify_all();

  python_module::RunResult raw;
  {
    const py::gil_scoped_acquire acquire;
    script_active_.store(true);
    raw = python_module::run_code(code, photo_id, source, sink);
    script_active_.store(false);
  }
  {
    const DropGilIfHeld drop;
    const std::lock_guard<std::mutex> lock(mutex_);
    running_ = false;
  }
  wake_.notify_all();
  return raw;
}

PythonRunResult PythonHost::run(const std::string& code, int64_t photo_id, int timeout_ms,
                                const python_module::OutputSink& sink) {
  const python_module::RunResult raw = run_watched(code, photo_id, "python", timeout_ms, sink);
  PythonRunResult result;
  result.ok = raw.ok;
  result.out = raw.out;
  result.err = raw.err;
  result.value = raw.value;
  result.has_value = raw.has_value;
  return result;
}

void PythonHost::watchdog() {
  std::unique_lock<std::mutex> lock(mutex_);
  while (true) {
    wake_.wait(lock, [this] { return stopping_ || running_; });
    if (stopping_) return;
    const uint64_t generation = generation_;
    wake_.wait_until(lock, deadline_,
                     [this, generation] { return stopping_ || generation_ != generation; });
    if (stopping_) return;
    const bool expired =
        running_ && generation_ == generation && std::chrono::steady_clock::now() >= deadline_;
    if (!expired) continue;
    interrupt_running_script();
    // Wait the interrupted script out, or this loop would spin on an expired deadline.
    wake_.wait(lock,
               [this, generation] { return stopping_ || !running_ || generation_ != generation; });
  }
}

void PythonHost::interrupt_running_script() {
  const py::gil_scoped_acquire acquire;
  // The script may have returned while we waited for the GIL; script_active_ is cleared
  // before the GIL is dropped, so this check is the one that makes the race safe.
  if (!script_active_.load()) return;
  PyThreadState_SetAsyncExc(script_thread_, PyExc_KeyboardInterrupt);
}

int PythonHost::start_mcp(int requested_port) {
  const py::gil_scoped_acquire acquire;
  try {
    const py::object start = py::module_::import("latent.mcp_server").attr("start");
    const int port = start(requested_port).cast<int>();
    interpreter_->leak_on_exit();
    const std::filesystem::path file = config_dir() / "mcp.port";
    std::filesystem::create_directories(file.parent_path());
    std::ofstream out(file, std::ios::trunc);
    out << port << "\n";
    port_file_ = file.string();
    return port;
  } catch (const py::error_already_set& error) {
    // Caught inside the interpreter's lifetime on purpose: a py::error_already_set that
    // outlives it dereferences a dead PyObject at teardown.
    std::fprintf(stderr, "[warn] mcp server not started: %s\n", error.what());
    return 0;
  }
}

void PythonHost::detach() {
  python_module::bind_engine(nullptr);
  python_module::set_script_runner({});
}

}  // namespace latent
