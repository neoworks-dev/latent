#include "generative/workflow.h"

#include "ops/op.h"

#include <cstdlib>

#include <algorithm>
#include <filesystem>
#include <fstream>

namespace latent {

namespace {

std::vector<std::string> string_array(const nlohmann::json& value) {
  std::vector<std::string> out;
  if (!value.is_array()) return out;
  for (const nlohmann::json& entry : value) {
    if (entry.is_string()) out.push_back(entry.get<std::string>());
  }
  return out;
}

WorkflowBindings bindings_from_json(const nlohmann::json& value) {
  WorkflowBindings bindings;
  bindings.image = value.value("image", std::string());
  bindings.mask = value.value("mask", std::string());
  bindings.prompt = value.value("prompt", std::string());
  bindings.seed = value.value("seed", std::string());
  bindings.model = value.value("model", std::string());
  bindings.output = value.value("output", std::string());
  return bindings;
}

std::optional<Workflow> read_workflow(const std::filesystem::path& directory) {
  const std::filesystem::path graph_path = directory / "workflow.json";
  const std::filesystem::path bindings_path = directory / "bindings.json";
  std::ifstream graph_file(graph_path, std::ios::binary);
  std::ifstream bindings_file(bindings_path, std::ios::binary);
  if (!graph_file || !bindings_file) return std::nullopt;
  const nlohmann::json graph = nlohmann::json::parse(graph_file, nullptr, false);
  const nlohmann::json meta = nlohmann::json::parse(bindings_file, nullptr, false);
  if (graph.is_discarded() || !graph.is_object()) return std::nullopt;
  if (meta.is_discarded() || !meta.is_object()) return std::nullopt;

  Workflow workflow;
  workflow.name = directory.filename().string();
  workflow.task = meta.value("task", std::string("fill"));
  workflow.label = meta.value("label", workflow.name);
  workflow.required_models = string_array(meta.value("requires", nlohmann::json::array()));
  workflow.bindings = bindings_from_json(meta.value("bindings", nlohmann::json::object()));
  workflow.graph = graph;
  return workflow;
}

// `"17.image"` -> node "17", widget "image".
std::pair<std::string, std::string> split_binding(const std::string& binding) {
  const size_t dot = binding.find('.');
  if (dot == std::string::npos) return {binding, std::string()};
  return {binding.substr(0, dot), binding.substr(dot + 1)};
}

void substitute(nlohmann::json& graph, const std::string& binding, const nlohmann::json& value,
                const std::string& what) {
  if (binding.empty()) return;
  const auto [node_id, widget] = split_binding(binding);
  if (widget.empty()) throw OpError("workflow binding for " + what + " is not '<node>.<widget>'");
  if (!graph.contains(node_id) || !graph[node_id].is_object()) {
    throw OpError("workflow has no node '" + node_id + "' to put " + what + " in");
  }
  nlohmann::json& inputs = graph[node_id]["inputs"];
  if (!inputs.is_object() || !inputs.contains(widget)) {
    throw OpError("workflow node '" + node_id + "' has no widget '" + widget + "' for " + what);
  }
  inputs[widget] = value;
}

}  // namespace

nlohmann::json fill_workflow(const Workflow& workflow, const WorkflowValues& values) {
  nlohmann::json graph = workflow.graph;
  substitute(graph, workflow.bindings.image, values.image, "the crop");
  substitute(graph, workflow.bindings.mask, values.mask, "the mask");
  substitute(graph, workflow.bindings.prompt, values.prompt, "the prompt");
  substitute(graph, workflow.bindings.seed, values.seed, "the seed");
  if (!values.model.empty()) substitute(graph, workflow.bindings.model, values.model, "the model");
  return graph;
}

std::string workflow_dir() {
  const char* override_path = std::getenv("LATENT_WORKFLOW_DIR");
  if (override_path != nullptr && *override_path != '\0') return override_path;
  return LATENT_WORKFLOW_DIR;
}

std::vector<Workflow> load_workflows() {
  std::vector<Workflow> workflows;
  std::error_code error;
  const std::filesystem::path root = workflow_dir();
  if (!std::filesystem::is_directory(root, error)) return workflows;
  for (const auto& entry : std::filesystem::directory_iterator(root, error)) {
    if (!entry.is_directory(error)) continue;
    std::optional<Workflow> workflow = read_workflow(entry.path());
    if (workflow.has_value()) workflows.push_back(std::move(*workflow));
  }
  std::sort(workflows.begin(), workflows.end(),
            [](const Workflow& left, const Workflow& right) { return left.name < right.name; });
  return workflows;
}

std::optional<Workflow> choose_workflow(const std::vector<Workflow>& workflows,
                                        std::string_view task, std::string_view name,
                                        const std::string& workspace) {
  if (!name.empty()) {
    for (const Workflow& workflow : workflows) {
      if (workflow.name == name) return workflow;
    }
  }
  const Workflow* fallback = nullptr;
  for (const Workflow& workflow : workflows) {
    if (workflow.task != task) continue;
    if (fallback == nullptr) fallback = &workflow;
    if (workflow_models_present(workflow, workspace)) return workflow;
  }
  if (fallback == nullptr) return std::nullopt;
  return *fallback;
}

bool workflow_models_present(const Workflow& workflow, const std::string& workspace) {
  if (workspace.empty()) return false;
  if (workflow.required_models.empty()) return true;
  std::error_code error;
  const std::filesystem::path models = std::filesystem::path(workspace) / "models";
  if (!std::filesystem::is_directory(models, error)) return false;
  std::vector<std::string> found;
  const auto options = std::filesystem::directory_options::skip_permission_denied;
  for (const auto& entry : std::filesystem::recursive_directory_iterator(models, options, error)) {
    if (!entry.is_regular_file(error)) continue;
    found.push_back(entry.path().filename().string());
  }
  for (const std::string& needed : workflow.required_models) {
    if (std::find(found.begin(), found.end(), needed) == found.end()) return false;
  }
  return true;
}

}  // namespace latent
