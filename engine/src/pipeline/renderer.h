// The pass chain. One full-res linear texture per open photo; per view a proxy-sized
// base texture (rendered once per size change), two ping-pong rgba16float textures the
// op passes bounce between, and one rgba8 output that gets read back per frame.
#pragma once

#include "gpu/gpu.h"
#include "ops/op.h"
#include "raw/raw_decode.h"

#include <cstdint>

#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace latent {

// Must match the `kind` switch in engine/shaders/ops.wgsl.
enum class OpKind : uint32_t {
  None = 0,
  WhiteBalance = 1,
  Exposure = 2,
  Contrast = 3,
  Highlights = 4,
  Shadows = 5,
  Whites = 6,
  Blacks = 7,
  Saturation = 8,
  Vibrance = 9,
};

OpKind op_kind(std::string_view name);

struct RenderTiming {
  double render_ms = 0;
  double readback_ms = 0;
};

struct ViewGeometry {
  uint32_t width = 0;
  uint32_t height = 0;
  // The letterboxed image rect inside the view, in pixels.
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

  void load_photo(uint32_t photo_id, const DecodedRaw& raw);
  void unload_photo(uint32_t photo_id);
  bool has_photo(uint32_t photo_id) const;

  void open_view(uint32_t view_id, uint32_t photo_id, uint32_t width, uint32_t height);
  void close_view(uint32_t view_id);
  void close_views_of_photo(uint32_t photo_id);
  bool has_view(uint32_t view_id) const;
  uint32_t view_photo(uint32_t view_id) const;
  ViewGeometry view_geometry(uint32_t view_id) const;
  void resize_view(uint32_t view_id, uint32_t width, uint32_t height);

  // Renders the stack into the view and writes width*height*4 rgba8 bytes into
  // `out` starting at `offset`. `out` must already be large enough.
  RenderTiming render(uint32_t view_id, const Stack& stack, std::vector<uint8_t>& out,
                      size_t offset);

 private:
  struct Photo;
  struct View;

  View& view_for(uint32_t view_id);
  void build_base(View& view);

  Gpu gpu_;
  RenderPipelineHandle linearize_pipeline_;
  RenderPipelineHandle downscale_pipeline_;
  RenderPipelineHandle ops_pipeline_;
  RenderPipelineHandle display_pipeline_;
  std::unordered_map<uint32_t, std::unique_ptr<Photo>> photos_;
  std::unordered_map<uint32_t, std::unique_ptr<View>> views_;
};

}  // namespace latent
