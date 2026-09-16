// Synchronous wrapper over webgpu.h (wgpu-native), graduated from engine/probe/gpu.*.
// Phase 0 runs the GPU on the server thread: every call here blocks until the device is
// idle, which is fine at proxy resolution and keeps the op pipeline readable.
#pragma once

#include <cstdint>

#include <span>
#include <string>
#include <string_view>

#include <webgpu/webgpu.h>
#include <webgpu/wgpu.h>

namespace latent {

// RAII for the wgpu C handles. Every handle in the engine is owned by one of these.
template <typename Handle, void (*Release)(Handle)>
class GpuHandle {
 public:
  GpuHandle() = default;
  explicit GpuHandle(Handle handle) : handle_(handle) {}
  ~GpuHandle() { reset(); }
  GpuHandle(const GpuHandle&) = delete;
  GpuHandle& operator=(const GpuHandle&) = delete;
  GpuHandle(GpuHandle&& other) noexcept : handle_(other.handle_) { other.handle_ = nullptr; }
  GpuHandle& operator=(GpuHandle&& other) noexcept {
    if (this == &other) return *this;
    reset(other.handle_);
    other.handle_ = nullptr;
    return *this;
  }

  Handle get() const { return handle_; }
  explicit operator bool() const { return handle_ != nullptr; }
  void reset(Handle next = nullptr) {
    if (handle_ != nullptr) Release(handle_);
    handle_ = next;
  }

 private:
  Handle handle_ = nullptr;
};

using TextureHandle = GpuHandle<WGPUTexture, wgpuTextureRelease>;
using TextureViewHandle = GpuHandle<WGPUTextureView, wgpuTextureViewRelease>;
using BufferHandle = GpuHandle<WGPUBuffer, wgpuBufferRelease>;
using BindGroupHandle = GpuHandle<WGPUBindGroup, wgpuBindGroupRelease>;
using ShaderModuleHandle = GpuHandle<WGPUShaderModule, wgpuShaderModuleRelease>;
using RenderPipelineHandle = GpuHandle<WGPURenderPipeline, wgpuRenderPipelineRelease>;

struct GpuReport {
  std::string adapter;
  uint32_t max_texture_dimension_2d = 0;
  uint64_t max_buffer_size = 0;
  bool shader_f16 = false;
};

class Gpu {
 public:
  // Throws std::runtime_error when no adapter meets `requested_texture_dim`.
  explicit Gpu(uint32_t requested_texture_dim);
  ~Gpu();
  Gpu(const Gpu&) = delete;
  Gpu& operator=(const Gpu&) = delete;

  const GpuReport& report() const { return report_; }
  WGPUDevice device() const { return device_; }
  WGPUQueue queue() const { return queue_; }

  TextureHandle create_texture(uint32_t width, uint32_t height, WGPUTextureFormat format,
                               WGPUTextureUsage usage, const char* label) const;
  ShaderModuleHandle create_shader(std::string_view wgsl, const char* label) const;
  RenderPipelineHandle create_fullscreen_pipeline(WGPUShaderModule shader,
                                                  WGPUTextureFormat target_format,
                                                  const char* label) const;
  BufferHandle create_uniform_buffer(uint64_t size, const char* label) const;
  BindGroupHandle create_bind_group(WGPURenderPipeline pipeline,
                                    std::span<const WGPUBindGroupEntry> entries) const;

  void write_buffer(WGPUBuffer buffer, uint64_t offset, const void* data, size_t size) const;
  void write_texture(WGPUTexture texture, uint32_t width, uint32_t height, uint32_t bytes_per_pixel,
                     const void* data, size_t size) const;

  WGPUCommandEncoder begin_commands(const char* label) const;
  void encode_fullscreen_pass(WGPUCommandEncoder encoder, WGPURenderPipeline pipeline,
                              WGPUBindGroup bind_group, WGPUTextureView target) const;
  void submit(WGPUCommandEncoder encoder) const;
  void wait_idle() const;

  // Blocking copyTextureToBuffer + map. `out` must hold width*height*bytes_per_pixel.
  void read_texture(WGPUTexture texture, uint32_t width, uint32_t height, uint32_t bytes_per_pixel,
                    std::span<uint8_t> out) const;

  // Set by the uncaptured-error callback; non-empty means the last submit was rejected.
  const std::string& last_error() const { return last_error_; }

  // Throws and clears if the device rejected anything since the last call. Call it after
  // wait_idle, so a bad pass surfaces as an RPC error instead of a black frame.
  void raise_pending_error();

 private:
  WGPUInstance instance_ = nullptr;
  WGPUAdapter adapter_ = nullptr;
  WGPUDevice device_ = nullptr;
  WGPUQueue queue_ = nullptr;
  WGPUAdapterInfo info_{};
  GpuReport report_;
  std::string last_error_;
};

inline WGPUStringView gpu_string(const char* text) {
  return WGPUStringView{text, WGPU_STRLEN};
}

}  // namespace latent
