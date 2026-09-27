#include "ops/history.h"

#include "ops/history_diff.h"
#include "ops/op.h"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using namespace latent;

namespace {

Op make_op(std::string id, std::string name, nlohmann::json params) {
  Op op;
  op.id = std::move(id);
  op.name = std::move(name);
  op.params = std::move(params);
  return op;
}

}  // namespace

TEST_CASE("a step that moves a slider says which parameter and where it went") {
  const Stack before{make_op("aabbccdd", "exposure", {{"value", 0.0}})};
  const Stack after{make_op("aabbccdd", "exposure", {{"value", 0.7}})};

  const HistoryStep step = describe_step(before, after);
  REQUIRE(step.kind == "update");
  REQUIRE(step.op == "exposure");
  REQUIRE(step.op_id == "aabbccdd");
  REQUIRE(step.changes.size() == 1);
  REQUIRE(step.changes[0].param == "value");
  REQUIRE(step.changes[0].from == 0.0);
  REQUIRE(step.changes[0].to == 0.7);
}

TEST_CASE("an op arriving or leaving is the step, not whatever else moved with it") {
  const Stack empty;
  const Stack one{make_op("aabbccdd", "clarity", {{"amount", 20}})};

  const HistoryStep added = describe_step(empty, one);
  REQUIRE(added.kind == "add");
  REQUIRE(added.op == "clarity");
  // Its values ride along as changes from nothing, so the row can say where it went.
  REQUIRE(added.changes.size() == 1);
  CHECK(added.changes[0].param == "amount");
  CHECK(added.changes[0].from.is_null());
  CHECK(added.changes[0].to == 20);

  const HistoryStep removed = describe_step(one, empty);
  REQUIRE(removed.kind == "remove");
  REQUIRE(removed.op == "clarity");
  REQUIRE(removed.changes.size() == 1);
  CHECK(removed.changes[0].from == 20);
  CHECK(removed.changes[0].to.is_null());
}

TEST_CASE("the eye, the opacity and the mask each read as themselves") {
  Stack before{make_op("aabbccdd", "exposure", {{"value", 0.5}})};
  Stack after = before;
  after[0].enabled = false;
  REQUIRE(describe_step(before, after).changes[0].param == "enabled");

  after = before;
  after[0].opacity = 40;
  const HistoryStep faded = describe_step(before, after);
  REQUIRE(faded.changes[0].param == "opacity");
  REQUIRE(faded.changes[0].from == 100.0);
  REQUIRE(faded.changes[0].to == 40.0);

  after = before;
  after[0].mask = nlohmann::json::array({{{"kind", "radial"}}});
  const HistoryStep masked = describe_step(before, after);
  REQUIRE(masked.kind == "mask");
  REQUIRE(masked.changes.empty());
}

TEST_CASE("a value no row can print is a change with no numbers on it") {
  const Stack before{make_op("aabbccdd", "curve", {{"points", nlohmann::json::array({0, 1})}})};
  const Stack after{make_op("aabbccdd", "curve", {{"points", nlohmann::json::array({0, 2})}})};

  const HistoryStep step = describe_step(before, after);
  REQUIRE(step.kind == "update");
  REQUIRE(step.changes.size() == 1);
  REQUIRE(step.changes[0].from.is_null());
  REQUIRE(step.changes[0].to.is_null());
}

TEST_CASE("a step inside a group is found by its id, not by its depth") {
  Stack before{make_op("group001", "group", nlohmann::json::object())};
  before[0].ops.push_back(make_op("child001", "exposure", {{"value", 0.0}}));
  Stack after = before;
  after[0].ops[0].params["value"] = 1.25;

  const HistoryStep step = describe_step(before, after);
  REQUIRE(step.op_id == "child001");
  REQUIRE(step.op == "exposure");
  REQUIRE(step.changes[0].to == 1.25);
}

