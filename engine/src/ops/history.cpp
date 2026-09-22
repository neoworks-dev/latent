#include "ops/history.h"

#include <utility>

namespace latent {

History::History(Stack initial) {
  snapshots_.push_back(std::move(initial));
  labels_.emplace_back();
}

void History::commit(Stack next, std::string label) {
  snapshots_.resize(cursor_ + 1);
  labels_.resize(cursor_ + 1);
  finish_transient();
  snapshots_.push_back(std::move(next));
  labels_.push_back(std::move(label));
  cursor_ = snapshots_.size() - 1;
  ++revision_;
}

// A drag replaces the snapshot under the cursor rather than appending one, so the label at
// that index still belongs to the step that made it and is left alone.
void History::commit_transient(Stack next) {
  snapshots_.resize(cursor_ + 1);
  labels_.resize(cursor_ + 1);
  if (!transient_base_.has_value()) transient_base_ = snapshots_[cursor_];
  snapshots_[cursor_] = std::move(next);
  ++revision_;
}

bool History::undo() {
  if (!can_undo()) return false;
  const bool discarded_drag = transient_base_.has_value();
  finish_transient();
  ++revision_;
  if (discarded_drag) return true;
  --cursor_;
  return true;
}

bool History::redo() {
  finish_transient();
  if (!can_redo()) return false;
  ++cursor_;
  ++revision_;
  return true;
}

bool History::jump(size_t index) {
  if (index >= snapshots_.size()) return false;
  // A drag in flight is rolled back first, as undo does; jumping to the step the cursor
  // is already on is then still a change, because that rollback was one.
  const bool discarded_drag = transient_base_.has_value();
  finish_transient();
  if (index == cursor_ && !discarded_drag) return false;
  cursor_ = index;
  ++revision_;
  return true;
}

void History::finish_transient() {
  if (!transient_base_.has_value()) return;
  snapshots_[cursor_] = std::move(*transient_base_);
  transient_base_.reset();
}

}  // namespace latent
