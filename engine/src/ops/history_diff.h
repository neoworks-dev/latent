// What one undo step changed, for `history.list`. Values are the parameters' own — the UI
// formats them with the spec `ops.describe` gave the control, so no unit, no rounding and
// no label lives here.
#pragma once

#include "ops/op.h"

#include <cstddef>

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace latent {

// One parameter this step moved. `from`/`to` are null when the value is not a scalar (a
// curve's point list): a row cannot show a list of points, only that it changed.
struct ParamChange {
  std::string param;
  nlohmann::json from;
  nlohmann::json to;
};

// One snapshot, described by its difference from the one before it. `op` and `op_id` are
// empty for the photo's opening state, for a pure reorder and for a batch, which are about
// the stack rather than about one entry.
struct HistoryStep {
  std::string kind;  // initial | add | remove | update | mask | reorder | batch
  std::string op;
  std::string op_id;
  std::vector<ParamChange> changes;
  // `batch` only: one of these per op the commit touched, each described as a step of its
  // own. Empty on every other kind, and never nested further than one level.
  std::vector<HistoryStep> entries;
  // What the caller called the step (`stack.set`'s `label`), for the steps that carry one.
  std::string label;
};

// The step from `before` to `after`. A commit that touched one op is described in full; one
// that touched several is a `batch` listing them, because naming a preset's dozen ops after
// whichever of them sorts first would be a lie — and because a UI that can see them one by
// one can put one of them back on its own.
HistoryStep describe_step(const Stack& before, const Stack& after);

// One step per snapshot, oldest first; `steps[0]` is the opening state. `labels` is
// History::labels(), one per snapshot; a short list simply names fewer steps.
std::vector<HistoryStep> describe_history(const std::vector<Stack>& snapshots,
                                          const std::vector<std::string>& labels = {});

nlohmann::json history_step_to_json(const HistoryStep& step, size_t index);

}  // namespace latent
