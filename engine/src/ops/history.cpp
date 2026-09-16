#include "ops/history.h"

#include <utility>

namespace latent {

History::History(Stack initial) {
  snapshots_.push_back(std::move(initial));
}

void History::commit(Stack next) {
  snapshots_.resize(cursor_ + 1);
  finish_transient();
  snapshots_.push_back(std::move(next));
  cursor_ = snapshots_.size() - 1;
  ++revision_;
}

void History::commit_transient(Stack next) {
  snapshots_.resize(cursor_ + 1);
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

void History::finish_transient() {
  if (!transient_base_.has_value()) return;
  snapshots_[cursor_] = std::move(*transient_base_);
  transient_base_.reset();
}

}  // namespace latent
