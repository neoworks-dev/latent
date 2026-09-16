// PROMPT.md section 8, step 4: embed CPython via pybind11, expose one C++ function
// as module `probe`, run a script against it. With --mcp, additionally start the
// official Python MCP SDK's streamable-HTTP server inside this interpreter and block,
// so a client (Claude Code, curl) can call the `ping` tool.
#include <chrono>
#include <cstdio>
#include <cstring>

#include <exception>
#include <string>

#include <pybind11/embed.h>

namespace py = pybind11;

namespace {

int calls = 0;

int add_exposure(int stops) {
  ++calls;
  return stops * 2;
}

PYBIND11_EMBEDDED_MODULE(probe, module) {
  module.doc() = "latent engine probe: C++ functions visible from embedded Python";
  module.def("add_exposure", &add_exposure, "Doubles its argument; counts calls on the C++ side.");
  module.attr("value") = 0;
}

constexpr const char* kScript = R"(
import sys, probe
probe.value = 1
result = [probe.add_exposure(i) for i in range(5)]
print("python", sys.version.split()[0], "result", result, "value", probe.value)
)";

// The MCP server is plain Python using the official SDK. It runs on a thread the
// SDK owns (uvicorn), inside this process, with access to the `probe` module.
// MCP Python SDK 2.x API: MCPServer (FastMCP was the 1.x name).
constexpr const char* kMcpScript = R"(
import probe
from mcp.server.mcpserver import MCPServer

server = MCPServer("latent-probe")

@server.tool()
def ping(stops: int = 1) -> dict:
    """Calls into the C++ engine and returns what came back."""
    return {"doubled": probe.add_exposure(stops), "value": probe.value}

print("mcp streamable-http on http://127.0.0.1:7789/mcp", flush=True)
server.run(transport="streamable-http", host="127.0.0.1", port=7789)
)";

}  // namespace

int main(int argc, char** argv) {
  using clock = std::chrono::steady_clock;
  const bool run_mcp = argc > 1 && std::strcmp(argv[1], "--mcp") == 0;
  try {
    auto t0 = clock::now();
    // The bundled interpreter lives under the vcpkg prefix; without `home` CPython derives
    // sys.prefix from argv[0] and finds neither its stdlib nor site-packages.
    PyConfig config;
    PyConfig_InitPythonConfig(&config);
    PyConfig_SetBytesString(&config, &config.home, LATENT_PYTHON_HOME);
    py::scoped_interpreter interpreter(&config);
    PyConfig_Clear(&config);
    auto t1 = clock::now();
    std::printf("interpreter up in %.1f ms\n",
                std::chrono::duration<double, std::milli>(t1 - t0).count());

    py::exec(kScript);
    auto t2 = clock::now();
    std::printf("script ran in %.2f ms, C++ saw %d calls\n",
                std::chrono::duration<double, std::milli>(t2 - t1).count(), calls);

    py::module_ probe = py::module_::import("probe");
    const int value = probe.attr("value").cast<int>();
    std::printf("probe.value read back from C++: %d\n", value);
    std::printf("RESULT %s\n", (calls == 5 && value == 1) ? "PASS" : "FAIL");
    std::fflush(stdout);

    if (run_mcp) {
      try {
        py::exec(kMcpScript);
      } catch (const py::error_already_set& error) {
        // Report inside the interpreter's lifetime; letting this escape past
        // scoped_interpreter's destructor crashes on the dangling PyObject.
        std::fprintf(stderr, "mcp script failed: %s\n", error.what());
        return 3;
      }
    }
    return (calls == 5 && value == 1) ? 0 : 1;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "probe_python failed: %s\n", error.what());
    return 2;
  }
}
