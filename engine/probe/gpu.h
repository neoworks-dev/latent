// Minimal synchronous wrapper over webgpu.h (wgpu-native) for the probes.
// Everything here blocks; the real engine will own an event loop instead.
#pragma once

#include <cstdint>

#include <string>
#include <string_view>
#include <vector>

#include <webgpu/webgpu.h>
#include <webgpu/wgpu.h>

namespace probe {

struct Gpu {
  WGPUInstance instance = nullptr;
  WGPUAdapter adapter = nullptr;
  WGPUDevice device = nullptr;
  WGPUQueue queue = nullptr;
  WGPULimits adapter_limits{};
  WGPULimits device_limits{};
  WGPUAdapterInfo info{};
  bool has_f16 = false;
  bool has_float32_filterable = false;
  // Set by the uncaptured-error callback; probes check it after every submit.
  std::string last_error;
};

// Requests a high-performance Vulkan adapter and a device with
// maxTextureDimension2D >= requested_texture_dim and shader-f16 if available.
Gpu create_gpu(uint32_t requested_texture_dim);
void destroy_gpu(Gpu& gpu);
void print_gpu_report(const Gpu& gpu);

WGPUTexture create_texture(const Gpu& gpu, uint32_t width, uint32_t height,
                           WGPUTextureFormat format, WGPUTextureUsage usage, const char* label);

WGPUShaderModule create_shader(const Gpu& gpu, std::string_view wgsl, const char* label);

// Fullscreen-triangle pipeline: vertex entry `vs`, fragment entry `fs`, one colour target.
// Bind group layout is inferred from the shader (layout = auto).
WGPURenderPipeline create_fullscreen_pipeline(const Gpu& gpu, WGPUShaderModule shader,
                                              WGPUTextureFormat target_format, const char* label);

// Runs one fullscreen pass writing into `target` with `bind_group` at group 0.
void run_fullscreen_pass(const Gpu& gpu, WGPURenderPipeline pipeline, WGPUBindGroup bind_group,
                         WGPUTextureView target);

// Blocking readback of a whole 2D texture. Returns tightly packed rows.
std::vector<uint8_t> read_texture(const Gpu& gpu, WGPUTexture texture, uint32_t width,
                                  uint32_t height, uint32_t bytes_per_pixel);

// Blocks until all submitted GPU work has completed.
void wait_idle(const Gpu& gpu);

inline WGPUStringView sv(const char* text) {
  return WGPUStringView{text, WGPU_STRLEN};
}

}  // namespace probe
