#include "ops/sidecar.h"

#include "ops/mask.h"
#include "ops/registry.h"
#include "ops/sha256.h"

#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using namespace latent;

namespace {

std::filesystem::path temp_dir() {
  const std::filesystem::path directory =
      std::filesystem::temp_directory_path() / ("latent-test-" + make_op_id());
  std::filesystem::create_directories(directory);
  return directory;
}

}  // namespace

TEST_CASE("sidecar path is the photo path plus .latent") {
  REQUIRE(sidecar_path_for("/photos/DSC00120.ARW") == "/photos/DSC00120.ARW.latent");
}

TEST_CASE("sidecar survives a write/read round trip") {
  const std::filesystem::path directory = temp_dir();
  const std::string path = (directory / "DSC00120.ARW.latent").string();

  Sidecar written;
  written.source_path = (directory / "DSC00120.ARW").string();
  written.source_hash = "0123456789abcdef";
  Op exposure;
  exposure.id = "aabbccdd";
  exposure.name = "exposure";
  exposure.params = {{"value", 1.0}};
  written.stack.push_back(exposure);
  write_sidecar(path, written);

  const std::optional<Sidecar> read = read_sidecar(path);
  REQUIRE(read.has_value());
  REQUIRE(read->version == 1);
  REQUIRE(read->source_path == written.source_path);
  REQUIRE(read->source_hash == written.source_hash);
  REQUIRE(read->stack.size() == 1);
  REQUIRE(read->stack[0].id == "aabbccdd");
  REQUIRE(read->stack[0].name == "exposure");
  REQUIRE(read->stack[0].params["value"] == 1.0);

  std::ifstream file(path);
  const nlohmann::json raw = nlohmann::json::parse(file);
  REQUIRE(raw["version"] == 1);
  REQUIRE(raw["source"]["path"] == written.source_path);
  REQUIRE(raw["source"]["hash"] == written.source_hash);
  REQUIRE(raw["stack"][0]["op"] == "exposure");

  std::filesystem::remove_all(directory);
}

TEST_CASE("a sidecar round trips masks and opacity") {
  const std::filesystem::path directory = temp_dir();
  const std::string path = (directory / "masked.latent").string();

  Sidecar written;
  written.source_path = (directory / "DSC00120.ARW").string();
  Op exposure;
  exposure.id = "aabbccdd";
  exposure.name = "exposure";
  exposure.params = {{"value", 2.0}};
  exposure.opacity = 60;
  exposure.mask = normalize_mask(
      {{"components",
        nlohmann::json::array(
            {{{"id", "m1"},
              {"kind", "radial"},
              {"mode", "add"},
              {"feather", 40},
              {"params", {{"center", {0.4, 0.5}}, {"radius", {0.2, 0.25}}}}},
             {{"id", "m2"},
              {"kind", "brush"},
              {"mode", "subtract"},
              {"params",
               {{"size", 0.1},
                {std::string(kBrushStrokeDataKey),
                 nlohmann::json::array(
                     {{{"erase", false},
                       {"size", 0.1},
                       {"flow", 100},
                       {"points", nlohmann::json::array({{0.2, 0.3, 1.0}})}}})}}}}})}});
  // An op at full opacity says nothing about it, which keeps an untouched stack terse.
  Op vibrance;
  vibrance.id = "eeff0011";
  vibrance.name = "vibrance";
  vibrance.params = {{"value", 20}};
  written.stack = {exposure, vibrance};
  write_sidecar(path, written);

  const std::optional<Sidecar> read = read_sidecar(path);
  REQUIRE(read.has_value());
  REQUIRE(read->stack.size() == 2);
  REQUIRE(read->stack[0].opacity == 60);
  REQUIRE(read->stack[1].opacity == 100);
  REQUIRE(read->stack[0].mask.has_value());
  REQUIRE(!read->stack[1].mask.has_value());

  const Mask mask = mask_from_json(*read->stack[0].mask);
  REQUIRE(mask.components.size() == 2);
  REQUIRE(mask.components[0].id == "m1");
  REQUIRE(mask.components[0].kind == MaskKind::Radial);
  REQUIRE(mask.components[0].feather == 40);
  REQUIRE(mask.components[1].mode == MaskMode::Subtract);
  // The stroke list is the mask, so it has to come back byte for byte.
  const std::vector<BrushStroke> strokes = brush_strokes(mask.components[1].params);
  REQUIRE(strokes.size() == 1);
  REQUIRE(strokes[0].points.size() == 1);
  REQUIRE(strokes[0].points[0].x == 0.2);

  std::ifstream file(path);
  const nlohmann::json raw = nlohmann::json::parse(file);
  REQUIRE(raw["version"] == 1);
  REQUIRE(raw["stack"][0]["opacity"] == 60);
  REQUIRE(raw["stack"][0]["mask"]["components"][0]["kind"] == "radial");
  REQUIRE(!raw["stack"][1].contains("opacity"));
  REQUIRE(!raw["stack"][1].contains("mask"));

  std::filesystem::remove_all(directory);
}

