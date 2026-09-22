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
  // A group always carries its list, empty included: a mask with nothing under it yet is a
  // layer the user is still building, not a group that lost its children.
  if (op.is_group()) value["ops"] = stack_to_json(op.ops);
  if (op.mask.has_value()) value["mask"] = *op.mask;
  // Absent means 100 (protocol Op.opacity), so a stack nobody has touched stays terse.
  if (op.opacity != kFullOpacity) value["opacity"] = op.opacity;
  // Generative bookkeeping: present only on an op that has actually produced pixels.
  if (!op.result.empty()) value["result"] = op.result;
  if (!op.input_hash.empty()) value["inputHash"] = op.input_hash;
  if (op.result_rect.size() == 4) value["resultRect"] = op.result_rect;
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
  if (value.contains("result") && !value["result"].is_null()) {
    if (!value["result"].is_string()) throw OpError("op.result must be a string");
    op.result = value["result"].get<std::string>();
  }
  if (value.contains("inputHash") && !value["inputHash"].is_null()) {
    if (!value["inputHash"].is_string()) throw OpError("op.inputHash must be a string");
    op.input_hash = value["inputHash"].get<std::string>();
  }
  if (value.contains("ops") && !value["ops"].is_null()) {
    if (!op.is_group()) throw OpError("only a group op holds nested ops");
    if (!value["ops"].is_array()) throw OpError("op.ops must be an array");
    for (const nlohmann::json& child : value["ops"]) {
      Op nested = op_from_json(child);
      // One level. A group inside a group would have two masks over the same pixels and no
      // answer for which one the blend below belongs to.
      if (nested.is_group()) throw OpError("a group cannot hold another group");
      op.ops.push_back(std::move(nested));
    }
  }
  if (value.contains("resultRect") && !value["resultRect"].is_null()) {
    const nlohmann::json& rect = value["resultRect"];
    if (!rect.is_array() || rect.size() != 4) {
      throw OpError("op.resultRect must be [x0, y0, x1, y1]");
    }
    for (const nlohmann::json& edge : rect) {
      if (!edge.is_number()) throw OpError("op.resultRect must hold numbers");
      op.result_rect.push_back(edge.get<double>());
    }
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
    if (const Op* child = find_op(op.ops, id); child != nullptr) return child;
  }
  return nullptr;
}

Op* find_op(Stack& stack, std::string_view id) {
  for (Op& op : stack) {
    if (op.id == id) return &op;
    if (Op* child = find_op(op.ops, id); child != nullptr) return child;
  }
  return nullptr;
}

const Op* find_parent_group(const Stack& stack, std::string_view id) {
  for (const Op& op : stack) {
    if (find_op(op.ops, id) != nullptr) return &op;
  }
  return nullptr;
}

Op* find_parent_group(Stack& stack, std::string_view id) {
  for (Op& op : stack) {
    if (find_op(op.ops, id) != nullptr) return &op;
  }
  return nullptr;
}

void for_each_op(Stack& stack, const std::function<void(Op&)>& visit) {
  for (Op& op : stack) {
    visit(op);
    for_each_op(op.ops, visit);
  }
}

void for_each_op(const Stack& stack, const std::function<void(const Op&)>& visit) {
  for (const Op& op : stack) {
    visit(op);
    for_each_op(op.ops, visit);
  }
}

}  // namespace latent
