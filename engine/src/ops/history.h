// History is snapshots, not pops (PROMPT.md 3.2): the agent edits mid-stack, so undo
// moves a cursor over whole stack values. The snapshots form a tree: a commit made after
// an undo starts a branch beside the steps it would once have dropped, and a merge joins
// two branches back into one step with both as parents.
#pragma once

#include "ops/op.h"

#include <cstddef>
#include <cstdint>

#include <optional>
#include <string>
#include <vector>

namespace latent {

// One committed state. A node's id is its index in History::nodes(), and ids only grow, so
// a parent always has a lower id than its children.
struct HistoryNode {
  Stack stack;
  // What the caller wanted the step called ("Golden hour applied"); empty leaves it to be
  // described by what changed.
  std::string label;
  // The step this one was made from; absent on the root only.
  std::optional<size_t> parent;
  // A merge only: the branch step merged into `parent`.
  std::optional<size_t> merged_from;
  // The child redo goes to: the one last committed from here or last undone out of.
  std::optional<size_t> redo_child;
};

class History {
 public:
  explicit History(Stack initial = {});
  // A history read back from disk; `history_from_json` checks every id before it gets here.
  History(std::vector<HistoryNode> nodes, size_t cursor);

  const Stack& current() const { return nodes_[cursor_].stack; }

  // A committed mutation: a new child of the step under the cursor. Steps already made from
  // there stay, as a branch beside it.
  void commit(Stack next, std::string label = {});

  // Joins step `from` into the current one: `next` is the merged stack, committed as a child
  // of the cursor with `from` as its second parent. Recorded even when it changes nothing,
  // because the graph showing the two branches joined is the point. False and no move when
  // `from` is out of range, is the cursor, or is already behind it.
  bool merge(size_t from, Stack next, std::string label = {});

  // A slider drag: replaces the current snapshot in place, so a drag of 200 ticks costs
  // one snapshot. The base state is kept aside and restored under the next commit, so
  // undo after a drag lands on the value the drag started from, not a value mid-drag.
  void commit_transient(Stack next);

  // Undo walks to the parent, redo back down to the child last left.
  bool undo();
  bool redo();
  // Straight to one step: what clicking a row of the history list does. A drag in flight
  // is finished first, exactly as undo does, so the jump starts from a committed state.
  // Out of range is false and no move.
  bool jump(size_t id);
  bool can_undo() const {
    return nodes_[cursor_].parent.has_value() || transient_base_.has_value();
  }
  bool can_redo() const { return redo_target().has_value(); }

  // The step both `a` and `b` descend from, following merge parents too; the newest one
  // when there are several. Every node descends from the root, so there always is one.
  size_t common_ancestor(size_t a, size_t b) const;
  // Whether `ancestor` is `id` or one of the steps it descends from.
  bool descends_from(size_t id, size_t ancestor) const;

  // Increments on every mutation, including transient ones and cursor moves.
  uint64_t revision() const { return revision_; }
  // Every step, oldest first. The server describes each against its parent for
  // `history.list`; nothing may mutate them through this.
  const std::vector<HistoryNode>& nodes() const { return nodes_; }
  size_t size() const { return nodes_.size(); }
  size_t cursor() const { return cursor_; }

 private:
  void finish_transient();
  void append(HistoryNode node);
  std::optional<size_t> redo_target() const;
  std::vector<bool> ancestors_of(size_t id) const;

  std::vector<HistoryNode> nodes_;
  size_t cursor_ = 0;
  uint64_t revision_ = 0;
  std::optional<Stack> transient_base_;
};

// Three-way merge of two stacks that grew apart from `base`: whatever only one side changed
// is taken from it, and where both changed the same value `theirs` wins. Ops, group
// children and mask components are matched by id, and every object is merged key by key,
// so two branches that moved different sliders of one op keep both.
Stack merge_stacks(const Stack& base, const Stack& ours, const Stack& theirs);

// The history's on-disk form: `{"cursor": n, "steps": [{"label", "stack", "parent",
// "mergedFrom"}]}`, ids renumbered to the steps kept. At most `max_steps` of them: the
// cursor's own line back from it first, then the newest branches that still fit whole.
// Only called after a commit or a cursor move, both of which finish a drag, so no snapshot
// here is a value mid-drag.
nlohmann::json history_to_json(const History& history, size_t max_steps);
// std::nullopt when the value is not a history this engine wrote. Throws OpError when a
// step's stack is malformed, like `stack_from_json`. A step without `parent` hangs off the
// one before it, which is how a linear history from an older build reads.
std::optional<History> history_from_json(const nlohmann::json& value);

}  // namespace latent
