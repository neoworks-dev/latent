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

TEST_CASE("undo and redo walk the cursor, redo truncates on the next commit") {
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
  REQUIRE(history.size() == 3);
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
