#include "generative/comfy_cli.h"

#include <csignal>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <spawn.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>

#include <sys/wait.h>

extern char** environ;

namespace latent {

namespace {

constexpr size_t kReadChunk = 16 * 1024;

// One child process with its stdout on a pipe and its stderr in a temp file. Everything
// here is a plain file descriptor, so the destructor is the only cleanup path.
class Child {
 public:
  Child(const std::string& executable, const std::vector<std::string>& args) {
    std::error_code error;
    errors_ = (std::filesystem::temp_directory_path(error) /
               ("latent-comfy-" + std::to_string(::getpid()) + "-" + std::to_string(++counter()) +
                ".log"))
                  .string();

    std::array<int, 2> pipe_fds{-1, -1};
    if (::pipe(pipe_fds.data()) != 0) return;
    const int error_fd = ::open(errors_.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);

    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_addclose(&actions, pipe_fds[0]);
    posix_spawn_file_actions_adddup2(&actions, pipe_fds[1], STDOUT_FILENO);
    if (error_fd >= 0) posix_spawn_file_actions_adddup2(&actions, error_fd, STDERR_FILENO);
    posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);

    std::vector<char*> argv;
    argv.push_back(const_cast<char*>(executable.c_str()));
    for (const std::string& argument : args) {
      argv.push_back(const_cast<char*>(argument.c_str()));
    }
    argv.push_back(nullptr);

    const int spawned =
        posix_spawnp(&pid_, executable.c_str(), &actions, nullptr, argv.data(), environ);
    posix_spawn_file_actions_destroy(&actions);
    ::close(pipe_fds[1]);
    if (error_fd >= 0) ::close(error_fd);
    if (spawned != 0) {
      ::close(pipe_fds[0]);
      pid_ = -1;
      return;
    }
    out_ = pipe_fds[0];
  }

  ~Child() {
    if (out_ >= 0) ::close(out_);
    if (pid_ > 0) {
      int status = 0;
      ::waitpid(pid_, &status, 0);
    }
    std::error_code error;
    std::filesystem::remove(errors_, error);
  }

  Child(const Child&) = delete;
  Child& operator=(const Child&) = delete;

  bool started() const { return pid_ > 0; }
  void interrupt() const {
    if (pid_ > 0) ::kill(pid_, SIGINT);
  }

  // Blocking read of one chunk. Empty when the child closed stdout.
  std::string read() const {
    std::string chunk(kReadChunk, '\0');
    const ssize_t got = ::read(out_, chunk.data(), chunk.size());
    if (got <= 0) return {};
    chunk.resize(static_cast<size_t>(got));
    return chunk;
  }

  int wait() {
    if (out_ >= 0) {
      ::close(out_);
      out_ = -1;
    }
    int status = 0;
    if (pid_ <= 0 || ::waitpid(pid_, &status, 0) < 0) return -1;
    pid_ = -1;
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return -1;
  }

  std::string errors() const {
    std::ifstream file(errors_, std::ios::binary);
    if (!file) return {};
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
  }

 private:
  static int& counter() {
    static int value = 0;
    return value;
  }

  pid_t pid_ = -1;
  int out_ = -1;
  std::string errors_;
};

bool is_envelope(const nlohmann::json& value) {
  return value.is_object() && value.value("type", std::string()) == "envelope";
}

void take_envelope(ComfyEnvelope& out, const nlohmann::json& value) {
  out.parsed = true;
  out.ok = value.value("ok", false);
  out.data = value.value("data", nlohmann::json());
  const nlohmann::json& error = value.contains("error") ? value["error"] : nlohmann::json();
  if (!error.is_object()) return;
  out.code = error.value("code", std::string());
  out.message = error.value("message", std::string());
  out.hint = error.value("hint", std::string());
  if (out.hint.empty()) out.hint = comfy_hint_for(out.code, out.message);
}

ComfyEnvelope drive(const std::string& mode, std::span<const std::string> args,
                    const ComfyEvent& on_event) {
  ComfyEnvelope envelope;
  const std::string executable = comfy_executable();
  if (executable.empty()) {
    envelope.code = "comfy_not_installed";
    envelope.message = "the `comfy` CLI is not on PATH";
    envelope.hint = "install comfy-cli, or set LATENT_COMFY to its path";
    return envelope;
  }

  std::vector<std::string> argv;
  argv.push_back(mode);
  argv.insert(argv.end(), args.begin(), args.end());
  Child child(executable, argv);
  if (!child.started()) {
    envelope.code = "comfy_not_installed";
    envelope.message = "cannot run " + executable;
    return envelope;
  }

  std::string pending;
  bool cancelled = false;
  while (true) {
    const std::string chunk = child.read();
    if (chunk.empty()) break;
    pending += chunk;
    size_t newline = pending.find('\n');
    while (newline != std::string::npos) {
      const std::string line = pending.substr(0, newline);
      pending.erase(0, newline + 1);
      newline = pending.find('\n');
      const nlohmann::json value = nlohmann::json::parse(line, nullptr, false);
      if (value.is_discarded()) continue;
      if (is_envelope(value)) {
        take_envelope(envelope, value);
        continue;
      }
      if (on_event && !cancelled && !on_event(value)) {
        cancelled = true;
        child.interrupt();
      }
    }
  }
  // The last line may arrive without a trailing newline.
  const nlohmann::json tail = nlohmann::json::parse(pending, nullptr, false);
  if (is_envelope(tail)) take_envelope(envelope, tail);

  envelope.exit_code = child.wait();
  envelope.errors = child.errors();
  if (envelope.parsed) return envelope;

  // Nothing parseable on stdout: a usage error, or a CLI too old to speak envelope/1.
  envelope.code = cancelled ? "cancelled" : "comfy_usage_error";
  envelope.message = envelope.errors.empty()
                         ? "comfy exited " + std::to_string(envelope.exit_code) + " without JSON"
                         : envelope.errors.substr(0, 400);
  envelope.hint = comfy_hint_for(envelope.code, envelope.message);
  return envelope;
}

}  // namespace

