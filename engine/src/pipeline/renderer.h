// The pass chain. One full-res linear texture per open photo; per view a proxy-sized
// base texture (rendered once per size or geometry change), two ping-pong rgba16float
// textures the op passes bounce between, one scratch for the separable neighbourhood
// filters, and one rgba8 output that gets read back per frame.
#pragma once

#include "gpu/gpu.h"
#include "image/gray.h"
#include "ops/op.h"
#include "raw/raw_decode.h"

#include <cstdint>

#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <nlohmann/json.hpp>

namespace latent {

// Must match the `kind` switches in engine/shaders/{ops,blur,neighborhood}.wgsl.
enum class OpKind : uint32_t {
  None = 0,
  // 1..99: one per-pixel pass through ops.wgsl.
  WhiteBalance = 1,
  Exposure = 2,
  Contrast = 3,
  Highlights = 4,
  Shadows = 5,
  Whites = 6,
  Blacks = 7,
  Saturation = 8,
  Vibrance = 9,
  ToneCurve = 10,
  ColorMixer = 11,
  ColorGrading = 12,
  LensVignetting = 13,
  Vignette = 14,
  Grain = 15,
  // 100..199: a horizontal blur.wgsl pre-pass plus a neighborhood.wgsl combine pass.
  Texture = 100,
  Clarity = 101,
  Dehaze = 102,
  NoiseReduction = 103,
  ColorNoiseReduction = 104,
  Sharpening = 105,
  Defringe = 106,
  ChromaticAberration = 107,
  // 200+: no pass of its own; folded into the proxy's sampling pass (downscale.wgsl).
  Geometry = 200,
};

OpKind op_kind(std::string_view name);

struct RenderTiming {
  double render_ms = 0;
  double readback_ms = 0;
};

// What mask.preview answers with, next to the LMSK frame it precedes.
struct MaskReadout {
  uint32_t width = 0;
  uint32_t height = 0;
  // Share of the content rect above 50 %, so a client can tell an empty mask from a
  // failed one (protocol MaskPreviewResult).
  double coverage = 0;
};

struct ViewGeometry {
  uint32_t width = 0;
  uint32_t height = 0;
  // The letterboxed image rect inside the view, in pixels. Crop, rotate and the Transform
  // sliders change its aspect, so it is not the photo's aspect once geometry is edited.
  uint32_t content_x = 0;
  uint32_t content_y = 0;
  uint32_t content_width = 0;
  uint32_t content_height = 0;
};

class Renderer {
 public:
  explicit Renderer(uint32_t max_texture_dim);
  ~Renderer();
  Renderer(const Renderer&) = delete;
  Renderer& operator=(const Renderer&) = delete;

  const GpuReport& gpu_report() const { return gpu_.report(); }

  void load_photo(int64_t photo_id, const DecodedRaw& raw);
  void unload_photo(int64_t photo_id);
  bool has_photo(int64_t photo_id) const;

  void open_view(uint32_t view_id, int64_t photo_id, uint32_t width, uint32_t height);
  void close_view(uint32_t view_id);
  void close_views_of_photo(int64_t photo_id);
  bool has_view(uint32_t view_id) const;
  int64_t view_photo(uint32_t view_id) const;
  ViewGeometry view_geometry(uint32_t view_id) const;
  void resize_view(uint32_t view_id, uint32_t width, uint32_t height);

  // Renders the stack into the view and writes width*height*4 rgba8 bytes into
  // `out` starting at `offset`. `out` must already be large enough.
  RenderTiming render(uint32_t view_id, const Stack& stack, std::vector<uint8_t>& out,
                      size_t offset);

  // An AI component's raster: mask.detect's output, or the PNG cache reloaded when the
  // photo was opened. Held per photo and resampled into whatever size a view needs, so it
  // survives a resize and every view shares one copy.
  void put_mask_raster(int64_t photo_id, std::string_view component_id, std::string_view hash,
                       GrayImage raster);
  bool has_mask_raster(int64_t photo_id, std::string_view component_id,
                       std::string_view hash) const;

  // Renders the stack into the view — which builds any mask it needs — then reads one r8
  // mask back into `out`: `op_id`'s combined mask, or one component's raster when
  // `component_id` is not empty. Throws if either is unknown.
  MaskReadout read_mask(uint32_t view_id, const Stack& stack, std::string_view op_id,
                        std::string_view component_id, std::vector<uint8_t>& out, size_t offset);

 private:
  struct Photo;
  struct View;
  struct Pass;

  View& view_for(uint32_t view_id);
  void build_base(View& view);
  // Runs the op chain into the view's ping-pong textures and returns the texture the last
  // pass wrote (the base when the stack had nothing to do).
  WGPUTextureView run_passes(View& view, const Stack& stack);
  // Rasterises and folds one op's mask into a cached r8 texture. Called between passes,
  // because a luminance or colour component reads the op's input, which only exists once
  // everything below it has been submitted.
  void build_mask(View& view, const Op& op, const nlohmann::json& canonical,
                  const std::string& hash, WGPUTextureView input);

  Gpu gpu_;
  RenderPipelineHandle linearize_pipeline_;
  RenderPipelineHandle downscale_pipeline_;
  RenderPipelineHandle ops_pipeline_;
  RenderPipelineHandle blur_pipeline_;
  RenderPipelineHandle neighborhood_pipeline_;
  RenderPipelineHandle display_pipeline_;
  RenderPipelineHandle mask_pipeline_;
  RenderPipelineHandle mask_combine_pipeline_;
  // 1x1 r8: white is "the op applies everywhere" for an unmasked op, black is the empty
  // accumulator every mask folds into.
  TextureHandle white_mask_;
  TextureViewHandle white_mask_view_;
  TextureHandle empty_mask_;
  TextureViewHandle empty_mask_view_;
  BufferHandle mask_uniforms_;
  uint32_t mask_uniform_capacity_ = 0;
  // One slot per combine mode, written once: the fold never needs a per-frame upload.
  BufferHandle combine_uniforms_;
  std::unordered_map<int64_t, std::unique_ptr<Photo>> photos_;
  std::unordered_map<uint32_t, std::unique_ptr<View>> views_;
};

}  // namespace latent
