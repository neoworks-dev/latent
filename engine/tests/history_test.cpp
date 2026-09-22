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
  REQUIRE(added.changes.empty());

  const HistoryStep removed = describe_step(one, empty);
  REQUIRE(removed.kind == "remove");
  REQUIRE(removed.op == "clarity");
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

  const std::vector<HistoryStep> steps = describe_history(history.snapshots(), history.labels());
  REQUIRE(steps[1].label == "Golden hour applied");
  REQUIRE(steps[2].label.empty());
  REQUIRE(history_step_to_json(steps[1], 1)["label"] == "Golden hour applied");
  REQUIRE(!history_step_to_json(steps[2], 2).contains("label"));

  // A drag replaces the snapshot under the cursor; the name of the step that made it stays.
  history.commit_transient(Stack{make_op("aabbccdd", "exposure", {{"value", 3.0}})});
  REQUIRE(history.labels()[1] == "Golden hour applied");
  REQUIRE(history.labels().size() == history.snapshots().size());

  // Undoing past a named step and committing again drops its name with its snapshot.
  REQUIRE(history.undo());
  REQUIRE(history.undo());
  history.commit(Stack{make_op("11223344", "contrast", {{"value", 10.0}})});
  REQUIRE(history.labels().size() == history.snapshots().size());
  REQUIRE(history.labels().back().empty());
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

  const std::vector<HistoryStep> steps = describe_history(history.snapshots());
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

TEST_CASE("a jump made during a drag throws the drag away first") {
  History history;
  history.commit(Stack{make_op("aabbccdd", "exposure", {{"value", 0.5}})});
  history.commit_transient(Stack{make_op("aabbccdd", "exposure", {{"value", 3.0}})});

  // Landing on the step the cursor is already on is still a move: the drag under it is
  // rolled back, which is a change the caller has to hear about.
  REQUIRE(history.jump(1));
  REQUIRE(history.current()[0].params["value"] == 0.5);
}
