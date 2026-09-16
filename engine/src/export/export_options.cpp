#include "export/export_options.h"

#include "ops/op.h"

#include <cmath>

#include <algorithm>
#include <array>
#include <filesystem>
#include <string>
#include <unordered_map>

namespace latent {

namespace {

// The largest side wgpu will hand out on this class of adapter, and the ceiling on any
// resize. A request above it is a mistake, not a tiled export (see render_export).
constexpr uint32_t kMaxExportEdge = 16384;

template <typename Enum>
Enum enum_from_name(const nlohmann::json& params, const char* key,
                    const std::vector<std::pair<std::string_view, Enum>>& table, bool required,
                    Enum fallback) {
  if (!params.contains(key) || params[key].is_null()) {
    if (!required) return fallback;
    throw OpError(std::string("params.") + key + " is required");
  }
  if (!params[key].is_string()) {
    throw OpError(std::string("params.") + key + " must be a string");
  }
  const std::string value = params[key].get<std::string>();
  for (const auto& entry : table) {
    if (entry.first == value) return entry.second;
  }
  std::string allowed;
  for (const auto& entry : table) {
    if (!allowed.empty()) allowed += ", ";
    allowed += entry.first;
  }
  throw OpError(std::string("params.") + key + " '" + value + "' is not one of: " + allowed);
}

uint32_t optional_edge(const nlohmann::json& resize, const char* key) {
  if (!resize.contains(key) || resize[key].is_null()) return 0;
  if (!resize[key].is_number_integer()) {
    throw OpError(std::string("params.resize.") + key + " must be an integer");
  }
  const int64_t value = resize[key].get<int64_t>();
  if (value < 1 || value > kMaxExportEdge) {
    throw OpError(std::string("params.resize.") + key + " must be between 1 and " +
                  std::to_string(kMaxExportEdge));
  }
  return static_cast<uint32_t>(value);
}

uint32_t fit(double value) {
  return std::clamp(static_cast<uint32_t>(std::lround(value)), 1U, kMaxExportEdge);
}

}  // namespace

std::string_view export_format_name(ExportFormat format) {
  switch (format) {
    case ExportFormat::Tiff16:
      return "tiff16";
    case ExportFormat::Png:
      return "png";
    case ExportFormat::Avif:
      return "avif";
    default:
      return "jpeg";
  }
}

std::string_view export_format_extension(ExportFormat format) {
  switch (format) {
    case ExportFormat::Tiff16:
      return "tif";
    case ExportFormat::Png:
      return "png";
    case ExportFormat::Avif:
      return "avif";
    default:
      return "jpg";
  }
}

std::string_view export_color_space_name(ExportColorSpace space) {
  switch (space) {
    case ExportColorSpace::DisplayP3:
      return "displayP3";
    case ExportColorSpace::AdobeRgb:
      return "adobeRGB";
    case ExportColorSpace::Rec2020:
      return "rec2020";
    case ExportColorSpace::ProPhoto:
      return "proPhoto";
    default:
      return "srgb";
  }
}

ExportSize export_resize_fit(const ExportResize& resize, uint32_t width, uint32_t height) {
  const ExportSize native{std::max(width, 1U), std::max(height, 1U)};
  if (resize.empty()) return native;
  const double aspect = static_cast<double>(native.width) / native.height;

  if (resize.long_edge > 0) {
    if (native.width >= native.height) {
      return {fit(resize.long_edge), fit(resize.long_edge / aspect)};
    }
    return {fit(resize.long_edge * aspect), fit(resize.long_edge)};
  }
  if (resize.width > 0 && resize.height == 0) {
    return {fit(resize.width), fit(resize.width / aspect)};
  }
  if (resize.height > 0 && resize.width == 0) {
    return {fit(resize.height * aspect), fit(resize.height)};
  }
  // Both given: the box the image has to fit inside, aspect kept.
  const double scale = std::min(static_cast<double>(resize.width) / native.width,
                                static_cast<double>(resize.height) / native.height);
  return {fit(native.width * scale), fit(native.height * scale)};
}

SharpenSettings export_sharpen_settings(const ExportSharpen& sharpen) {
  if (sharpen.target == SharpenTarget::None) return {};
  SharpenSettings settings;
  // shaders/blur.wgsl walks whole texels (`i32(op.v[6].x)`), so the radius is an integer
  // count and the sub-pixel part of the halo comes from its sigma, not from the count.
  switch (sharpen.target) {
    case SharpenTarget::Matte:
      settings.radius = 3;
      break;
    case SharpenTarget::Glossy:
      settings.radius = 2;
      break;
    default:
      // Screen: the narrowest halo, because nothing spreads the pixel afterwards.
      settings.radius = 1;
      break;
  }
  switch (sharpen.amount) {
    case SharpenAmount::Low:
      settings.amount = 0.3F;
      break;
    case SharpenAmount::High:
      settings.amount = 0.9F;
      break;
    default:
      settings.amount = 0.55F;
      break;
  }
  // Paper eats contrast, so the same "standard" means more on matte than on screen.
  if (sharpen.target == SharpenTarget::Matte) settings.amount *= 1.4F;
  if (sharpen.target == SharpenTarget::Glossy) settings.amount *= 1.15F;
  return settings;
}

std::string export_file_name(const std::string& file_name_template, const std::string& source_path,
                             size_t index, ExportFormat format) {
  const std::string stem = std::filesystem::path(source_path).stem().string();
  std::string name = file_name_template.empty() ? "{name}" : file_name_template;
  const std::unordered_map<std::string, std::string> tokens = {
      {"{name}", stem.empty() ? "photo" : stem},
      {"{index}", std::to_string(index)},
      {"{ext}", std::string(export_format_extension(format))}};
  for (const auto& [token, value] : tokens) {
    for (size_t at = name.find(token); at != std::string::npos; at = name.find(token, at)) {
      name.replace(at, token.size(), value);
      at += value.size();
    }
  }
  // A template is a file name, never a path: a user typing "../" must not escape the
  // output directory, and a NUL would truncate the path the OS sees.
  std::erase_if(name, [](char c) { return c == '/' || c == '\\' || c == '\0'; });
  while (!name.empty() && name.front() == '.')
    name.erase(name.begin());
  if (name.empty()) name = "photo";

  const std::string extension = "." + std::string(export_format_extension(format));
  if (name.size() >= extension.size() &&
      name.compare(name.size() - extension.size(), extension.size(), extension) == 0) {
    return name;
  }
  return name + extension;
}

ExportOptions export_options_from_json(const nlohmann::json& params) {
  if (!params.is_object()) throw OpError("export.run params must be an object");
  ExportOptions options;

  if (!params.contains("photoIds") || !params["photoIds"].is_array() ||
      params["photoIds"].empty()) {
    throw OpError("params.photoIds must be a non-empty array");
  }
  for (const nlohmann::json& id : params["photoIds"]) {
    if (!id.is_number_integer() || id.get<int64_t>() < 1) {
      throw OpError("params.photoIds holds photo ids, integers >= 1");
    }
    options.photo_ids.push_back(id.get<int64_t>());
  }

  options.format = enum_from_name<ExportFormat>(params, "format",
                                                {{"jpeg", ExportFormat::Jpeg},
                                                 {"tiff16", ExportFormat::Tiff16},
                                                 {"png", ExportFormat::Png},
                                                 {"avif", ExportFormat::Avif}},
                                                true, ExportFormat::Jpeg);
  options.color_space =
      enum_from_name<ExportColorSpace>(params, "colorSpace",
                                       {{"srgb", ExportColorSpace::Srgb},
                                        {"displayP3", ExportColorSpace::DisplayP3},
                                        {"adobeRGB", ExportColorSpace::AdobeRgb},
                                        {"rec2020", ExportColorSpace::Rec2020},
                                        {"proPhoto", ExportColorSpace::ProPhoto}},
                                       true, ExportColorSpace::Srgb);

  if (params.contains("quality") && !params["quality"].is_null()) {
    if (!params["quality"].is_number_integer()) throw OpError("params.quality must be an integer");
    const int64_t quality = params["quality"].get<int64_t>();
    if (quality < 1 || quality > 100) throw OpError("params.quality must be between 1 and 100");
    options.quality = static_cast<int>(quality);
  }

  if (params.contains("resize") && !params["resize"].is_null()) {
    if (!params["resize"].is_object()) throw OpError("params.resize must be an object");
    const nlohmann::json& resize = params["resize"];
    options.resize.long_edge = optional_edge(resize, "longEdge");
    options.resize.width = optional_edge(resize, "width");
    options.resize.height = optional_edge(resize, "height");
    options.resize.dpi = optional_edge(resize, "dpi");
  }

  if (params.contains("sharpen") && !params["sharpen"].is_null()) {
    if (!params["sharpen"].is_object()) throw OpError("params.sharpen must be an object");
    options.sharpen.target = enum_from_name<SharpenTarget>(params["sharpen"], "target",
                                                           {{"screen", SharpenTarget::Screen},
                                                            {"matte", SharpenTarget::Matte},
                                                            {"glossy", SharpenTarget::Glossy}},
                                                           true, SharpenTarget::None);
    options.sharpen.amount = enum_from_name<SharpenAmount>(params["sharpen"], "amount",
                                                           {{"low", SharpenAmount::Low},
                                                            {"standard", SharpenAmount::Standard},
                                                            {"high", SharpenAmount::High}},
                                                           false, SharpenAmount::Standard);
  }

  if (!params.contains("outputDir") || !params["outputDir"].is_string() ||
      params["outputDir"].get<std::string>().empty()) {
    throw OpError("params.outputDir must be a non-empty string");
  }
  options.output_dir = params["outputDir"].get<std::string>();

  if (params.contains("fileNameTemplate") && !params["fileNameTemplate"].is_null()) {
    if (!params["fileNameTemplate"].is_string()) {
      throw OpError("params.fileNameTemplate must be a string");
    }
    const std::string value = params["fileNameTemplate"].get<std::string>();
    if (!value.empty()) options.file_name_template = value;
  }
  return options;
}

}  // namespace latent
