#include "ops/sidecar.h"

#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace latent {

namespace {

constexpr int kSidecarVersion = 1;

}  // namespace

std::string sidecar_path_for(std::string_view photo_path) {
  return std::string(photo_path) + ".latent";
}

nlohmann::json sidecar_to_json(const Sidecar& sidecar) {
  return {{"version", sidecar.version},
          {"source", {{"path", sidecar.source_path}, {"hash", sidecar.source_hash}}},
          {"stack", stack_to_json(sidecar.stack)}};
}

Sidecar sidecar_from_json(const nlohmann::json& value) {
  if (!value.is_object()) throw OpError("sidecar must be an object");
  if (!value.contains("version") || !value["version"].is_number_integer()) {
    throw OpError("sidecar.version must be an integer");
  }
  Sidecar sidecar;
  sidecar.version = value["version"].get<int>();
  if (sidecar.version > kSidecarVersion) {
    throw OpError("sidecar version " + std::to_string(sidecar.version) +
                  " is newer than this engine");
  }
  const nlohmann::json& source = value.value("source", nlohmann::json::object());
  sidecar.source_path = source.value("path", std::string());
  sidecar.source_hash = source.value("hash", std::string());
  sidecar.stack = stack_from_json(value.value("stack", nlohmann::json::array()));
  return sidecar;
}

void write_sidecar(const std::string& path, const Sidecar& sidecar) {
  const std::string temporary = path + ".tmp";
  {
    std::ofstream file(temporary, std::ios::binary | std::ios::trunc);
    if (!file) throw std::runtime_error("cannot write " + temporary);
    file << sidecar_to_json(sidecar).dump(2) << "\n";
    if (!file) throw std::runtime_error("write failed for " + temporary);
  }
  std::error_code error;
  std::filesystem::rename(temporary, path, error);
  if (error) throw std::runtime_error("cannot replace " + path + ": " + error.message());
}

std::optional<Sidecar> read_sidecar(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) return std::nullopt;
  nlohmann::json value = nlohmann::json::parse(file, nullptr, false);
  if (value.is_discarded()) throw OpError("sidecar " + path + " is not valid JSON");
  return sidecar_from_json(value);
}

}  // namespace latent
