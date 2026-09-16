// What one `export.run` call asks for (protocol/README.md, PROMPT.md 3.6): the format and
// its quality, the output colour space, an optional resize, optional output sharpening,
// where the files go and what they are called. Pure data plus its JSON parser — no GPU, no
// encoder, no socket, so the Catch2 tests can reach all of it.
#pragma once

#include <cstdint>

#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace latent {

enum class ExportFormat : uint8_t { Jpeg, Tiff16, Png, Avif };

// The five profiles an export can be tagged with. The working space is linear sRGB
// primaries (LibRaw runs with `output_color = 1`), so every transform starts there.
enum class ExportColorSpace : uint8_t { Srgb, DisplayP3, AdobeRgb, Rec2020, ProPhoto };

// Lightroom's three output-sharpening targets plus "off". Screen is the sharpest and
// narrowest; the two paper targets use a wider radius because ink spreads.
enum class SharpenTarget : uint8_t { None, Screen, Matte, Glossy };
enum class SharpenAmount : uint8_t { Low, Standard, High };

struct ExportSharpen {
  SharpenTarget target = SharpenTarget::None;
  SharpenAmount amount = SharpenAmount::Standard;
};

// Zero everywhere means "native size". `long_edge` wins over `width`/`height`; giving both
// `width` and `height` fits the image inside that box without changing its aspect.
struct ExportResize {
  uint32_t long_edge = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t dpi = 0;

  bool empty() const { return long_edge == 0 && width == 0 && height == 0; }
};

struct ExportOptions {
  std::vector<int64_t> photo_ids;
  ExportFormat format = ExportFormat::Jpeg;
  int quality = 90;
  ExportColorSpace color_space = ExportColorSpace::Srgb;
  ExportResize resize;
  ExportSharpen sharpen;
  std::string output_dir;
  // `{name}` is the source filename without its extension, `{index}` the 1-based position
  // in this run, `{ext}` the format's own extension. Defaults to "{name}".
  std::string file_name_template = "{name}";
};

// Throws OpError (which the server maps to -32602) on anything malformed.
ExportOptions export_options_from_json(const nlohmann::json& params);

std::string_view export_format_name(ExportFormat format);
std::string_view export_format_extension(ExportFormat format);
std::string_view export_color_space_name(ExportColorSpace space);

// The output size for a source of `width` x `height`. Never returns a zero dimension.
struct ExportSize {
  uint32_t width = 0;
  uint32_t height = 0;
};
ExportSize export_resize_fit(const ExportResize& resize, uint32_t width, uint32_t height);

// Radius in output pixels and unsharp amount for one target/amount pair. `radius` is 0
// when the target is None, which is the caller's signal to skip the two passes.
struct SharpenSettings {
  float radius = 0;
  float amount = 0;
};
SharpenSettings export_sharpen_settings(const ExportSharpen& sharpen);

// `{name}`/`{index}`/`{ext}` substituted, path separators stripped, extension forced.
// `source_path` is the raw file; `index` is 1-based.
std::string export_file_name(const std::string& file_name_template, const std::string& source_path,
                             size_t index, ExportFormat format);

}  // namespace latent
