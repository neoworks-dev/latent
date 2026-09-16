#include "pipeline/renderer.h"

#include <chrono>
#include <cmath>
#include <latent_shaders.h>

#include <algorithm>
#include <array>
#include <stdexcept>

namespace latent {

namespace {

// Uniform buffer bindings must start on a 256-byte boundary, so each op pass gets a
// 256-byte slot in one buffer and the whole stack is uploaded in a single write.
constexpr uint64_t kOpUniformStride = 256;

struct OpUniform {
  float a[4] = {0, 0, 0, 0};
  uint32_t kind = 0;
  uint32_t pad[3] = {0, 0, 0};
};
static_assert(sizeof(OpUniform) == 32, "must match OpParams in ops.wgsl");

struct FitUniform {
  float scale[2] = {1, 1};
  float offset[2] = {0, 0};
  float taps[2] = {1, 1};
  float size[2] = {1, 1};
};
static_assert(sizeof(FitUniform) == 32, "must match Fit in downscale.wgsl");

struct FrameUniform {
  float content_min[2] = {0, 0};
  float content_max[2] = {0, 0};
};
static_assert(sizeof(FrameUniform) == 16, "must match Frame in display.wgsl");

double param(const Op& op, const char* name) {
  const auto found = op.params.find(name);
  if (found == op.params.end() || !found->is_number()) return 0.0;
  return found->get<double>();
}

OpUniform op_uniform(const Op& op, OpKind kind) {
  OpUniform uniform;
  uniform.kind = static_cast<uint32_t>(kind);
  if (kind == OpKind::WhiteBalance) {
    // Relative to the camera's as-shot white balance: 0 is neutral, +-100 is about
    // +-half a stop of red/blue split. Not Lightroom's Kelvin scale.
    const float temperature = static_cast<float>(param(op, "temperature") / 100.0);
    const float tint = static_cast<float>(param(op, "tint") / 100.0);
    uniform.a[0] = std::exp2(0.5F * temperature + 0.15F * tint);
    uniform.a[1] = std::exp2(-0.3F * tint);
    uniform.a[2] = std::exp2(-0.5F * temperature + 0.15F * tint);
    return uniform;
  }
  const double value = param(op, "value");
  uniform.a[0] = static_cast<float>(kind == OpKind::Exposure ? value : value / 100.0);
  return uniform;
}

WGPUBindGroupEntry texture_entry(uint32_t binding, WGPUTextureView view) {
  WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
  entry.binding = binding;
  entry.textureView = view;
  return entry;
}

WGPUBindGroupEntry buffer_entry(uint32_t binding, WGPUBuffer buffer, uint64_t offset,
                                uint64_t size) {
  WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
  entry.binding = binding;
  entry.buffer = buffer;
  entry.offset = offset;
  entry.size = size;
  return entry;
}

}  // namespace

OpKind op_kind(std::string_view name) {
  if (name == "white_balance") return OpKind::WhiteBalance;
  if (name == "exposure") return OpKind::Exposure;
  if (name == "contrast") return OpKind::Contrast;
  if (name == "highlights") return OpKind::Highlights;
  if (name == "shadows") return OpKind::Shadows;
  if (name == "whites") return OpKind::Whites;
  if (name == "blacks") return OpKind::Blacks;
  if (name == "saturation") return OpKind::Saturation;
  if (name == "vibrance") return OpKind::Vibrance;
  return OpKind::None;
}

struct Renderer::Photo {
  uint32_t width = 0;
  uint32_t height = 0;
  TextureHandle linear;
  TextureViewHandle linear_view;
};

struct Renderer::View {
  uint32_t photo_id = 0;
  ViewGeometry geometry;
  bool base_valid = false;
  TextureHandle base;
  TextureViewHandle base_view;
  TextureHandle ping[2];
  TextureViewHandle ping_view[2];
  TextureHandle output;
  TextureViewHandle output_view;
  BufferHandle fit_uniform;
  BufferHandle frame_uniform;
  BufferHandle op_uniforms;
  uint32_t op_capacity = 0;
};

Renderer::Renderer(uint32_t max_texture_dim) : gpu_(max_texture_dim) {
  const ShaderModuleHandle linearize = gpu_.create_shader(shaders::kLinearize, "linearize");
  const ShaderModuleHandle downscale = gpu_.create_shader(shaders::kDownscale, "downscale");
  const ShaderModuleHandle ops = gpu_.create_shader(shaders::kOps, "ops");
  const ShaderModuleHandle display = gpu_.create_shader(shaders::kDisplay, "display");
  linearize_pipeline_ =
      gpu_.create_fullscreen_pipeline(linearize.get(), WGPUTextureFormat_RGBA16Float, "linearize");
  downscale_pipeline_ =
      gpu_.create_fullscreen_pipeline(downscale.get(), WGPUTextureFormat_RGBA16Float, "downscale");
  ops_pipeline_ = gpu_.create_fullscreen_pipeline(ops.get(), WGPUTextureFormat_RGBA16Float, "ops");
  display_pipeline_ =
      gpu_.create_fullscreen_pipeline(display.get(), WGPUTextureFormat_RGBA8Unorm, "display");
}

Renderer::~Renderer() {
  views_.clear();
  photos_.clear();
}

void Renderer::load_photo(uint32_t photo_id, const DecodedRaw& raw) {
  auto photo = std::make_unique<Photo>();
  photo->width = raw.width;
  photo->height = raw.height;

  const TextureHandle camera = gpu_.create_texture(
      raw.width, raw.height, WGPUTextureFormat_RGBA16Uint,
      static_cast<WGPUTextureUsage>(WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst),
      "camera-rgba16uint");
  gpu_.write_texture(camera.get(), raw.width, raw.height, 8, raw.rgba.data(), raw.rgba.size() * 2);
  const TextureViewHandle camera_view(wgpuTextureCreateView(camera.get(), nullptr));

  photo->linear =
      gpu_.create_texture(raw.width, raw.height, WGPUTextureFormat_RGBA16Float,
                          static_cast<WGPUTextureUsage>(WGPUTextureUsage_RenderAttachment |
                                                        WGPUTextureUsage_TextureBinding),
                          "linear-rgba16float");
  photo->linear_view.reset(wgpuTextureCreateView(photo->linear.get(), nullptr));

  const std::array<WGPUBindGroupEntry, 1> entries = {texture_entry(0, camera_view.get())};
  const BindGroupHandle bind_group = gpu_.create_bind_group(linearize_pipeline_.get(), entries);
  WGPUCommandEncoder encoder = gpu_.begin_commands("linearize");
  gpu_.encode_fullscreen_pass(encoder, linearize_pipeline_.get(), bind_group.get(),
                              photo->linear_view.get());
  gpu_.submit(encoder);
  gpu_.wait_idle();
  gpu_.raise_pending_error();

  photos_[photo_id] = std::move(photo);
}

void Renderer::unload_photo(uint32_t photo_id) {
  close_views_of_photo(photo_id);
  photos_.erase(photo_id);
}

bool Renderer::has_photo(uint32_t photo_id) const {
  return photos_.contains(photo_id);
}

void Renderer::open_view(uint32_t view_id, uint32_t photo_id, uint32_t width, uint32_t height) {
  if (!photos_.contains(photo_id)) throw std::runtime_error("view.open on an unknown photo");
  auto view = std::make_unique<View>();
  view->photo_id = photo_id;
  view->fit_uniform = gpu_.create_uniform_buffer(sizeof(FitUniform), "fit");
  view->frame_uniform = gpu_.create_uniform_buffer(sizeof(FrameUniform), "frame");
  views_[view_id] = std::move(view);
  resize_view(view_id, width, height);
}

void Renderer::close_view(uint32_t view_id) {
  views_.erase(view_id);
}

void Renderer::close_views_of_photo(uint32_t photo_id) {
  for (auto entry = views_.begin(); entry != views_.end();) {
    if (entry->second->photo_id != photo_id) {
      ++entry;
    } else {
      entry = views_.erase(entry);
    }
  }
}

bool Renderer::has_view(uint32_t view_id) const {
  return views_.contains(view_id);
}

uint32_t Renderer::view_photo(uint32_t view_id) const {
  return views_.at(view_id)->photo_id;
}

ViewGeometry Renderer::view_geometry(uint32_t view_id) const {
  return views_.at(view_id)->geometry;
}

Renderer::View& Renderer::view_for(uint32_t view_id) {
  const auto found = views_.find(view_id);
  if (found == views_.end()) throw std::runtime_error("unknown viewId");
  return *found->second;
}

void Renderer::resize_view(uint32_t view_id, uint32_t width, uint32_t height) {
  View& view = view_for(view_id);
  if (view.geometry.width == width && view.geometry.height == height && view.base_valid) return;
  const uint32_t limit = gpu_.report().max_texture_dimension_2d;
  if (width == 0 || height == 0 || width > limit || height > limit) {
    throw std::runtime_error("view size out of range");
  }

  view.geometry.width = width;
  view.geometry.height = height;
  const auto usage = static_cast<WGPUTextureUsage>(WGPUTextureUsage_RenderAttachment |
                                                   WGPUTextureUsage_TextureBinding);
  view.base = gpu_.create_texture(width, height, WGPUTextureFormat_RGBA16Float, usage, "view-base");
  view.base_view.reset(wgpuTextureCreateView(view.base.get(), nullptr));
  for (int i = 0; i < 2; ++i) {
    view.ping[i] =
        gpu_.create_texture(width, height, WGPUTextureFormat_RGBA16Float, usage, "view-ping");
    view.ping_view[i].reset(wgpuTextureCreateView(view.ping[i].get(), nullptr));
  }
  view.output = gpu_.create_texture(
      width, height, WGPUTextureFormat_RGBA8Unorm,
      static_cast<WGPUTextureUsage>(WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc),
      "view-output");
  view.output_view.reset(wgpuTextureCreateView(view.output.get(), nullptr));
  view.base_valid = false;
  build_base(view);
}

void Renderer::build_base(View& view) {
  const Photo& photo = *photos_.at(view.photo_id);
  const double photo_aspect = static_cast<double>(photo.width) / photo.height;
  ViewGeometry& geometry = view.geometry;
  geometry.content_width = geometry.width;
  geometry.content_height =
      std::max(1U, static_cast<uint32_t>(std::lround(geometry.width / photo_aspect)));
  if (geometry.content_height > geometry.height) {
    geometry.content_height = geometry.height;
    geometry.content_width =
        std::max(1U, static_cast<uint32_t>(std::lround(geometry.height * photo_aspect)));
  }
  geometry.content_width = std::min(geometry.content_width, geometry.width);
  geometry.content_x = (geometry.width - geometry.content_width) / 2;
  geometry.content_y = (geometry.height - geometry.content_height) / 2;

  FitUniform fit;
  fit.scale[0] = static_cast<float>(static_cast<double>(photo.width) / geometry.content_width);
  fit.scale[1] = static_cast<float>(static_cast<double>(photo.height) / geometry.content_height);
  fit.offset[0] = -static_cast<float>(geometry.content_x) * fit.scale[0];
  fit.offset[1] = -static_cast<float>(geometry.content_y) * fit.scale[1];
  fit.taps[0] = std::clamp(std::floor(fit.scale[0]), 1.0F, 16.0F);
  fit.taps[1] = std::clamp(std::floor(fit.scale[1]), 1.0F, 16.0F);
  fit.size[0] = static_cast<float>(photo.width);
  fit.size[1] = static_cast<float>(photo.height);
  gpu_.write_buffer(view.fit_uniform.get(), 0, &fit, sizeof(fit));

  FrameUniform frame;
  frame.content_min[0] = static_cast<float>(geometry.content_x);
  frame.content_min[1] = static_cast<float>(geometry.content_y);
  frame.content_max[0] = static_cast<float>(geometry.content_x + geometry.content_width);
  frame.content_max[1] = static_cast<float>(geometry.content_y + geometry.content_height);
  gpu_.write_buffer(view.frame_uniform.get(), 0, &frame, sizeof(frame));

  const std::array<WGPUBindGroupEntry, 2> entries = {
      texture_entry(0, photo.linear_view.get()),
      buffer_entry(1, view.fit_uniform.get(), 0, sizeof(FitUniform))};
  const BindGroupHandle bind_group = gpu_.create_bind_group(downscale_pipeline_.get(), entries);
  WGPUCommandEncoder encoder = gpu_.begin_commands("downscale");
  gpu_.encode_fullscreen_pass(encoder, downscale_pipeline_.get(), bind_group.get(),
                              view.base_view.get());
  gpu_.submit(encoder);
  gpu_.wait_idle();
  gpu_.raise_pending_error();
  view.base_valid = true;
}

RenderTiming Renderer::render(uint32_t view_id, const Stack& stack, std::vector<uint8_t>& out,
                              size_t offset) {
  using clock = std::chrono::steady_clock;
  View& view = view_for(view_id);
  if (!view.base_valid) build_base(view);

  std::vector<OpUniform> uniforms;
  for (const Op& op : stack) {
    const OpKind kind = op_kind(op.name);
    if (!op.enabled || kind == OpKind::None) continue;
    uniforms.push_back(op_uniform(op, kind));
  }
  if (view.op_capacity < uniforms.size()) {
    view.op_uniforms =
        gpu_.create_uniform_buffer(kOpUniformStride * std::max<size_t>(uniforms.size(), 1), "ops");
    view.op_capacity = static_cast<uint32_t>(uniforms.size());
  }
  for (size_t i = 0; i < uniforms.size(); ++i) {
    gpu_.write_buffer(view.op_uniforms.get(), kOpUniformStride * i, &uniforms[i],
                      sizeof(OpUniform));
  }

  const auto started = clock::now();
  std::vector<BindGroupHandle> bind_groups;
  WGPUCommandEncoder encoder = gpu_.begin_commands("view-render");
  WGPUTextureView source = view.base_view.get();
  for (size_t i = 0; i < uniforms.size(); ++i) {
    const std::array<WGPUBindGroupEntry, 2> entries = {
        texture_entry(0, source),
        buffer_entry(1, view.op_uniforms.get(), kOpUniformStride * i, sizeof(OpUniform))};
    bind_groups.push_back(gpu_.create_bind_group(ops_pipeline_.get(), entries));
    WGPUTextureView target = view.ping_view[i % 2].get();
    gpu_.encode_fullscreen_pass(encoder, ops_pipeline_.get(), bind_groups.back().get(), target);
    source = target;
  }
  const std::array<WGPUBindGroupEntry, 2> display_entries = {
      texture_entry(0, source), buffer_entry(1, view.frame_uniform.get(), 0, sizeof(FrameUniform))};
  bind_groups.push_back(gpu_.create_bind_group(display_pipeline_.get(), display_entries));
  gpu_.encode_fullscreen_pass(encoder, display_pipeline_.get(), bind_groups.back().get(),
                              view.output_view.get());
  gpu_.submit(encoder);
  gpu_.wait_idle();
  gpu_.raise_pending_error();
  const auto rendered = clock::now();

  const size_t bytes = static_cast<size_t>(view.geometry.width) * view.geometry.height * 4;
  if (out.size() < offset + bytes) throw std::runtime_error("frame buffer too small");
  gpu_.read_texture(view.output.get(), view.geometry.width, view.geometry.height, 4,
                    std::span<uint8_t>(out.data() + offset, bytes));
  const auto read = clock::now();

  RenderTiming timing;
  timing.render_ms = std::chrono::duration<double, std::milli>(rendered - started).count();
  timing.readback_ms = std::chrono::duration<double, std::milli>(read - rendered).count();
  return timing;
}

}  // namespace latent
