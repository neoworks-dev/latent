#include "ops/history.h"
#include "ops/op.h"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using namespace latent;

namespace {

Op make_op(std::string id, std::string name, double value) {
  Op op;
  op.id = std::move(id);
  op.name = std::move(name);
  op.params = {{"value", value}};
  return op;
}

}  // namespace

TEST_CASE("op ids are 8 hex characters and do not repeat") {
  const std::string first = make_op_id();
  REQUIRE(first.size() == 8);
  REQUIRE(first.find_first_not_of("0123456789abcdef") == std::string::npos);
  REQUIRE(first != make_op_id());
}

TEST_CASE("stack survives a JSON round trip") {
  Stack stack;
  stack.push_back(make_op("aabbccdd", "exposure", 1.5));
  stack.push_back(make_op("11223344", "contrast", -20));
  stack[1].enabled = false;
  stack[1].mask = nlohmann::json{{"kind", "radial"}};

  const nlohmann::json encoded = stack_to_json(stack);
  REQUIRE(encoded.size() == 2);
  REQUIRE(encoded[0]["op"] == "exposure");
  REQUIRE(encoded[0]["params"]["value"] == 1.5);
  REQUIRE(encoded[0]["enabled"] == true);
  REQUIRE(!encoded[0].contains("mask"));
  REQUIRE(encoded[1]["mask"]["kind"] == "radial");

  const Stack decoded = stack_from_json(encoded);
  REQUIRE(decoded.size() == 2);
  REQUIRE(decoded[0].id == "aabbccdd");
  REQUIRE(decoded[1].enabled == false);
  REQUIRE(decoded[1].mask.has_value());
  REQUIRE(stack_to_json(decoded) == encoded);
}

TEST_CASE("malformed stacks are rejected, missing ids are filled in") {
  REQUIRE_THROWS_AS(stack_from_json(nlohmann::json{{"op", "exposure"}}), OpError);
  REQUIRE_THROWS_AS(stack_from_json(nlohmann::json::array({nlohmann::json::object()})), OpError);
  REQUIRE_THROWS_AS(stack_from_json(nlohmann::json::array({{{"op", "exposure"}, {"params", 3}}})),
                    OpError);

  const Stack filled = stack_from_json(nlohmann::json::array({{{"op", "exposure"}}}));
  REQUIRE(filled.size() == 1);
  REQUIRE(filled[0].id.size() == 8);
  REQUIRE(filled[0].enabled == true);
}

TEST_CASE("find_op matches by id") {
  Stack stack;
  stack.push_back(make_op("deadbeef", "exposure", 1));
  REQUIRE(find_op(stack, "deadbeef") != nullptr);
  REQUIRE(find_op(stack, "nope") == nullptr);
}

TEST_CASE("a group carries its children through a JSON round trip") {
  Op group;
  group.id = "g0000001";
  group.name = std::string(kGroupOpName);
  group.mask = nlohmann::json{{"components", nlohmann::json::array()}};
  group.opacity = 60;
  group.ops.push_back(make_op("child001", "exposure", 1.5));
  group.ops.push_back(make_op("child002", "clarity", 20));
  Stack stack;
  stack.push_back(std::move(group));

  const nlohmann::json encoded = stack_to_json(stack);
  REQUIRE(encoded[0]["op"] == kGroupOpName);
  REQUIRE(encoded[0]["ops"].size() == 2);
  REQUIRE(encoded[0]["ops"][1]["op"] == "clarity");
  REQUIRE(encoded[0]["opacity"] == 60);

  const Stack decoded = stack_from_json(encoded);
  REQUIRE(decoded[0].is_group());
  REQUIRE(decoded[0].ops.size() == 2);
  REQUIRE(stack_to_json(decoded) == encoded);

  // An empty group is a layer whose mask has nothing under it yet, not a group that lost
  // its children: the list goes out either way.
  Op empty;
  empty.id = "g0000002";
  empty.name = std::string(kGroupOpName);
  REQUIRE(op_to_json(empty)["ops"].empty());
}

