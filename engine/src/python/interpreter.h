// The one embedded CPython interpreter. Started on the server thread at boot, kept alive
// for the life of the daemon, and shared by python.run, the console and the MCP server.
#pragma once

#include "python/engine_api.h"
#include "python/module.h"

#include <chrono>
#include <cstdint>

#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace latent {

struct PythonRunResult {
  bool ok = true;
  std::string out;
  std::string err;
  std::string value;
  bool has_value = false;
};

class PythonHost {
 public:
  // `package_dir` is engine/python/latent: it becomes `latent.__path__`, so the C++ module
  // and its pure-Python submodules (latent.mcp_server, latent._runner) are one package.
  PythonHost(EngineApi& api, const std::string& package_dir);
  ~PythonHost();
  PythonHost(const PythonHost&) = delete;
  PythonHost& operator=(const PythonHost&) = delete;

  // Blocks the calling (server) thread until the script ends or `timeout_ms` expires, at
  // which point the script is interrupted with KeyboardInterrupt and reported as failed.
  // `sink` receives the script's output as it is written; pass {} for no streaming.
  PythonRunResult run(const std::string& code, int64_t photo_id, int timeout_ms,
                      const python_module::OutputSink& sink);

  // Default budget for scripts that did not ask for one — MCP tool calls, above all.
  static constexpr int kDefaultTimeoutMs = 30000;

  // Starts engine/python/latent/mcp_server.py on a Python thread and writes
  // ~/.config/latent/mcp.port. Returns the bound port, or 0 when the SDK is missing.
  int start_mcp(int requested_port);

  // The engine is going away: later calls from Python raise instead of touching it.
  void detach();

 private:
  class Interpreter;

  python_module::RunResult run_watched(const std::string& code, int64_t photo_id,
                                       const std::string& source, int timeout_ms,
                                       const python_module::OutputSink& sink);
  void watchdog();
  // Locks in the order mutex_ then the GIL, always: run() must not hold the GIL while it
  // takes mutex_, or the two threads deadlock against each other.
  void interrupt_running_script();

  std::unique_ptr<Interpreter> interpreter_;
  std::string port_file_;

  std::mutex mutex_;
  std::condition_variable wake_;
  bool running_ = false;
  bool stopping_ = false;
  uint64_t generation_ = 0;
  unsigned long script_thread_ = 0;
  std::chrono::steady_clock::time_point deadline_;
  // Written under the GIL around the exec itself, so the watchdog can tell "still running"
  // from "finished, GIL not yet released" and never interrupts the next script.
  std::atomic<bool> script_active_{false};
  std::thread watchdog_;
};

}  // namespace latent
