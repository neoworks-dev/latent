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
struct Op {
  std::string id;
  std::string name;
  nlohmann::json params = nlohmann::json::object();
  std::optional<nlohmann::json> mask;
  bool enabled = true;
};

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