TEST_CASE("a commit that touched several ops is counted, not named after one of them") {
  const Stack before{make_op("aabbccdd", "exposure", {{"value", 0.0}})};
  // What applying a preset looks like from here: one slider written, two ops added.
  const Stack after{make_op("aabbccdd", "exposure", {{"value", 0.1}}),
                    make_op("11223344", "contrast", {{"value", 15.0}}),
                    make_op("55667788", "clarity", {{"value", 10.0}})};

  const HistoryStep step = describe_step(before, after);
  REQUIRE(step.kind == "batch");
  REQUIRE(step.op.empty());
  REQUIRE(step.op_id.empty());
  REQUIRE(step.changes.empty());

  // Each op it touched is described as a step of its own, so a row can be unfolded and one
  // of them reverted on its own.
  REQUIRE(step.entries.size() == 3);
  REQUIRE(step.entries[0].kind == "add");
  REQUIRE(step.entries[0].op == "contrast");
  REQUIRE(step.entries[2].kind == "update");
  REQUIRE(step.entries[2].op == "exposure");
  REQUIRE(step.entries[2].changes[0].to == 0.1);

  const nlohmann::json wire = history_step_to_json(step, 1);
  REQUIRE(!wire.contains("op"));
  REQUIRE(wire["entries"].size() == 3);
  REQUIRE(wire["entries"][2]["opId"] == "aabbccdd");
  REQUIRE(!wire["entries"][2].contains("index"));

  // Two ops arriving together is still a batch: a step is one op, or it is a list of them.
  const HistoryStep pair = describe_step(Stack{}, Stack{after[1], after[2]});
  REQUIRE(pair.kind == "batch");
  REQUIRE(pair.entries.size() == 2);

  // And one op moving is described in full, as it always was.
  const HistoryStep single = describe_step(before, Stack{after[0]});
  REQUIRE(single.kind == "update");
  REQUIRE(single.entries.empty());
  REQUIRE(!history_step_to_json(single, 1).contains("entries"));
}

TEST_CASE("a step keeps the name its caller gave it") {
  History history;
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 0.5}})}, "Golden hour applied");
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 1.5}})});

  const std::vector<HistoryStep> steps = describe_history(history.nodes());
  REQUIRE(steps[1].label == "Golden hour applied");
  REQUIRE(steps[2].label.empty());
  REQUIRE(history_step_to_json(steps[1], 1)["label"] == "Golden hour applied");
  REQUIRE(!history_step_to_json(steps[2], 2).contains("label"));

  // A drag replaces the snapshot under the cursor; the name of the step that made it stays.
  history.undo();
  history.commit_transient(Stack{make_op("aabbccdd", "exposure", {{"value", 3.0}})});
  REQUIRE(history.nodes()[1].label == "Golden hour applied");

  // Undoing past a named step and committing again starts a branch; the named step stays.
  REQUIRE(history.undo());
  REQUIRE(history.undo());
  history.commit(Stack{make_op("11223344", "contrast", {{"value", 10.0}})});
  REQUIRE(history.size() == 4);
  REQUIRE(history.nodes()[1].label == "Golden hour applied");
  REQUIRE(history.nodes().back().label.empty());
}

TEST_CASE("the same ops in another order is a reorder and nothing else") {
  const Op first = make_op("aabbccdd", "exposure", {{"value", 1.0}});
  const Op second = make_op("11223344", "contrast", {{"value", 10.0}});
  const HistoryStep step = describe_step(Stack{first, second}, Stack{second, first});
  REQUIRE(step.kind == "reorder");
  REQUIRE(step.op.empty());
}

TEST_CASE("the described history is one row per snapshot, opening state first") {
  History history;
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 0.5}})});
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 1.5}})});

  const std::vector<HistoryStep> steps = describe_history(history.nodes());
  REQUIRE(steps.size() == 3);
  REQUIRE(steps[0].kind == "initial");
  REQUIRE(steps[1].kind == "add");
  REQUIRE(steps[2].kind == "update");

  const nlohmann::json wire = history_step_to_json(steps[2], 2);
  REQUIRE(wire["index"] == 2);
  REQUIRE(wire["kind"] == "update");
  REQUIRE(wire["op"] == "exposure");
  REQUIRE(wire["changes"][0]["from"] == 0.5);
  REQUIRE(wire["changes"][0]["to"] == 1.5);
}

