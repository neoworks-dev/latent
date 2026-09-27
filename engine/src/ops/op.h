// The op-stack: the only edit state in Latent. Pure data, no GPU, no I/O.
#pragma once

#include <functional>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace latent {

// Thrown for anything a caller got wrong: unknown op, bad type, malformed stack.
// The server maps it to JSON-RPC -32602.
class OpError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

// The reserved op name of a group: one mask, one opacity, and the adjustments that share
// them (PROMPT.md 3.7). It is not in the registry — nothing about it is a param and
// ops.describe never lists it — so every place that resolves a definition tests this first.
inline constexpr std::string_view kGroupOpName = "group";

// One entry of the stack, matching protocol/messages.schema.json#/definitions/Op.
// `mask` is the canonical MaskComponent list (ops/mask.h); `opacity` is the layer opacity
// 0..100, and 100 is absent on the wire and in the sidecar.
struct Op {
  std::string id;
  std::string name;
  nlohmann::json params = nlohmann::json::object();
  std::optional<nlohmann::json> mask;
  double opacity = 100;
  bool enabled = true;
  // Groups only: the adjustments under this group's mask, in the user's order. They render
  // as one branch off the group's input and are blended back through the mask once, which
  // is what makes a mask a layer rather than a per-slider argument. A child carries
  // `enabled` and nothing else of its own: `mask` and `opacity` belong to the group, and a
  // group is never a child of a group (one level, validated in op_from_json).
  std::vector<Op> ops;

  bool is_group() const { return name == kGroupOpName; }
  // Generative ops only (PROMPT.md 3.5). A generated raster cannot be recomputed from its
  // parameters, so the op carries the pixels it produced and a hash of what produced them:
  // `result` is a PNG path relative to raster_dir_for, `result_rect` is the crop's
  // [x0, y0, x1, y1] normalised over the content rect, and `input_hash` is what
  // generative_input_hash() returned when the job ran. All three are empty on every other
  // op, and none of them is a param — a param is something the user sets.
  std::string result;
  std::string input_hash;
  std::vector<double> result_rect;
};

inline constexpr double kFullOpacity = 100.0;

using Stack = std::vector<Op>;

// 8 hex characters, unique enough for one photo's stack and short enough to read.
std::string make_op_id();

nlohmann::json op_to_json(const Op& op);
Op op_from_json(const nlohmann::json& value);
nlohmann::json stack_to_json(const Stack& stack);
Stack stack_from_json(const nlohmann::json& value);

// Both search the group children too: an id is unique across the whole photo's stack, so
// every message that names an `opId` reaches a child without knowing it is one.
const Op* find_op(const Stack& stack, std::string_view id);
Op* find_op(Stack& stack, std::string_view id);

// The group holding `id`, or nullptr when `id` is a top-level entry or unknown.
const Op* find_parent_group(const Stack& stack, std::string_view id);
Op* find_parent_group(Stack& stack, std::string_view id);

// Every op in the stack, groups before their children, in stack order. What a caller wants
// when it needs to touch all the ops and does not care which are nested — the sidecar's
// stroke mirroring, the catalog's hash, migrations.
void for_each_op(Stack& stack, const std::function<void(Op&)>& visit);
void for_each_op(const Stack& stack, const std::function<void(const Op&)>& visit);

}  // namespace latent
