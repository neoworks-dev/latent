// latentd — the Latent engine daemon. Owns the GPU, the op-stack and the socket; the
// Electron client is a view. `--port 0` (the default) asks the OS for a free port and
// prints it, which is how apps/desktop finds us.
#include "pipeline/renderer.h"
#include "server/server.h"

#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <pthread.h>
#include <unistd.h>

#include <exception>
#include <string>
#include <thread>

namespace {

// PROMPT.md section 6: fail loudly if the adapter cannot hold a full-res photo.
constexpr uint32_t kRequiredTextureDimension = 16384;

struct Options {
  int port = 0;
  bool valid = true;
};

void print_usage() {
  std::fprintf(stderr, "usage: latentd [--port N] [--no-ui]\n");
  std::fprintf(stderr, "  --port N   listen on N; 0 (default) picks a free port\n");
  std::fprintf(stderr, "  --no-ui    accepted for compatibility; latentd is always headless\n");
}

bool parse_port(const char* text, int& port) {
  char* end = nullptr;
  const long value = std::strtol(text, &end, 10);
  if (end == text || end == nullptr || *end != '\0') return false;
  if (value < 0 || value > 65535) return false;
  port = static_cast<int>(value);
  return true;
}

Options parse_options(int argc, char** argv) {
  Options options;
  for (int i = 1; i < argc; ++i) {
    std::string argument = argv[i];
    if (argument == "--no-ui") continue;
    // `--port N` is folded into `--port=N` so both spellings take one path.
    if (argument == "--port" && i + 1 < argc) argument += "=" + std::string(argv[++i]);
    if (argument.starts_with("--port=") && parse_port(argument.c_str() + 7, options.port)) continue;
    std::fprintf(stderr, "latentd: bad argument '%s'\n", argument.c_str());
    options.valid = false;
    return options;
  }
  return options;
}

}  // namespace

int main(int argc, char** argv) {
  const Options options = parse_options(argc, argv);
  if (!options.valid) {
    print_usage();
    return 2;
  }

  // Signals are handled by one dedicated thread instead of a handler, so shutdown can
  // touch the event loop. Blocking here means every thread created later inherits it.
  sigset_t signals;
  sigemptyset(&signals);
  sigaddset(&signals, SIGINT);
  sigaddset(&signals, SIGTERM);
  pthread_sigmask(SIG_BLOCK, &signals, nullptr);

  try {
    latent::Renderer renderer(kRequiredTextureDimension);
    const latent::GpuReport& gpu = renderer.gpu_report();
    std::fprintf(stderr, "gpu %s, maxTextureDimension2D %u, shader-f16 %s\n", gpu.adapter.c_str(),
                 gpu.max_texture_dimension_2d, gpu.shader_f16 ? "yes" : "no");

    latent::Server server(renderer, options.port);
    std::thread signal_thread([&signals, &server] {
      int received = 0;
      sigwait(&signals, &received);
      server.request_stop();
    });

    server.run();
    kill(getpid(), SIGTERM);  // wakes the waiter if the loop ended for another reason
    signal_thread.join();
    std::fflush(stdout);
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "latentd: %s\n", error.what());
    return 1;
  }
}