TEST_CASE("jumping lands on one snapshot and refuses the ones that do not exist") {
  History history;
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 0.5}})});
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 1.5}})});
  REQUIRE(history.cursor() == 2);

  REQUIRE(history.jump(0));
  REQUIRE(history.cursor() == 0);
  REQUIRE(history.current().empty());
  REQUIRE(history.can_redo());

  REQUIRE(!history.jump(0));
  REQUIRE(!history.jump(3));
  REQUIRE(history.cursor() == 0);

  REQUIRE(history.jump(2));
  REQUIRE(history.current()[0].params["value"] == 1.5);
}

TEST_CASE("a mask step says which component moved and how") {
  Stack before{make_op("group001", "group", nlohmann::json::object())};
  before[0].mask = nlohmann::json::parse(R"({"components": [
      {"id": "radial1", "kind": "radial", "mode": "add", "feather": 0,
       "params": {"center": [0.5, 0.5]}},
      {"id": "sky1", "kind": "sky", "mode": "add", "state": "pending", "params": {}}]})");
  Stack after = before;
  after[0].mask = nlohmann::json::parse(R"({"components": [
      {"id": "radial1", "kind": "radial", "mode": "subtract", "feather": 40,
       "params": {"center": [0.3, 0.5]}},
      {"id": "brush1", "kind": "brush", "mode": "add", "params": {}}]})");

  const HistoryStep step = describe_step(before, after);
  REQUIRE(step.kind == "mask");
  REQUIRE(step.changes.size() == 5);
  CHECK(step.changes[0].param == "radial1.feather");
  CHECK(step.changes[0].from == 0);
  CHECK(step.changes[0].to == 40);
  CHECK(step.changes[1].param == "radial1.mode");
  CHECK(step.changes[1].to == "subtract");
  // A point is not something a row can print; it still says that it moved.
  CHECK(step.changes[2].param == "radial1.center");
  CHECK(step.changes[2].to.is_null());
  CHECK(step.changes[3].param == "brush1");
  CHECK(step.changes[3].to == "brush");
  CHECK(step.changes[4].param == "sky1");
  CHECK(step.changes[4].from == "sky");

  // A detection landing is its state going ready, not the file names written with it.
  Stack detected = before;
  (*detected[0].mask)["components"][1]["state"] = "ready";
  (*detected[0].mask)["components"][1]["params"]["raster"] = "masks/sky1-abc.png";
  const HistoryStep landed = describe_step(before, detected);
  REQUIRE(landed.changes.size() == 1);
  CHECK(landed.changes[0].param == "sky1.state");
}

TEST_CASE("a commit that changes nothing is no step") {
  History history;
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 0.0}})});
  REQUIRE(history.size() == 2);

  // A slider dragged away and back to where it started.
  const uint64_t before_drag = history.revision();
  history.commit_transient(Stack{make_op("aabbccdd", "exposure", {{"value", 0.8}})});
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 0.0}})});
  CHECK(history.size() == 2);
  CHECK(history.revision() > before_drag);
  CHECK(history.current()[0].params["value"] == 0.0);

  // A click on the value it already holds, with a redo step waiting: the redo survives.
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 1.0}})});
  REQUIRE(history.undo());
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 0.0}})});
  CHECK(history.can_redo());
}

TEST_CASE("a history written to disk reads back with its steps, names and cursor") {
  History history;
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 0.5}})}, "Golden hour applied");
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 1.5}})});
  REQUIRE(history.undo());

  const std::optional<History> restored = history_from_json(history_to_json(history, 100));
  REQUIRE(restored.has_value());
  CHECK(restored->size() == 3);
  CHECK(restored->cursor() == 1);
  CHECK(restored->nodes()[1].label == "Golden hour applied");
  CHECK(restored->current()[0].params["value"] == 0.5);
  CHECK(restored->can_redo());

  // Capped to the newest steps, with the one on screen always among them.
  const std::optional<History> newest = history_from_json(history_to_json(history, 2));
  REQUIRE(newest.has_value());
  CHECK(newest->size() == 2);
  CHECK(newest->current()[0].params["value"] == 0.5);
  REQUIRE(history.jump(0));
  const std::optional<History> oldest = history_from_json(history_to_json(history, 2));
  REQUIRE(oldest.has_value());
  CHECK(oldest->cursor() == 0);
  CHECK(oldest->current().empty());

  CHECK_FALSE(history_from_json(nlohmann::json::parse(R"({"cursor": 3, "steps": []})")));
  CHECK_FALSE(history_from_json(nlohmann::json::array()));
}

