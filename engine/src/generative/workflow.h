// The ComfyUI graphs Latent ships (PROMPT.md 3.5). One directory per task under
// `engine/workflows/`:
//
//   <task>/fragment.json     the decomposed template, `comfy workflow decompose`
//   <task>/blueprint.yaml    what `comfy workflow compose` reads
//   <task>/workflow.json     the compiled API-format graph — the template
//   <task>/bindings.json     which node id and widget each runtime value goes into
//
// The compiled graph is never edited on disk. A run copies it, substitutes by node id, and
// writes the copy into its own temp directory; `engine/workflows/README.md` lists the ids.
#pragma once

#include <cstdint>

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace latent {

// `"<nodeId>.<widget>"`, e.g. `"17.image"`. Empty means the graph has no such input, which
// is how `remove` says it takes no prompt.
struct WorkflowBindings {
  std::string image;
  std::string mask;
  std::string prompt;
  std::string seed;
  std::string model;
  // Node id of the SaveImage the result comes out of, so the envelope's outputs_by_node
  // can be read without guessing which output is the picture.
  std::string output;
};

struct Workflow {
  std::string name;
  // Which op it serves: "fill" for generative_fill, "remove" for remove.
  std::string task;
  std::string label;
  // Weight files the graph loads. Reported by generative.status so the UI can say which
  // graph is runnable instead of letting a run fail inside ComfyUI.
  std::vector<std::string> required_models;
  WorkflowBindings bindings;
  nlohmann::json graph;
};

struct WorkflowValues {
  // Server-side names, as `comfy upload` reported them.
  std::string image;
  std::string mask;
  std::string prompt;
  int64_t seed = 0;
  // Empty leaves the graph's own loader alone.
  std::string model;
};

// A copy of `workflow.graph` with the bound widgets replaced. Throws OpError when a bound
// node id or widget is not in the graph — a template and its bindings drifting apart is a
// packaging bug, not something to paper over at run time.
nlohmann::json fill_workflow(const Workflow& workflow, const WorkflowValues& values);

// `$LATENT_WORKFLOW_DIR`, else the directory compiled in at build time.
std::string workflow_dir();

// Every readable graph under workflow_dir(), sorted by name. A directory that is missing
// or malformed yields an empty list rather than throwing: the UI has to be able to say
// "no graphs installed".
std::vector<Workflow> load_workflows();

// The graph a task should run: `name` when it names one, else the first graph for `task`
// whose weights are all present under `workspace`, else the first graph for `task`.
std::optional<Workflow> choose_workflow(const std::vector<Workflow>& workflows,
                                        std::string_view task, std::string_view name,
                                        const std::string& workspace);

// Whether every file in `required_models` exists somewhere under `<workspace>/models/`.
// An empty workspace path answers false without touching the disk.
bool workflow_models_present(const Workflow& workflow, const std::string& workspace);

}  // namespace latent