std::string comfy_hint_for(const std::string& code, const std::string& message) {
  if (code == "server_not_running") return "start ComfyUI: `comfy launch`";
  std::string lowered = message;
  std::transform(lowered.begin(), lowered.end(), lowered.begin(),
                 [](unsigned char letter) { return static_cast<char>(std::tolower(letter)); });
  const bool refused = lowered.find("connection refused") != std::string::npos ||
                       lowered.find("connection error") != std::string::npos ||
                       lowered.find("cannot connect") != std::string::npos ||
                       lowered.find("failed to establish a new connection") != std::string::npos;
  if (refused) return "ComfyUI is not answering: start it with `comfy launch`";
  return {};
}

std::string ComfyEnvelope::failure() const {
  if (!message.empty() && !hint.empty()) return message + " (" + hint + ")";
  if (!message.empty()) return message;
  if (!code.empty()) return code;
  return "comfy failed with exit code " + std::to_string(exit_code);
}

std::string comfy_executable() {
  const char* override_path = std::getenv("LATENT_COMFY");
  std::error_code error;
  if (override_path != nullptr && *override_path != '\0') {
    if (std::filesystem::is_regular_file(override_path, error)) return override_path;
    return {};
  }
  const char* home = std::getenv("HOME");
  if (home != nullptr) {
    const std::string local = std::string(home) + "/.local/bin/comfy";
    if (std::filesystem::is_regular_file(local, error)) return local;
  }
  const char* path = std::getenv("PATH");
  if (path == nullptr) return {};
  std::string_view rest = path;
  while (!rest.empty()) {
    const size_t colon = rest.find(':');
    const std::string_view directory = rest.substr(0, colon);
    if (!directory.empty()) {
      const std::string candidate = std::string(directory) + "/comfy";
      if (std::filesystem::is_regular_file(candidate, error)) return candidate;
    }
    if (colon == std::string_view::npos) break;
    rest.remove_prefix(colon + 1);
  }
  return {};
}

ComfyEnvelope comfy_call(std::span<const std::string> args) {
  return drive("--json", args, {});
}

ComfyEnvelope comfy_stream(std::span<const std::string> args, const ComfyEvent& on_event) {
  return drive("--json-stream", args, on_event);
}

std::string comfy_workspace_path() {
  // Cached: it is a config lookup, it does not change while the daemon runs, and
  // generative.status asks for it on every UI connect.
  static const std::string workspace = [] {
    const std::array<std::string, 1> args = {"which"};
    const ComfyEnvelope envelope = comfy_call(args);
    if (!envelope.ok || !envelope.data.is_object()) return std::string();
    return envelope.data.value("workspace_path", std::string());
  }();
  return workspace;
}

std::string comfy_output_path(const std::string& entry, const std::string& workspace) {
  if (entry.empty()) return {};
  if (entry.front() == '/') return entry;
  const size_t query = entry.find('?');
  if (query == std::string::npos || workspace.empty()) return {};

  std::string filename;
  std::string subfolder;
  std::string type = "output";
  std::string_view rest(entry);
  rest.remove_prefix(query + 1);
  while (!rest.empty()) {
    const size_t amp = rest.find('&');
    const std::string_view pair = rest.substr(0, amp);
    const size_t equals = pair.find('=');
    if (equals != std::string_view::npos) {
      const std::string_view key = pair.substr(0, equals);
      const std::string value(pair.substr(equals + 1));
      if (key == "filename") filename = value;
      if (key == "subfolder") subfolder = value;
      if (key == "type" && !value.empty()) type = value;
    }
    if (amp == std::string_view::npos) break;
    rest.remove_prefix(amp + 1);
  }
  if (filename.empty()) return {};
  std::filesystem::path path = std::filesystem::path(workspace) / type;
  if (!subfolder.empty()) path /= subfolder;
  return (path / filename).string();
}

}  // namespace latent
