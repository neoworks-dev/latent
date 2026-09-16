#include "ai/model_store.h"

#include <cstdlib>

#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace latent {

namespace {

std::string env_or_empty(const char* name) {
  const char* value = std::getenv(name);
  return value == nullptr ? std::string() : std::string(value);
}

}  // namespace

std::string model_store_root() {
  const std::string override_root = env_or_empty("LATENT_MODEL_STORE");
  if (!override_root.empty()) return override_root;
  const std::string data_home = env_or_empty("XDG_DATA_HOME");
  if (!data_home.empty()) return data_home + "/latent/models";
  const std::string home = env_or_empty("HOME");
  return home + "/.local/share/latent/models";
}

std::string model_dir(std::string_view model) {
  return model_store_root() + "/" + std::string(model);
}

bool model_installed(std::string_view model) {
  std::error_code ignored;
  const std::filesystem::path dir(model_dir(model));
  return std::filesystem::is_directory(dir, ignored) &&
         std::filesystem::is_regular_file(dir / "config.json", ignored);
}

std::string missing_model_message(std::string_view model) {
  return "model " + std::string(model) + " not installed (run scripts/models/fetch.py)";
}

nlohmann::json read_json_file(const std::string& path) {
  std::ifstream file(path);
  if (!file) throw std::runtime_error("cannot read " + path);
  try {
    return nlohmann::json::parse(file);
  } catch (const nlohmann::json::exception& error) {
    throw std::runtime_error(path + " is not valid JSON: " + error.what());
  }
}

nlohmann::json read_model_config(std::string_view model) {
  return read_json_file(model_dir(model) + "/config.json");
}

}  // namespace latent
