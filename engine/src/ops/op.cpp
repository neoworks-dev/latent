#include "ops/op.h"

#include <random>

namespace latent {

namespace {

std::mt19937_64& id_engine() {
  static std::mt19937_64 engine{std::random_device{}()};
  return engine;
}

}  // namespace

std::string make_op_id() {
  static constexpr std::string_view kDigits = "0123456789abcdef";
  std::uniform_int_distribution<int> digit(0, 15);
  std::string id(8, '0');
  for (char& character : id) {
    character = kDigits[static_cast<size_t>(digit(id_engine()))];
  }
  return id;
}

nlohmann::json op_to_json(const Op& op) {
  nlohmann::json value = {
      {"id", op.id}, {"op", op.name}, {"params", op.params}, {"enabled", op.enabled}};
  if (op.mask.has_value()) value["mask"] = *op.mask;
  // Absent means 100 (protocol Op.opacity), so a stack nobody has touched stays terse.
  if (op.opacity != kFullOpacity) value["opacity"] = op.opacity;
  return value;
}

Op op_from_json(const nlohmann::json& value) {
  if (!value.is_object()) throw OpError("op must be an object");
  Op op;
  if (value.contains("id")) {
    if (!value["id"].is_string()) throw OpError("op.id must be a string");
    op.id = value["id"].get<std::string>();
  }
  if (op.id.empty()) op.id = make_op_id();
  if (!value.contains("op") || !value["op"].is_string()) throw OpError("op.op must be a string");
  op.name = value["op"].get<std::string>();
  if (value.contains("params")) {
    if (!value["params"].is_object()) throw OpError("op.params must be an object");
    op.params = value["params"];
  }
  if (value.contains("mask") && !value["mask"].is_null()) {
    if (!value["mask"].is_object()) throw OpError("op.mask must be an object");
    op.mask = value["mask"];
  }
  if (value.contains("opacity") && !value["opacity"].is_null()) {
    if (!value["opacity"].is_number()) throw OpError("op.opacity must be a number");
    const double opacity = value["opacity"].get<double>();
    if (!(opacity >= 0 && opacity <= kFullOpacity)) {
      throw OpError("op.opacity must be between 0 and 100");
    }
    op.opacity = opacity;
  }
  if (value.contains("enabled")) {
    if (!value["enabled"].is_boolean()) throw OpError("op.enabled must be a boolean");
    op.enabled = value["enabled"].get<bool>();
  }
  return op;
}

nlohmann::json stack_to_json(const Stack& stack) {
  nlohmann::json value = nlohmann::json::array();
  for (const Op& op : stack) {
    value.push_back(op_to_json(op));
  }
  return value;
}

Stack stack_from_json(const nlohmann::json& value) {
  if (!value.is_array()) throw OpError("stack must be an array");
  Stack stack;
  stack.reserve(value.size());
  for (const nlohmann::json& entry : value) {
    stack.push_back(op_from_json(entry));
  }
  return stack;
}

const Op* find_op(const Stack& stack, std::string_view id) {
  for (const Op& op : stack) {
    if (op.id == id) return &op;
  }
  return nullptr;
}

Op* find_op(Stack& stack, std::string_view id) {
  for (Op& op : stack) {
    if (op.id == id) return &op;
  }
  return nullptr;
}

}  // namespace latent
