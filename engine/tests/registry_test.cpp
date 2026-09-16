#include "ops/registry.h"

#include "ops/op.h"

#include <set>
#include <string>
#include <utility>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using namespace latent;

TEST_CASE("every registered op has a panel, a label and params") {
  // protocol/messages.schema.json#/definitions/OpDefinition.panel.
  const std::set<std::string> panels = {"light",  "color",    "effects",   "detail",
                                        "optics", "geometry", "generative"};
  const nlohmann::json described = describe_ops();
  REQUIRE(described.contains("ops"));
  REQUIRE(described["ops"].size() == op_definitions().size());
  for (const nlohmann::json& op : described["ops"]) {
    REQUIRE(op["name"].is_string());
    REQUIRE(op["label"].is_string());
    REQUIRE(panels.contains(op["panel"].get<std::string>()));
    REQUIRE(op["params"].is_array());
    REQUIRE(!op["params"].empty());
  }
}

TEST_CASE("ops.describe lists Lightroom's sections in Lightroom's order") {
  const std::vector<std::string> expected = {"Light",  "Color",  "Effects",
                                             "Detail", "Optics", "Geometry"};
  const nlohmann::json described = describe_ops();
  std::vector<std::string> seen;
  int order_in_section = 0;
  for (const nlohmann::json& op : described["ops"]) {
    const std::string section = op["section"].get<std::string>();
    if (seen.empty() || seen.back() != section) {
      seen.push_back(section);
      order_in_section = 0;
    }
    // Inside a section the ops arrive in panel order, so a generated panel can render
    // ops.describe as it comes.
    REQUIRE(op["order"].get<int>() > order_in_section);
    order_in_section = op["order"].get<int>();
  }
  REQUIRE(seen == expected);
}

TEST_CASE("every op has a render stage, and the geometry ops share the first one") {
  REQUIRE(find_op_definition("crop")->stage == PipelineStage::Geometry);
  REQUIRE(find_op_definition("rotate")->stage == PipelineStage::Geometry);
  REQUIRE(find_op_definition("flip")->stage == PipelineStage::Geometry);
  REQUIRE(find_op_definition("transform")->stage == PipelineStage::Geometry);
  REQUIRE(find_op_definition("lens_correction")->stage == PipelineStage::Geometry);
  // Noise reduction before the tone ops, sharpening and grain after everything.
  REQUIRE(find_op_definition("noise_reduction")->stage < find_op_definition("exposure")->stage);
  REQUIRE(find_op_definition("clarity")->stage < find_op_definition("sharpening")->stage);
  REQUIRE(find_op_definition("sharpening")->stage < find_op_definition("grain")->stage);
}

TEST_CASE("exposure is an EV slider, the rest are -100..100 amounts") {
  const OpDefinition* exposure = find_op_definition("exposure");
  REQUIRE(exposure != nullptr);
  REQUIRE(exposure->panel == "light");
  REQUIRE(exposure->params.size() == 1);
  REQUIRE(exposure->params[0].min == -5.0);
  REQUIRE(exposure->params[0].max == 5.0);
  REQUIRE(exposure->params[0].step == 0.01);
  REQUIRE(exposure->params[0].unit == "EV");

  const OpDefinition* vibrance = find_op_definition("vibrance");
  REQUIRE(vibrance != nullptr);
  REQUIRE(vibrance->panel == "color");
  REQUIRE(vibrance->params[0].min == -100.0);
  REQUIRE(vibrance->params[0].max == 100.0);

  const OpDefinition* white_balance = find_op_definition("white_balance");
  REQUIRE(white_balance != nullptr);
  REQUIRE(white_balance->panel == "color");
  REQUIRE(white_balance->params.size() == 4);
  REQUIRE(find_op_definition("no_such_op") == nullptr);
}

TEST_CASE("white balance keeps the relative pair and adds the Kelvin one") {
  const OpDefinition* white_balance = find_op_definition("white_balance");
  REQUIRE(white_balance->params[0].name == "mode");
  REQUIRE(white_balance->params[0].type == ParamType::Enum);
  REQUIRE(white_balance->params[0].default_value == "relative");
  // The relative slider's range is untouched, so every sidecar written before Kelvin
  // existed still means exactly what it meant.
  REQUIRE(white_balance->params[1].name == "temperature");
  REQUIRE(white_balance->params[1].min == -100.0);
  REQUIRE(white_balance->params[1].max == 100.0);
  REQUIRE(white_balance->params[2].name == "kelvin");
  REQUIRE(white_balance->params[2].min == 2000.0);
  REQUIRE(white_balance->params[2].max == 50000.0);
  REQUIRE(white_balance->params[2].default_value == 5500.0);
  REQUIRE(white_balance->params[2].unit == "K");
  // Tint widened from Lightroom's +-100 to its +-150; the old values are inside it.
  REQUIRE(white_balance->params[3].name == "tint");
  REQUIRE(white_balance->params[3].min == -150.0);

  std::vector<std::string> warnings;
  const nlohmann::json legacy =
      normalize_params_for("white_balance", {{"temperature", 20}}, warnings);
  REQUIRE(legacy["mode"] == "relative");
  REQUIRE(legacy["temperature"] == 20.0);
  REQUIRE(warnings.empty());
  REQUIRE_THROWS_AS(normalize_params_for("white_balance", {{"mode", "auto"}}, warnings), OpError);
}

