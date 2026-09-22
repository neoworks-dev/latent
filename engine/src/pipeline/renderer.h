// The pass chain. One full-res linear texture per open photo; per view a proxy-sized
// base texture (rendered once per size or geometry change), two ping-pong rgba16float
// textures the op passes bounce between, one scratch for the separable neighbourhood
// filters, and one rgba8 output that gets read back per frame.
#pragma once

#include "export/encoder.h"
#include "export/export_options.h"
#include "gpu/gpu.h"
#include "image/gray.h"
#include "image/jpeg.h"
#include "ops/geometry.h"
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
  // manual_denoise is the one kind here that is not a single blur/combine pair: it runs
  // three à trous levels, each of them such a pair, and one blend.wgsl pass puts the result
  // back through the op's mask. Renderer::run_passes has the loop.
  ManualDenoise = 108,
  // 200+: no pass of its own; folded into the proxy's sampling pass (downscale.wgsl).
  Geometry = 200,
  // 300+: composite.wgsl, which mixes a cached raster back in rather than computing one.
  Generative = 300,
  // 400+: blend.wgsl, the pass that closes a group — the branch its children rendered,
  // mixed back into the group's input through the group's mask (PROMPT.md 3.7).
  Blend = 400,
  // 500+: relight.wgsl, two passes over the photo's depth map — the shafts march, then the
  // shading that reads it (PROMPT.md 3.8).
  Relight = 500,
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

// What Renderer::render_export needs from export.run's options: the output size and the
// two passes that only an export runs. The encoder half lives in src/export/.
struct ExportRenderOptions {
  ExportResize resize;
  ExportSharpen sharpen;
  ExportColorSpace color_space = ExportColorSpace::Srgb;
};

struct ViewGeometry {
  uint32_t width = 0;
  uint32_t height = 0;
  // The letterboxed image rect inside the view, in pixels. Crop, rotate and the Transform
  // sliders change its aspect, so it is not the photo's aspect once geometry is edited.
  // Signed and free to exceed the frame: a zoomed view is a window into a rect that starts
  // off the top left corner (protocol ViewRenderParams.viewport).
  int32_t content_x = 0;
  int32_t content_y = 0;
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

  // Zoom and pan. Sticky per view, so a slider tick after a zoom renders the same window;
  // the next render rebuilds the proxy's base from the full-res texture at the new scale.
  void set_viewport(uint32_t view_id, const Viewport& viewport);
  Viewport view_viewport(uint32_t view_id) const;
  // The geometry stage as the last render resolved it. `image_to_view` is what goes on the
  // wire as `imageTransform`, and is how the UI converts a pointer into a mask coordinate.
  GeometryMap view_map(uint32_t view_id) const;

  // Renders the stack into the view and writes width*height*4 rgba8 bytes into
  // `out` starting at `offset`. `out` must already be large enough. `bypass_crop` drops
  // the crop op's rect and straighten angle for this frame — the whole image, letterboxed
  // as usual — which is what the crop tool draws its overlay on; rotate, flip and
  // Transform still apply because they move the whole image (protocol view.render
  // `geometry: "full"`).
  RenderTiming render(uint32_t view_id, const Stack& stack, std::vector<uint8_t>& out,
                      size_t offset, bool bypass_crop = false);

  // An AI component's raster: mask.detect's output, or the PNG cache reloaded when the
  // photo was opened. Held per photo and resampled into whatever size a view needs, so it
  // survives a resize and every view shares one copy.
  void put_mask_raster(int64_t photo_id, std::string_view component_id, std::string_view hash,
                       GrayImage raster);
  bool has_mask_raster(int64_t photo_id, std::string_view component_id,
                       std::string_view hash) const;

  // The photo's depth map (ai/depth.h): what `relight` shades against, and what a `depth`
  // mask component bands. One per photo, not per op — it describes the scene, so no slider
  // can make it stale — and held and uploaded at the model's own size, 16-bit, with the
  // shader filtering it. `key` names the file it came from and changes with the pixels.
  void put_depth_map(int64_t photo_id, std::string_view key, Gray16Image map);
  bool has_depth_map(int64_t photo_id) const;
  std::string depth_map_key(int64_t photo_id) const;

  // A generative op's cached raster (PROMPT.md 3.5): the crop a backend repainted, held per
  // photo and uploaded once. `key` is the op's `result` path, which changes whenever the
  // pixels do, so a stale upload cannot outlive them. An op whose result the renderer has
  // not been handed composites nothing and renders as if it were not there.
  void put_generative_result(int64_t photo_id, std::string_view op_id, std::string_view key,
                             const Rgb8Image& image);
  bool has_generative_result(int64_t photo_id, std::string_view op_id, std::string_view key) const;

  // Renders the stack into the view — which builds any mask it needs — then reads one r8
  // mask back into `out`: `op_id`'s combined mask, or one component's raster when
  // `component_id` is not empty. Throws if either is unknown.
  MaskReadout read_mask(uint32_t view_id, const Stack& stack, std::string_view op_id,
                        std::string_view component_id, std::vector<uint8_t>& out, size_t offset);

  // export.run's render: the same op chain as the preview, run once at the photo's native
  // resolution — masks included, rasterised at full res — then resized in linear light,
  // output-sharpened and converted into the target colour space. Blocks the calling thread
  // for the whole thing; it is the server thread, because that thread owns the device.
  //
  // One texture, never tiled: a 24 MP frame is far inside `maxTextureDimension2D` (32768
  // on this adapter). A photo whose cropped size exceeds that limit throws instead — a
  // tiled fallback would need the neighbourhood passes to overlap their tiles and is
  // deliberately out of scope (issue #4).
  Rgb16Image render_export(int64_t photo_id, const Stack& stack,
                           const ExportRenderOptions& options);

 private:
  struct Photo;
  struct View;
  struct Pass;

  View& view_for(uint32_t view_id);
  void build_base(View& view);
  // Runs the op chain into the view's ping-pong textures and returns the texture the last
  // pass wrote (the base when the stack had nothing to do).
  WGPUTextureView run_passes(View& view, const Stack& stack, bool bypass_crop);
  // Rasterises and folds one op's mask into a cached r8 texture. Luminance and colour
  // components sample the view's base, so it runs before the op chain is encoded.
  void build_mask(View& view, const Op& op, const nlohmann::json& canonical,
                  const std::string& hash);
  // The second ping-pong pair, the one a group's children render into so the group's input
  // survives to be blended against. Made on the first frame that holds a group and resized
  // with the view; a stack without groups never pays for it.
  void ensure_branch(View& view);
  void ensure_wavelet(View& view);
  // Uploads the photo's depth map into the view at the size an image-space raster has
  // there, if it is not already the one on the GPU. Before any encoder is open: a queue
  // write between two render passes of the same encoder is not ordered against them.
  void ensure_depth(View& view);

  Gpu gpu_;
  RenderPipelineHandle linearize_pipeline_;
  RenderPipelineHandle downscale_pipeline_;
  RenderPipelineHandle ops_pipeline_;
  RenderPipelineHandle blur_pipeline_;
  RenderPipelineHandle neighborhood_pipeline_;
  RenderPipelineHandle display_pipeline_;
  RenderPipelineHandle mask_pipeline_;
  RenderPipelineHandle mask_combine_pipeline_;
  RenderPipelineHandle composite_pipeline_;
  RenderPipelineHandle blend_pipeline_;
  RenderPipelineHandle relight_pipeline_;
  // Built on the first export: nothing else writes rgba16uint, and a daemon that never
  // exports should not pay for the pipeline.
  RenderPipelineHandle export_pipeline_;
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
