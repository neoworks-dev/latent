// History is snapshots, not pops (PROMPT.md 3.2): the agent edits mid-stack, so undo
// moves a cursor over whole stack values.
#pragma once

#include "ops/op.h"

#include <cstddef>
#include <cstdint>

#include <optional>
#include <string>
#include <vector>

namespace latent {

class History {
 public:
  explicit History(Stack initial = {});

  const Stack& current() const { return snapshots_[cursor_]; }

  // A committed mutation: drops the redo tail and appends a snapshot. `label` is what the
  // caller wants the step called ("Golden hour applied"); empty leaves it to be described
  // by what changed.
  void commit(Stack next, std::string label = {});

  // A slider drag: replaces the current snapshot in place, so a drag of 200 ticks costs
  // one snapshot. The base state is kept aside and restored under the next commit, so
  // undo after a drag lands on the value the drag started from, not a value mid-drag.
  void commit_transient(Stack next);

  bool undo();
  bool redo();
  // Straight to one snapshot: what clicking a row of the history list does. A drag in
  // flight is finished first, exactly as undo does, so the jump starts from a committed
  // state. Out of range is false and no move.
  bool jump(size_t index);
  bool can_undo() const { return cursor_ > 0 || transient_base_.has_value(); }
  bool can_redo() const { return cursor_ + 1 < snapshots_.size(); }

  // Increments on every mutation, including transient ones and cursor moves.
  uint64_t revision() const { return revision_; }
  // Every committed state, oldest first. The server describes consecutive pairs of these
  // for `history.list`; nothing may mutate them through this.
  const std::vector<Stack>& snapshots() const { return snapshots_; }
  // One per snapshot, same order; empty where the caller named nothing.
  const std::vector<std::string>& labels() const { return labels_; }
  size_t size() const { return snapshots_.size(); }
  size_t cursor() const { return cursor_; }

 private:
  void finish_transient();

  std::vector<Stack> snapshots_;
  std::vector<std::string> labels_;
  size_t cursor_ = 0;
  uint64_t revision_ = 0;
  std::optional<Stack> transient_base_;
};

}  // namespace latent