TEST_CASE("ops.describe carries the panel layout the generated UI needs") {
  const nlohmann::json described = describe_ops();
  std::set<std::pair<std::string, int>> seats;
  for (const nlohmann::json& op : described["ops"]) {
    REQUIRE(op.contains("section"));
    REQUIRE(op.contains("order"));
    REQUIRE(op["order"].get<int>() >= 1);
    // Section + order is a seat: two ops in one section may not claim the same row.
    const auto seat = std::make_pair(op["section"].get<std::string>(), op["order"].get<int>());
    REQUIRE(seats.insert(seat).second);
    for (const nlohmann::json& param : op["params"]) {
      // An enum is drawn as a select from `values`; every other param says which control
      // and which track gradient it wants.
      if (param["type"] == "enum") {
        REQUIRE(!param.contains("display"));
        REQUIRE(param["values"].is_array());
        continue;
      }
      REQUIRE(param.contains("display"));
      REQUIRE(param["display"]["kind"].is_string());
    }
  }
}

TEST_CASE("white balance is drawn the way Lightroom draws it") {
  const OpDefinition* white_balance = find_op_definition("white_balance");
  REQUIRE(white_balance != nullptr);
  REQUIRE(white_balance->section == "Color");
  REQUIRE(white_balance->order == 1);
  REQUIRE(white_balance->params[1].display_kind == "slider");
  REQUIRE(white_balance->params[1].display_tint == "temperature");
  REQUIRE(white_balance->params[2].display_kind == "kelvin");
  REQUIRE(white_balance->params[2].display_tint == "temperature");
  REQUIRE(white_balance->params[3].display_kind == "slider");
  REQUIRE(white_balance->params[3].display_tint == "tint");

  const OpDefinition* exposure = find_op_definition("exposure");
  REQUIRE(exposure->section == "Light");
  REQUIRE(exposure->order == 1);
  REQUIRE(exposure->params[0].display_kind == "slider");
  // An untinted slider says nothing about its track, so the field stays out of the JSON.
  REQUIRE(exposure->params[0].display_tint.empty());
  REQUIRE(!describe_ops()["ops"][0]["params"][0]["display"].contains("tint"));
}

TEST_CASE("missing params fall back to the default") {
  std::vector<std::string> warnings;
  const nlohmann::json params =
      normalize_params_for("white_balance", nlohmann::json::object(), warnings);
  REQUIRE(params["temperature"] == 0.0);
  REQUIRE(params["tint"] == 0.0);
  REQUIRE(warnings.empty());
}

TEST_CASE("out-of-range numbers are clamped and reported, not rejected") {
  std::vector<std::string> warnings;
  const nlohmann::json params = normalize_params_for("exposure", {{"value", 9.5}}, warnings);
  REQUIRE(params["value"] == 5.0);
  REQUIRE(warnings.size() == 1);
  REQUIRE(warnings[0].find("exposure.value") != std::string::npos);

  warnings.clear();
  REQUIRE(normalize_params_for("contrast", {{"value", -5000}}, warnings)["value"] == -100.0);
  REQUIRE(warnings.size() == 1);
}

TEST_CASE("unknown params are dropped with a warning, bad types throw") {
  std::vector<std::string> warnings;
  const nlohmann::json params =
      normalize_params_for("shadows", {{"value", 10}, {"amount", 3}}, warnings);
  REQUIRE(params.size() == 1);
  REQUIRE(params["value"] == 10.0);
  REQUIRE(warnings.size() == 1);
  REQUIRE(warnings[0].find("amount") != std::string::npos);

  REQUIRE_THROWS_AS(normalize_params_for("shadows", {{"value", "a lot"}}, warnings), OpError);
  REQUIRE_THROWS_AS(normalize_params_for("no_such_op", nlohmann::json::object(), warnings),
                    OpError);
}
