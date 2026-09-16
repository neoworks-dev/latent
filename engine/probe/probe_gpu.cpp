// PROMPT.md section 8, step 1: adapter/device report, two 8256x5504 rgba16float
// textures, one ping-pong pass, readback, no device loss.
#include "gpu.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>

#include <exception>

namespace {

constexpr uint32_t kWidth = 8256;  // Nikon Z8
constexpr uint32_t kHeight = 5504;

// Writes a gradient into A, then B = A * 0.5 + 0.25 through a sampled pass.
constexpr const char* kFillWgsl = R"(
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  out.uv = vec2f(p[i].x * 0.5 + 0.5, 1.0 - (p[i].y * 0.5 + 0.5));
  return out;
}
@fragment fn fs(in: VSOut) -> @location(0) vec4f { return vec4f(in.uv, 0.5, 1.0); }
)";

constexpr const char* kPingPongWgsl = R"(
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  out.uv = vec2f(p[i].x * 0.5 + 0.5, 1.0 - (p[i].y * 0.5 + 0.5));
  return out;
}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  return textureSample(src, samp, in.uv) * 0.5 + vec4f(0.25);
}
)";

float half_to_float(uint16_t h) {
  const uint32_t sign = (h >> 15) & 1;
  const uint32_t exponent = (h >> 10) & 0x1f;
  const uint32_t mantissa = h & 0x3ff;
  float value;
  if (exponent == 0) {
    value = std::ldexp(static_cast<float>(mantissa), -24);
  } else if (exponent == 31) {
    value = mantissa ? NAN : INFINITY;
  } else {
    value = std::ldexp(static_cast<float>(mantissa | 0x400), static_cast<int>(exponent) - 25);
  }
  return sign ? -value : value;
}

}  // namespace

int main() {
  using clock = std::chrono::steady_clock;
  try {
    auto t0 = clock::now();
    probe::Gpu gpu = probe::create_gpu(16384);
    auto t1 = clock::now();
    probe::print_gpu_report(gpu);
    std::printf("device ready in       %.1f ms\n",
                std::chrono::duration<double, std::milli>(t1 - t0).count());

    const WGPUTextureUsage usage = WGPUTextureUsage_RenderAttachment |
                                   WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc;
    WGPUTexture a =
        probe::create_texture(gpu, kWidth, kHeight, WGPUTextureFormat_RGBA16Float, usage, "ping");
    WGPUTexture b =
        probe::create_texture(gpu, kWidth, kHeight, WGPUTextureFormat_RGBA16Float, usage, "pong");
    WGPUTextureView view_a = wgpuTextureCreateView(a, nullptr);
    WGPUTextureView view_b = wgpuTextureCreateView(b, nullptr);
    std::printf("allocated 2x %ux%u rgba16float = %.0f MB\n", kWidth, kHeight,
                2.0 * kWidth * kHeight * 8 / 1e6);

    WGPUShaderModule fill_shader = probe::create_shader(gpu, kFillWgsl, "fill");
    WGPURenderPipeline fill =
        probe::create_fullscreen_pipeline(gpu, fill_shader, WGPUTextureFormat_RGBA16Float, "fill");
    probe::run_fullscreen_pass(gpu, fill, nullptr, view_a);

    WGPUShaderModule pp_shader = probe::create_shader(gpu, kPingPongWgsl, "pingpong");
    WGPURenderPipeline pingpong = probe::create_fullscreen_pipeline(
        gpu, pp_shader, WGPUTextureFormat_RGBA16Float, "pingpong");

    WGPUSamplerDescriptor sampler_descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
    sampler_descriptor.magFilter = WGPUFilterMode_Linear;
    sampler_descriptor.minFilter = WGPUFilterMode_Linear;
    WGPUSampler sampler = wgpuDeviceCreateSampler(gpu.device, &sampler_descriptor);

    WGPUBindGroupEntry entries[2] = {WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT};
    entries[0].binding = 0;
    entries[0].textureView = view_a;
    entries[1].binding = 1;
    entries[1].sampler = sampler;
    WGPUBindGroupDescriptor bind_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bind_descriptor.layout = wgpuRenderPipelineGetBindGroupLayout(pingpong, 0);
    bind_descriptor.entryCount = 2;
    bind_descriptor.entries = entries;
    WGPUBindGroup bind_group = wgpuDeviceCreateBindGroup(gpu.device, &bind_descriptor);

    probe::wait_idle(gpu);
    auto t2 = clock::now();
    constexpr int kIterations = 20;
    for (int i = 0; i < kIterations; ++i)
      probe::run_fullscreen_pass(gpu, pingpong, bind_group, view_b);
    probe::wait_idle(gpu);
    auto t3 = clock::now();
    std::printf("full-res pass         %.2f ms avg over %d (A -> B, sampled)\n",
                std::chrono::duration<double, std::milli>(t3 - t2).count() / kIterations,
                kIterations);

    auto t4 = clock::now();
    std::vector<uint8_t> pixels = probe::read_texture(gpu, b, kWidth, kHeight, 8);
    auto t5 = clock::now();
    std::printf("full-res readback     %.1f ms (%zu MB)\n",
                std::chrono::duration<double, std::milli>(t5 - t4).count(),
                pixels.size() / 1000000);

    // Centre pixel: uv = (0.5, 0.5) -> A = (0.5, 0.5, 0.5, 1) -> B = (0.5, 0.5, 0.5, 0.75).
    const size_t centre = (static_cast<size_t>(kHeight / 2) * kWidth + kWidth / 2) * 8;
    uint16_t halves[4];
    std::memcpy(halves, pixels.data() + centre, 8);
    std::printf("centre pixel          %.3f %.3f %.3f %.3f (expect 0.5 0.5 0.5 0.75)\n",
                half_to_float(halves[0]), half_to_float(halves[1]), half_to_float(halves[2]),
                half_to_float(halves[3]));

    const bool centre_ok = std::fabs(half_to_float(halves[0]) - 0.5f) < 0.01f &&
                           std::fabs(half_to_float(halves[3]) - 0.75f) < 0.01f;
    std::printf("uncaptured errors     %s\n",
                gpu.last_error.empty() ? "none" : gpu.last_error.c_str());
    std::printf("RESULT                %s\n",
                centre_ok && gpu.last_error.empty() ? "PASS" : "FAIL");

    wgpuBindGroupRelease(bind_group);
    wgpuSamplerRelease(sampler);
    wgpuRenderPipelineRelease(pingpong);
    wgpuRenderPipelineRelease(fill);
    wgpuShaderModuleRelease(pp_shader);
    wgpuShaderModuleRelease(fill_shader);
    wgpuTextureViewRelease(view_b);
    wgpuTextureViewRelease(view_a);
    wgpuTextureRelease(b);
    wgpuTextureRelease(a);
    probe::destroy_gpu(gpu);
    return centre_ok ? 0 : 1;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "probe_gpu failed: %s\n", error.what());
    return 2;
  }
}
