// History is snapshots, not pops (PROMPT.md 3.2): the agent edits mid-stack, so undo
// moves a cursor over whole stack values.
#pragma once

#include "ops/op.h"

#include <cstddef>
#include <cstdint>

#include <optional>
#include <vector>

namespace latent {

class History {
 public:
  explicit History(Stack initial = {});

  const Stack& current() const { return snapshots_[cursor_]; }

  // A committed mutation: drops the redo tail and appends a snapshot.
  void commit(Stack next);

  // A slider drag: replaces the current snapshot in place, so a drag of 200 ticks costs
  // one snapshot. The base state is kept aside and restored under the next commit, so
  // undo after a drag lands on the value the drag started from, not a value mid-drag.
  void commit_transient(Stack next);

  bool undo();
  bool redo();
  bool can_undo() const { return cursor_ > 0 || transient_base_.has_value(); }
  bool can_redo() const { return cursor_ + 1 < snapshots_.size(); }

  // Increments on every mutation, including transient ones and cursor moves.
  uint64_t revision() const { return revision_; }
  size_t size() const { return snapshots_.size(); }
  size_t cursor() const { return cursor_; }

 private:
  void finish_transient();

  std::vector<Stack> snapshots_;
  size_t cursor_ = 0;
  uint64_t revision_ = 0;
  std::optional<Stack> transient_base_;
};

}  // namespace latent
