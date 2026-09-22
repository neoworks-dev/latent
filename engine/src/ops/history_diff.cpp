#include "ops/history_diff.h"

#include <algorithm>

namespace latent {
namespace {

// Groups hold their adjustments, so an id may be nested one level. Every step is about one
// op, and the id is unique across the photo, so the flattened list is what a diff walks.
std::vector<const Op*> flatten(const Stack& stack) {
  std::vector<const Op*> ops;
  for (const Op& op : stack) {
    ops.push_back(&op);
    for (const Op& child : op.ops)
      ops.push_back(&child);
  }
  return ops;
}

const Op* find_by_id(const std::vector<const Op*>& ops, const std::string& id) {
  const auto found =
      std::find_if(ops.begin(), ops.end(), [&](const Op* op) { return op->id == id; });
  return found == ops.end() ? nullptr : *found;
}

// A scalar is something a history row can print; anything else (a curve's points) is
// reported as a change with no values rather than as a wall of numbers.
nlohmann::json scalar_or_null(const nlohmann::json& value) {
  if (value.is_number() || value.is_string() || value.is_boolean()) return value;
  return nlohmann::json();
}

void collect_param_changes(const Op& before, const Op& after, std::vector<ParamChange>& changes) {
  for (const auto& [key, value] : after.params.items()) {
    const auto previous = before.params.find(key);
    const nlohmann::json was = previous == before.params.end() ? nlohmann::json() : *previous;
    if (was == value) continue;
    changes.push_back({key, scalar_or_null(was), scalar_or_null(value)});
  }
  // A parameter the step dropped moved too — back to whatever the op's default is, which
  // the UI knows and the engine does not have to repeat here.
  for (const auto& [key, value] : before.params.items()) {
    if (after.params.contains(key)) continue;
    changes.push_back({key, scalar_or_null(value), nlohmann::json()});
  }
}

}  // namespace

HistoryStep describe_step(const Stack& before, const Stack& after) {
  const std::vector<const Op*> old_ops = flatten(before);
  const std::vector<const Op*> new_ops = flatten(after);

  // Every op the commit touched, not the first: one slider and a whole preset both arrive
  // here as one commit, and they are only told apart by counting.
  std::vector<HistoryStep> touched;
  for (const Op* op : new_ops) {
    if (find_by_id(old_ops, op->id) == nullptr) touched.push_back({"add", op->name, op->id, {}});
  }
  for (const Op* op : old_ops) {
    if (find_by_id(new_ops, op->id) == nullptr) touched.push_back({"remove", op->name, op->id, {}});
  }
  for (const Op* op : new_ops) {
    const Op* was = find_by_id(old_ops, op->id);
    if (was == nullptr) continue;
    // The mask first: a stroke changes nothing else, and a row that said "opacity" for it
    // would be a lie.
    if (was->mask != op->mask) {
      touched.push_back({"mask", op->name, op->id, {}});
      continue;
    }
    std::vector<ParamChange> changes;
    collect_param_changes(*was, *op, changes);
    if (was->enabled != op->enabled) {
      changes.push_back({"enabled", was->enabled, op->enabled});
    }
    if (was->opacity != op->opacity) {
      changes.push_back({"opacity", was->opacity, op->opacity});
    }
    if (!changes.empty()) touched.push_back({"update", op->name, op->id, std::move(changes)});
  }

  // Same ops, same values: the only thing left that a commit can have done is move them.
  if (touched.empty()) return {"reorder", "", "", {}};
  if (touched.size() == 1) return std::move(touched.front());
  return {"batch", "", "", {}, std::move(touched)};
}

std::vector<HistoryStep> describe_history(const std::vector<Stack>& snapshots,
                                          const std::vector<std::string>& labels) {
  std::vector<HistoryStep> steps;
  steps.reserve(snapshots.size());
  for (size_t index = 0; index < snapshots.size(); ++index) {
    HistoryStep step = index == 0 ? HistoryStep{"initial", "", "", {}}
                                  : describe_step(snapshots[index - 1], snapshots[index]);
    if (index < labels.size()) step.label = labels[index];
    steps.push_back(std::move(step));
  }
  return steps;
}

namespace {

// The fields a step and a batch's entry have in common. An entry carries no index: it is
// one op of a step rather than a step of its own.
nlohmann::json step_body_to_json(const HistoryStep& step) {
  nlohmann::json value = nlohmann::json::object();
  if (!step.op.empty()) value["op"] = step.op;
  if (!step.op_id.empty()) value["opId"] = step.op_id;
  if (step.changes.empty()) return value;
  nlohmann::json changes = nlohmann::json::array();
  for (const ParamChange& change : step.changes) {
    nlohmann::json entry = {{"param", change.param}};
    if (!change.from.is_null()) entry["from"] = change.from;
    if (!change.to.is_null()) entry["to"] = change.to;
    changes.push_back(std::move(entry));
  }
  value["changes"] = std::move(changes);
  return value;
}

}  // namespace

nlohmann::json history_step_to_json(const HistoryStep& step, size_t index) {
  nlohmann::json value = step_body_to_json(step);
  value["index"] = index;
  value["kind"] = step.kind;
  if (!step.label.empty()) value["label"] = step.label;
  if (step.entries.empty()) return value;
  nlohmann::json entries = nlohmann::json::array();
  for (const HistoryStep& entry : step.entries) {
    nlohmann::json body = step_body_to_json(entry);
    body["kind"] = entry.kind;
    entries.push_back(std::move(body));
  }
  value["entries"] = std::move(entries);
  return value;
}

}  // namespace latent