TEST_CASE("a sidecar written before masks existed still loads") {
  const std::filesystem::path directory = temp_dir();
  const std::string path = (directory / "old.latent").string();
  std::ofstream(path) << R"({
    "version": 1,
    "source": {"path": "/photos/DSC00120.ARW", "hash": "abc"},
    "stack": [{"id": "aaaa0001", "op": "exposure", "params": {"value": 1}, "enabled": true}]
  })";

  const std::optional<Sidecar> read = read_sidecar(path);
  REQUIRE(read.has_value());
  REQUIRE(read->stack.size() == 1);
  REQUIRE(!read->stack[0].mask.has_value());
  // Absent opacity is full opacity, so an old sidecar renders exactly as it used to.
  REQUIRE(read->stack[0].opacity == 100);

  std::filesystem::remove_all(directory);
}

TEST_CASE("a missing sidecar is not an error, a broken one is") {
  const std::filesystem::path directory = temp_dir();
  REQUIRE(!read_sidecar((directory / "absent.latent").string()).has_value());

  const std::string broken = (directory / "broken.latent").string();
  std::ofstream(broken) << "{not json";
  REQUIRE_THROWS_AS(read_sidecar(broken), OpError);

  const std::string future = (directory / "future.latent").string();
  std::ofstream(future) << R"({"version": 99, "source": {}, "stack": []})";
  REQUIRE_THROWS_AS(read_sidecar(future), OpError);

  std::filesystem::remove_all(directory);
}

TEST_CASE("a sidecar from a newer or older engine still loads") {
  const std::filesystem::path directory = temp_dir();
  const std::string path = (directory / "forward.latent").string();
  // An op this build has never heard of, next to one written before the op set grew.
  // The codec keeps both; dropping the unknown one is the server's decision, made when
  // the stack is rendered, not the reader's.
  std::ofstream(path) << R"({
    "version": 1,
    "source": {"path": "/photos/DSC00120.ARW", "hash": "abc"},
    "stack": [
      {"id": "aaaa0001", "op": "lens_blur", "params": {"amount": 50}, "enabled": true},
      {"id": "aaaa0002", "op": "white_balance", "params": {"temperature": 20, "tint": -5},
       "enabled": true},
      {"id": "aaaa0003", "op": "vibrance", "params": {"value": 30}, "enabled": true}
    ]
  })";

  const std::optional<Sidecar> read = read_sidecar(path);
  REQUIRE(read.has_value());
  REQUIRE(read->stack.size() == 3);
  REQUIRE(read->stack[0].name == "lens_blur");
  REQUIRE(read->stack[0].params["amount"] == 50);

  // The white balance op predates the Kelvin mode: normalising it must not touch the two
  // values it does carry, and must leave it in the relative mode they were written for.
  std::vector<std::string> warnings;
  const nlohmann::json white_balance =
      normalize_params_for(read->stack[1].name, read->stack[1].params, warnings);
  REQUIRE(white_balance["mode"] == "relative");
  REQUIRE(white_balance["temperature"] == 20.0);
  REQUIRE(white_balance["tint"] == -5.0);
  REQUIRE(normalize_params_for("vibrance", read->stack[2].params, warnings)["value"] == 30.0);
  REQUIRE(warnings.empty());

  std::filesystem::remove_all(directory);
}

TEST_CASE("sha256 matches the published vectors") {
  REQUIRE(sha256_hex({}) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const std::string abc = "abc";
  REQUIRE(sha256_hex({reinterpret_cast<const uint8_t*>(abc.data()), abc.size()}) ==
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const std::string long_input(1000000, 'a');
  REQUIRE(sha256_hex({reinterpret_cast<const uint8_t*>(long_input.data()), long_input.size()}) ==
          "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

TEST_CASE("sha256 of a file matches the same bytes in memory") {
  const std::filesystem::path directory = temp_dir();
  const std::string path = (directory / "bytes.bin").string();
  const std::string content(3 * 1024 * 1024 + 17, 'x');
  std::ofstream(path, std::ios::binary) << content;
  REQUIRE(sha256_file_hex(path) ==
          sha256_hex({reinterpret_cast<const uint8_t*>(content.data()), content.size()}));
  REQUIRE_THROWS(sha256_file_hex((directory / "absent.bin").string()));
  std::filesystem::remove_all(directory);
}