TEST_CASE("a jump made during a drag throws the drag away first") {
  History history;
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 0.5}})});
  history.commit_transient(Stack{make_op("aabbccdd", "exposure", {{"value", 3.0}})});

  // Landing on the step the cursor is already on is still a move: the drag under it is
  // rolled back, which is a change the caller has to hear about.
  REQUIRE(history.jump(1));
  REQUIRE(history.current()[0].params["value"] == 0.5);
}

TEST_CASE("an edit after an undo starts a branch and keeps the steps it undid") {
  History history;
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 0.5}})});
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 1.5}})});
  REQUIRE(history.undo());
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", -1.0}})});

  REQUIRE(history.size() == 4);
  CHECK(history.cursor() == 3);
  CHECK(history.nodes()[2].parent == 1);
  CHECK(history.nodes()[3].parent == 1);
  CHECK_FALSE(history.can_redo());

  // Undo goes to the fork, redo back down the branch it came from.
  REQUIRE(history.undo());
  CHECK(history.cursor() == 1);
  REQUIRE(history.redo());
  CHECK(history.cursor() == 3);

  // The old branch is one jump away, and redo after a jump back follows the line jumped from.
  REQUIRE(history.jump(2));
  CHECK(history.current()[0].params["value"] == 1.5);
  REQUIRE(history.jump(0));
  REQUIRE(history.redo());
  REQUIRE(history.redo());
  CHECK(history.cursor() == 2);

  const std::vector<HistoryStep> steps = describe_history(history.nodes());
  CHECK(steps[3].kind == "update");
  CHECK(steps[3].changes[0].from == 0.5);
  CHECK(steps[3].changes[0].to == -1.0);
  CHECK(history_step_to_json(steps[3], 3)["parent"] == 1);
  CHECK_FALSE(history_step_to_json(steps[0], 0).contains("parent"));
}

TEST_CASE("a merge keeps what each branch changed and lets the merged-in one win a tie") {
  Stack base{make_op("aabbccdd", "exposure", {{"value", 0.0}}),
             make_op("11223344", "contrast", {{"value", 0.0}, {"shadows", 0.0}})};
  Stack ours = base;
  ours[0].params["value"] = 1.0;   // only ours
  ours[1].params["value"] = 20.0;  // both
  ours.push_back(make_op("55667788", "clarity", {{"value", 10.0}}));
  Stack theirs = base;
  theirs[1].params["value"] = -20.0;   // both: theirs wins
  theirs[1].params["shadows"] = 30.0;  // only theirs, same op as a tie
  theirs.push_back(make_op("99aabbcc", "vibrance", {{"value", 25.0}}));

  const Stack merged = merge_stacks(base, ours, theirs);
  REQUIRE(merged.size() == 4);
  CHECK(merged[0].params["value"] == 1.0);
  CHECK(merged[1].params["value"] == -20.0);
  CHECK(merged[1].params["shadows"] == 30.0);
  CHECK(merged[2].id == "55667788");
  CHECK(merged[3].id == "99aabbcc");

  // Removed on their side is removed, even an op ours had moved; theirs moving an op ours
  // removed brings it back.
  Stack dropped = base;
  dropped.erase(dropped.begin());
  Stack moved = base;
  moved[1].params["value"] = 5.0;
  const Stack removed = merge_stacks(base, moved, dropped);
  REQUIRE(removed.size() == 1);
  CHECK(removed[0].params["value"] == 5.0);
  const Stack restored = merge_stacks(base, Stack{base[0]}, moved);
  REQUIRE(restored.size() == 2);
  CHECK(restored[1].params["value"] == 5.0);
}