TEST_CASE("groups are one level deep, and their children are reachable by id") {
  const nlohmann::json nested =
      nlohmann::json::array({{{"id", "g1"},
                              {"op", "group"},
                              {"ops", nlohmann::json::array({{{"id", "g2"}, {"op", "group"}}})}}});
  REQUIRE_THROWS_AS(stack_from_json(nested), OpError);
  // Only a group holds children.
  REQUIRE_THROWS_AS(stack_from_json(nlohmann::json::array(
                        {{{"id", "e1"}, {"op", "exposure"}, {"ops", nlohmann::json::array()}}})),
                    OpError);

  Stack stack;
  Op group;
  group.id = "g0000001";
  group.name = std::string(kGroupOpName);
  group.ops.push_back(make_op("child001", "exposure", 1));
  stack.push_back(std::move(group));
  stack.push_back(make_op("top00001", "contrast", 10));

  // An id is unique across the whole stack, so every message that names one reaches a
  // child without knowing it is one.
  REQUIRE(find_op(stack, "child001") != nullptr);
  REQUIRE(find_parent_group(stack, "child001") != nullptr);
  REQUIRE(find_parent_group(stack, "child001")->id == "g0000001");
  REQUIRE(find_parent_group(stack, "top00001") == nullptr);
  REQUIRE(find_parent_group(stack, "g0000001") == nullptr);

  std::vector<std::string> visited;
  for_each_op(stack, [&](const Op& op) { visited.push_back(op.id); });
  REQUIRE(visited == std::vector<std::string>{"g0000001", "child001", "top00001"});
}

TEST_CASE("history appends a snapshot per commit") {
  History history;
  REQUIRE(history.size() == 1);
  REQUIRE(!history.can_undo());
  REQUIRE(!history.can_redo());
  REQUIRE(history.current().empty());

  Stack one;
  one.push_back(make_op("a1", "exposure", 1));
  history.commit(one);
  REQUIRE(history.size() == 2);
  REQUIRE(history.can_undo());
  REQUIRE(history.revision() == 1);
  REQUIRE(history.current().size() == 1);
}

TEST_CASE("undo and redo walk the cursor, the next commit branches off") {
  History history;
  Stack one;
  one.push_back(make_op("a1", "exposure", 1));
  Stack two = one;
  two.push_back(make_op("a2", "contrast", 30));
  history.commit(one);
  history.commit(two);
  REQUIRE(history.current().size() == 2);

  REQUIRE(history.undo());
  REQUIRE(history.current().size() == 1);
  REQUIRE(history.can_redo());
  REQUIRE(history.undo());
  REQUIRE(history.current().empty());
  REQUIRE(!history.undo());

  REQUIRE(history.redo());
  REQUIRE(history.current().size() == 1);

  Stack other;
  other.push_back(make_op("b1", "shadows", -10));
  history.commit(other);
  REQUIRE(!history.can_redo());
  REQUIRE(history.size() == 4);
  REQUIRE(history.current()[0].id == "b1");
}

TEST_CASE("a drag replaces the current snapshot instead of appending") {
  History history;
  Stack base;
  base.push_back(make_op("a1", "exposure", 0));
  history.commit(base);
  const size_t before = history.size();

  for (double value : {0.2, 0.4, 0.6}) {
    Stack dragged = history.current();
    dragged[0].params["value"] = value;
    history.commit_transient(dragged);
    REQUIRE(history.size() == before);
  }
  REQUIRE(history.current()[0].params["value"] == 0.6);

  // Mouse up: one snapshot for the whole drag...
  Stack settled = history.current();
  settled[0].params["value"] = 0.7;
  history.commit(settled);
  REQUIRE(history.size() == before + 1);

  // ...and undo lands on the value the drag started from, not a value mid-drag.
  REQUIRE(history.undo());
  REQUIRE(history.current()[0].params["value"] == 0.0);
}

TEST_CASE("undo during a drag discards it") {
  History history;
  Stack base;
  base.push_back(make_op("a1", "exposure", 0));
  history.commit(base);

  Stack dragged = history.current();
  dragged[0].params["value"] = 2.0;
  history.commit_transient(dragged);
  REQUIRE(history.undo());
  REQUIRE(history.current()[0].params["value"] == 0.0);
  REQUIRE(history.size() == 2);
}
