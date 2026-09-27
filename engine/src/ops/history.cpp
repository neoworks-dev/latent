#include "ops/history.h"

#include <algorithm>
#include <map>
#include <utility>

namespace latent {

History::History(Stack initial) {
  nodes_.push_back(HistoryNode{std::move(initial), {}, {}, {}, {}});
}

History::History(std::vector<HistoryNode> nodes, size_t cursor)
    : nodes_(std::move(nodes)), cursor_(cursor) {
  // Redo from a step read back from disk goes to its newest child.
  for (size_t id = 0; id < nodes_.size(); ++id) {
    const std::optional<size_t> parent = nodes_[id].parent;
    if (parent.has_value()) nodes_[*parent].redo_child = id;
  }
}

void History::append(HistoryNode node) {
  const size_t id = nodes_.size();
  nodes_[*node.parent].redo_child = id;
  nodes_.push_back(std::move(node));
  cursor_ = id;
  ++revision_;
}

void History::commit(Stack next, std::string label) {
  const bool had_drag = transient_base_.has_value();
  finish_transient();
  // A commit that lands where the step already is — a slider dragged away and back, a
  // click on the value it holds — is no step. The drag it ends was still a change on
  // screen, so the revision moves for it.
  if (stack_to_json(next) == stack_to_json(current())) {
    if (had_drag) ++revision_;
    return;
  }
  append(HistoryNode{std::move(next), std::move(label), cursor_, {}, {}});
}

bool History::merge(size_t from, Stack next, std::string label) {
  finish_transient();
  if (from >= nodes_.size() || from == cursor_ || descends_from(cursor_, from)) return false;
  append(HistoryNode{std::move(next), std::move(label), cursor_, from, {}});
  return true;
}

// A drag replaces the snapshot under the cursor rather than appending one, so the label on
// that step still belongs to the step that made it and is left alone.
void History::commit_transient(Stack next) {
  if (!transient_base_.has_value()) transient_base_ = current();
  nodes_[cursor_].stack = std::move(next);
  ++revision_;
}

bool History::undo() {
  if (!can_undo()) return false;
  const bool discarded_drag = transient_base_.has_value();
  finish_transient();
  ++revision_;
  if (discarded_drag) return true;
  const size_t parent = *nodes_[cursor_].parent;
  nodes_[parent].redo_child = cursor_;
  cursor_ = parent;
  return true;
}

bool History::redo() {
  finish_transient();
  const std::optional<size_t> target = redo_target();
  if (!target.has_value()) return false;
  cursor_ = *target;
  ++revision_;
  return true;
}

bool History::jump(size_t id) {
  if (id >= nodes_.size()) return false;
  // A drag in flight is rolled back first, as undo does; jumping to the step the cursor
  // is already on is then still a change, because that rollback was one.
  const bool discarded_drag = transient_base_.has_value();
  finish_transient();
  if (id == cursor_ && !discarded_drag) return false;
  // Jumping back along the line the cursor came down leaves redo pointing along it, as a
  // run of undos would have.
  std::vector<size_t> line;
  size_t step = cursor_;
  while (step != id && nodes_[step].parent.has_value()) {
    line.push_back(step);
    step = *nodes_[step].parent;
  }
  if (step == id) {
    for (const size_t child : line) {
      nodes_[*nodes_[child].parent].redo_child = child;
    }
  }
  cursor_ = id;
  ++revision_;
  return true;
}

std::optional<size_t> History::redo_target() const {
  return nodes_[cursor_].redo_child;
}

std::vector<bool> History::ancestors_of(size_t id) const {
  std::vector<bool> marked(nodes_.size(), false);
  std::vector<size_t> pending{id};
  while (!pending.empty()) {
    const size_t step = pending.back();
    pending.pop_back();
    if (marked[step]) continue;
    marked[step] = true;
    if (nodes_[step].parent.has_value()) pending.push_back(*nodes_[step].parent);
    if (nodes_[step].merged_from.has_value()) pending.push_back(*nodes_[step].merged_from);
  }
  return marked;
}

bool History::descends_from(size_t id, size_t ancestor) const {
  return ancestors_of(id)[ancestor];
}

size_t History::common_ancestor(size_t a, size_t b) const {
  const std::vector<bool> left = ancestors_of(a);
  const std::vector<bool> right = ancestors_of(b);
  for (size_t id = nodes_.size(); id-- > 0;) {
    if (left[id] && right[id]) return id;
  }
  return 0;
}

void History::finish_transient() {
  if (!transient_base_.has_value()) return;
  nodes_[cursor_].stack = std::move(*transient_base_);
  transient_base_.reset();
}

namespace {

using Json = nlohmann::json;

bool same(const Json* left, const Json* right) {
  if (left == nullptr || right == nullptr) return left == right;
  return *left == *right;
}

const Json* member(const Json* object, const std::string& key) {
  if (object == nullptr || !object->is_object()) return nullptr;
  const auto found = object->find(key);
  return found == object->end() ? nullptr : &*found;
}

// A list whose entries are named by `id`: the stack, a group's children, a mask's
// components. Those merge entry by entry; any other list is one value.
bool keyed(const Json& value) {
  return value.is_array() && std::all_of(value.begin(), value.end(), [](const Json& entry) {
           return entry.is_object() && entry.contains("id") && entry["id"].is_string();
         });
}

std::map<std::string, const Json*> by_id(const Json* list) {
  std::map<std::string, const Json*> entries;
  if (list == nullptr || !keyed(*list)) return entries;
  for (const Json& entry : *list) {
    entries[entry["id"].get<std::string>()] = &entry;
  }
  return entries;
}

const Json* entry_of(const std::map<std::string, const Json*>& entries, const std::string& id) {
  const auto found = entries.find(id);
  return found == entries.end() ? nullptr : found->second;
}

std::optional<Json> merge_value(const Json* base, const Json* ours, const Json* theirs);

Json merge_object(const Json* base, const Json& ours, const Json& theirs) {
  Json merged = Json::object();
  std::vector<std::string> keys;
  for (const Json* side : {base, &ours, &theirs}) {
    if (side == nullptr || !side->is_object()) continue;
    for (const auto& [key, value] : side->items()) {
      keys.push_back(key);
    }
  }
  for (const std::string& key : keys) {
    if (merged.contains(key)) continue;
    std::optional<Json> value =
        merge_value(member(base, key), member(&ours, key), member(&theirs, key));
    if (value.has_value()) merged[key] = std::move(*value);
  }
  return merged;
}

// Our order, with what only their side added after it.
Json merge_keyed(const Json* base, const Json& ours, const Json& theirs) {
  const auto base_entries = by_id(base);
  const auto our_entries = by_id(&ours);
  const auto their_entries = by_id(&theirs);
  Json merged = Json::array();
  for (const Json& entry : ours) {
    const std::string id = entry["id"].get<std::string>();
    std::optional<Json> value =
        merge_value(entry_of(base_entries, id), &entry, entry_of(their_entries, id));
    if (value.has_value()) merged.push_back(std::move(*value));
  }
  for (const Json& entry : theirs) {
    const std::string id = entry["id"].get<std::string>();
    if (our_entries.contains(id)) continue;
    std::optional<Json> value = merge_value(entry_of(base_entries, id), nullptr, &entry);
    if (value.has_value()) merged.push_back(std::move(*value));
  }
  return merged;
}

// std::nullopt is "absent": a key or an entry the merged side does not have.
std::optional<Json> merge_value(const Json* base, const Json* ours, const Json* theirs) {
  const auto present = [](const Json* value) -> std::optional<Json> {
    if (value == nullptr) return std::nullopt;
    return std::optional<Json>(std::in_place, *value);
  };
  if (same(theirs, base)) return present(ours);
  if (same(ours, base) || same(ours, theirs)) return present(theirs);
  // Both sides moved it, differently. Containers merge inside; a plain value is theirs.
  if (ours == nullptr || theirs == nullptr) return present(theirs);
  if (ours->is_object() && theirs->is_object()) return merge_object(base, *ours, *theirs);
  if (keyed(*ours) && keyed(*theirs)) return merge_keyed(base, *ours, *theirs);
  return present(theirs);
}

}  // namespace

Stack merge_stacks(const Stack& base, const Stack& ours, const Stack& theirs) {
  const Json base_json = stack_to_json(base);
  const Json our_json = stack_to_json(ours);
  const Json their_json = stack_to_json(theirs);
  const std::optional<Json> merged = merge_value(&base_json, &our_json, &their_json);
  return stack_from_json(merged.value_or(Json::array()));
}

nlohmann::json history_to_json(const History& history, size_t max_steps) {
  const std::vector<HistoryNode>& nodes = history.nodes();
  std::vector<bool> kept(nodes.size(), false);
  size_t count = 0;
  // The line the photo came down to reach the step on screen, newest first; the oldest
  // step kept on it becomes the root.
  for (std::optional<size_t> id = history.cursor(); id.has_value() && count < max_steps;
       id = nodes[*id].parent) {
    kept[*id] = true;
    ++count;
  }
  // Then the newest branches off it, each only whole back to where it leaves a kept step.
  for (size_t tip = nodes.size(); tip-- > 0;) {
    std::vector<size_t> path;
    std::optional<size_t> id = tip;
    while (id.has_value() && !kept[*id]) {
      path.push_back(*id);
      id = nodes[*id].parent;
    }
    if (!id.has_value() || count + path.size() > max_steps) continue;
    for (const size_t step : path)
      kept[step] = true;
    count += path.size();
  }

  std::vector<size_t> renumbered(nodes.size(), 0);
  size_t next = 0;
  nlohmann::json steps = nlohmann::json::array();
  for (size_t id = 0; id < nodes.size(); ++id) {
    if (!kept[id]) continue;
    renumbered[id] = next++;
    const HistoryNode& node = nodes[id];
    nlohmann::json step = {{"label", node.label}, {"stack", stack_to_json(node.stack)}};
    if (node.parent.has_value() && kept[*node.parent]) step["parent"] = renumbered[*node.parent];
    if (node.merged_from.has_value() && kept[*node.merged_from]) {
      step["mergedFrom"] = renumbered[*node.merged_from];
    }
    steps.push_back(std::move(step));
  }
  return {{"cursor", renumbered[history.cursor()]}, {"steps", std::move(steps)}};
}

namespace {

// A step id the node at `index` may point at: an earlier step.
std::optional<size_t> earlier_step(const nlohmann::json& step, const char* key, size_t index) {
  const auto found = step.find(key);
  if (found == step.end() || !found->is_number_unsigned()) return std::nullopt;
  const auto id = found->get<size_t>();
  if (id >= index) return std::nullopt;
  return id;
}

}  // namespace

std::optional<History> history_from_json(const nlohmann::json& value) {
  if (!value.is_object()) return std::nullopt;
  const auto steps = value.find("steps");
  const auto cursor = value.find("cursor");
  if (steps == value.end() || !steps->is_array() || steps->empty()) return std::nullopt;
  if (cursor == value.end() || !cursor->is_number_unsigned()) return std::nullopt;
  if (cursor->get<size_t>() >= steps->size()) return std::nullopt;
  std::vector<HistoryNode> nodes;
  for (const nlohmann::json& step : *steps) {
    if (!step.is_object()) return std::nullopt;
    const size_t index = nodes.size();
    HistoryNode node{stack_from_json(step.value("stack", nlohmann::json::array())),
                     step.value("label", std::string()),
                     {},
                     earlier_step(step, "mergedFrom", index),
                     {}};
    if (index > 0) {
      if (step.contains("parent") && !earlier_step(step, "parent", index)) return std::nullopt;
      node.parent = earlier_step(step, "parent", index).value_or(index - 1);
    }
    nodes.push_back(std::move(node));
  }
  return History(std::move(nodes), cursor->get<size_t>());
}

}  // namespace latent