TEST_CASE("a merge joins mask components by id") {
  Stack base{make_op("group001", "group", nlohmann::json::object())};
  base[0].mask = nlohmann::json::parse(R"({"components": [
      {"id": "radial1", "kind": "radial", "mode": "add", "feather": 0, "params": {}}]})");
  Stack ours = base;
  (*ours[0].mask)["components"][0]["feather"] = 40;
  (*ours[0].mask)["components"].push_back(
      nlohmann::json::parse(R"({"id": "sky1", "kind": "sky", "mode": "add", "params": {}})"));
  Stack theirs = base;
  (*theirs[0].mask)["components"][0]["mode"] = "subtract";
  theirs[0].ops.push_back(make_op("child001", "exposure", {{"value", 0.5}}));

  const Stack merged = merge_stacks(base, ours, theirs);
  const nlohmann::json& components = (*merged[0].mask)["components"];
  REQUIRE(components.size() == 2);
  CHECK(components[0]["feather"] == 40);
  CHECK(components[0]["mode"] == "subtract");
  CHECK(components[1]["id"] == "sky1");
  REQUIRE(merged[0].ops.size() == 1);
  CHECK(merged[0].ops[0].id == "child001");
}

TEST_CASE("a merge step has both branches as parents and cannot merge what it has") {
  History history;
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 0.5}})});
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 1.5}})});
  REQUIRE(history.undo());
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 0.5}}),
                       make_op("11223344", "contrast", {{"value", 10.0}})});
  REQUIRE(history.common_ancestor(3, 2) == 1);

  CHECK_FALSE(history.merge(1, history.current()));
  CHECK_FALSE(history.merge(3, history.current()));
  CHECK_FALSE(history.merge(9, history.current()));

  const Stack merged =
      merge_stacks(history.nodes()[1].stack, history.current(), history.nodes()[2].stack);
  REQUIRE(history.merge(2, merged, "Merged"));
  CHECK(history.cursor() == 4);
  CHECK(history.nodes()[4].parent == 3);
  CHECK(history.nodes()[4].merged_from == 2);
  CHECK(history.current()[0].params["value"] == 1.5);
  CHECK(history.current().size() == 2);
  CHECK(history.descends_from(4, 2));
  // Merged once, the branch is part of this one and does not merge again.
  CHECK_FALSE(history.merge(2, history.current()));

  const HistoryStep step = describe_history(history.nodes())[4];
  CHECK(step.merged_from == 2);
  CHECK(step.changes[0].to == 1.5);
  CHECK(history_step_to_json(step, 4)["mergedFrom"] == 2);
}

TEST_CASE("the tree survives a round trip and the cap keeps whole branches") {
  History history;
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 0.5}})});
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 1.5}})});
  REQUIRE(history.undo());
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", -1.0}})});
  REQUIRE(history.merge(2, Stack{make_op("aabbccdd", "exposure", {{"value", 1.5}})}));

  const std::optional<History> restored = history_from_json(history_to_json(history, 100));
  REQUIRE(restored.has_value());
  REQUIRE(restored->size() == 5);
  CHECK(restored->cursor() == 4);
  CHECK(restored->nodes()[3].parent == 1);
  CHECK(restored->nodes()[4].merged_from == 2);

  // Four steps: the cursor's line back (4, 3, 1, 0) fills it, the side branch goes, and
  // the merge that pointed at it is a plain step.
  const std::optional<History> capped = history_from_json(history_to_json(history, 4));
  REQUIRE(capped.has_value());
  REQUIRE(capped->size() == 4);
  CHECK(capped->cursor() == 3);
  CHECK_FALSE(capped->nodes()[3].merged_from.has_value());
  CHECK(capped->current()[0].params["value"] == 1.5);

  // A history an older build wrote is a line: each step hangs off the one before it.
  const std::optional<History> linear = history_from_json(nlohmann::json::parse(
      R"({"cursor": 1, "steps": [{"label": "", "stack": []}, {"label": "", "stack": []}]})"));
  REQUIRE(linear.has_value());
  CHECK(linear->nodes()[1].parent == 0);
  CHECK_FALSE(history_from_json(nlohmann::json::parse(
      R"({"cursor": 0, "steps": [{"stack": []}, {"stack": [], "parent": 1}]})")));
}
