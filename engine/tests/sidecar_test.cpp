#include "ops/sidecar.h"

#include "ops/sha256.h"

#include <filesystem>
#include <fstream>

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
