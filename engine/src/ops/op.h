// The op-stack: the only edit state in Latent. Pure data, no GPU, no I/O.
#pragma once

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
  // Generative ops only (PROMPT.md 3.5). A generated raster cannot be recomputed from its
  // parameters, so the op carries the pixels it produced and a hash of what produced them:
  // `result` is a PNG path relative to `<photo>.latent.d/`, `result_rect` is the crop's
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

const Op* find_op(const Stack& stack, std::string_view id);
Op* find_op(Stack& stack, std::string_view id);

}  // namespace latent
