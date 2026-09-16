// Driving the `comfy` CLI. The engine never touches ComfyUI's HTTP API (PROMPT.md 3.5) —
// the CLI owns transport, routing, auth and errors — so this is the only file that knows
// how ComfyUI is reached.
//
// Two JSON modes, and mixing them up is the trap: `comfy --json <cmd>` (the *global* flag,
// before the subcommand) prints exactly one envelope; `comfy --json-stream <cmd>` prints
// NDJSON events with the envelope last. `comfy run --json` is the streaming one, because
// run's own `--json` is a stream flag.
//
// A Typer usage error — unknown subcommand, bad flag — prints a box to stderr, exits 2 and
// writes nothing to stdout. That is its own failure class, not an `ok: false` envelope.
#pragma once

#include <functional>
#include <span>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace latent {

// `envelope/1`: the shape every comfy command answers with.
struct ComfyEnvelope {
  // The process ran and stdout held an envelope. False for a usage error or a missing CLI.
  bool parsed = false;
  bool ok = false;
  int exit_code = -1;
  nlohmann::json data;
  // `error.code`, e.g. `server_not_running`, `upload_failed`, `execution_error`.
  std::string code;
  std::string message;
  std::string hint;
  std::string output;
  std::string errors;

  // A one-line reason, whichever of the three the CLI managed to produce.
  std::string failure() const;
};

// Called once per NDJSON line. Returning false asks the run to stop: the child is sent
// SIGINT, which comfy turns into a `cancelled` envelope and exit 130.
using ComfyEvent = std::function<bool(const nlohmann::json& event)>;

// `$LATENT_COMFY`, else `~/.local/bin/comfy`, else `comfy` on PATH. Empty when none exists.
std::string comfy_executable();

// `comfy --json <args...>`: one envelope on stdout.
ComfyEnvelope comfy_call(std::span<const std::string> args);

// `comfy --json-stream <args...>`: NDJSON, the envelope last.
ComfyEnvelope comfy_stream(std::span<const std::string> args, const ComfyEvent& on_event);

// `comfy --json which` → `data.workspace_path`: where the ComfyUI install and its
// `models/` and `output/` directories are. Answers without a running server.
std::string comfy_workspace_path();

// The absolute path of one of a run's outputs. The CLI hands back either a path already or
// a `…/view?filename=&subfolder=&type=` URL; both resolve to
// `<workspace>/<type>/<subfolder>/<filename>`. Empty when the entry makes no sense.
std::string comfy_output_path(const std::string& entry, const std::string& workspace);

}  // namespace latent
