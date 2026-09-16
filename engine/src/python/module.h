// Glue for the embedded `latent` module. The module itself is defined in module.cpp with
// PYBIND11_EMBEDDED_MODULE; these functions let the interpreter host point it at the
// engine and tell it which photo and which writer the current script is.
#pragma once

#include "python/engine_api.h"

#include <cstdint>

#include <functional>
#include <string>

namespace latent::python_module {

// Called from inside a running script for every chunk it writes, so the engine can stream
// it as python.output. Empty when the caller does not want streaming.
using OutputSink = std::function<void(const std::string& stream, const std::string& text)>;

void bind_engine(EngineApi* api);

// `latent.photo` resolves to this id while a script runs; 0 = the most recent open photo.
void set_bound_photo(int64_t photo_id);

// The `source` that stack.changed notifications carry: "python" or "mcp".
void set_source(std::string source);

struct RunResult {
  bool ok = true;
  std::string out;
  std::string err;
  std::string value;
  bool has_value = false;
};

// Runs `code` like a REPL cell. The caller must hold the GIL and be on the server thread.
RunResult run_code(const std::string& code, int64_t photo_id, const std::string& source,
                   const OutputSink& sink);

// How `latent._run_code` (the MCP tool's entry point) runs a script: PythonHost installs
// its watchdogged path here, so an agent's runaway loop is interrupted like a console's.
using ScriptRunner =
    std::function<RunResult(const std::string& code, int64_t photo_id, const std::string& source)>;
void set_script_runner(ScriptRunner runner);

}  // namespace latent::python_module
