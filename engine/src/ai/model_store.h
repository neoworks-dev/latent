// Where the ONNX graphs live. `scripts/models/fetch.py` writes the store; the engine only
// reads it and never downloads anything — a missing model is a message, not a stall.
//
// Root resolution mirrors fetch.py: $LATENT_MODEL_STORE, else $XDG_DATA_HOME/latent/models,
// else ~/.local/share/latent/models.
#pragma once

#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace latent {

// Model directory names, which are also what MaskDetectResult::model reports.
inline constexpr std::string_view kSam2Model = "sam2-hiera-base-plus";
inline constexpr std::string_view kFlorenceModel = "florence-2-base";
inline constexpr std::string_view kBiRefNetModel = "birefnet-lite";
inline constexpr std::string_view kSegFormerModel = "segformer-b2-ade20k";

std::string model_store_root();
std::string model_dir(std::string_view model);

// True when the directory and its config.json are both there.
bool model_installed(std::string_view model);

// The one sentence every missing-model failure reports.
std::string missing_model_message(std::string_view model);

// Both throw std::runtime_error when the file is missing or is not JSON.
nlohmann::json read_json_file(const std::string& path);
nlohmann::json read_model_config(std::string_view model);

}  // namespace latent
