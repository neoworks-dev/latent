#include "ops/registry.h"

#include "ops/op.h"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using namespace latent;

TEST_CASE("every registered op has a panel, a label and params") {
  const nlohmann::json described = describe_ops();
  REQUIRE(described.contains("ops"));
  REQUIRE(described["ops"].size() == op_definitions().size());
  for (const nlohmann::json& op : described["ops"]) {
    REQUIRE(op["name"].is_string());
    REQUIRE(op["label"].is_string());
    REQUIRE((op["panel"] == "light" || op["panel"] == "color"));
    REQUIRE(op["params"].is_array());
    REQUIRE(!op["params"].empty());
  }
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
  REQUIRE(white_balance->params.size() == 2);
  REQUIRE(find_op_definition("clarity") == nullptr);
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
