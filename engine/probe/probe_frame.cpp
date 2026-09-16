// PROMPT.md section 8, step 3: the frame path. Decode a raw, upload it, render a
// viewport-sized proxy with an exposure uniform, read it back as rgba8 and push it
// over a WebSocket. The client sends {"exposure": x} per "slider tick" and measures
// round-trip latency. One connection, one in-flight render, everything on the loop thread.
#include "gpu.h"
#include "raw_decode.h"

#include <chrono>
#include <cstdio>
#include <cstring>

#include <exception>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>
#include <uwebsockets/App.h>

namespace {

constexpr uint32_t kProxyWidth = 2560;
constexpr uint32_t kProxyHeight = 1440;
constexpr int kPort = 7788;

// Pass 1: rgba16uint camera data -> linear rgba16float, scaled to [0,1].
constexpr const char* kLinearizeWgsl = R"(
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  out.uv = vec2f(p[i].x * 0.5 + 0.5, 1.0 - (p[i].y * 0.5 + 0.5));
  return out;
}
@group(0) @binding(0) var src: texture_2d<u32>;
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(src));
  let texel = textureLoad(src, vec2i(in.uv * dims), 0);
  return vec4f(texel) / 65535.0;
}
)";

// Pass 2: sample the linear image into the proxy, apply exposure, sRGB OETF, rgba8 out.
constexpr const char* kProxyWgsl = R"(
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[i], 0.0, 1.0);
  out.uv = vec2f(p[i].x * 0.5 + 0.5, 1.0 - (p[i].y * 0.5 + 0.5));
  return out;
}
struct Params { aspect_fit: vec2f, exposure: f32, _pad: f32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: Params;
fn oetf(c: f32) -> f32 {
  if (c <= 0.0031308) { return 12.92 * c; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  // Letterbox: map proxy uv into the image's aspect.
  let uv = (in.uv - 0.5) * params.aspect_fit + 0.5;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return vec4f(0.08, 0.08, 0.09, 1.0); }
  let lin = textureSample(src, samp, uv).rgb * exp2(params.exposure);
  let c = clamp(lin, vec3f(0.0), vec3f(1.0));
  return vec4f(oetf(c.r), oetf(c.g), oetf(c.b), 1.0);
}
)";

// Mirrors the WGSL Params: vec2f first so the struct is 16 bytes on both sides.
struct Params {
  float aspect_fit[2];
  float exposure;
  float pad;
};

struct Renderer {
  probe::Gpu gpu;
  WGPUTexture linear = nullptr;
  WGPUTexture proxy = nullptr;
  WGPUTextureView proxy_view = nullptr;
  WGPURenderPipeline proxy_pipeline = nullptr;
  WGPUBindGroup proxy_bind_group = nullptr;
  WGPUBuffer params_buffer = nullptr;
  Params params{};
  uint32_t seq = 0;

  void upload_and_linearize(const probe::DecodedRaw& raw) {
    const WGPUTextureUsage bind_copy = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    WGPUTexture camera = probe::create_texture(
        gpu, raw.width, raw.height, WGPUTextureFormat_RGBA16Uint, bind_copy, "camera-rgba16uint");
    WGPUTexelCopyTextureInfo destination{};
    destination.texture = camera;
    destination.aspect = WGPUTextureAspect_All;
    WGPUTexelCopyBufferLayout layout{};
    layout.bytesPerRow = raw.width * 8;
    layout.rowsPerImage = raw.height;
    WGPUExtent3D extent{raw.width, raw.height, 1};
    wgpuQueueWriteTexture(gpu.queue, &destination, raw.rgba.data(), raw.rgba.size() * 2, &layout,
                          &extent);

    linear = probe::create_texture(
        gpu, raw.width, raw.height, WGPUTextureFormat_RGBA16Float,
        WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding, "linear-rgba16float");
    WGPUTextureView linear_view = wgpuTextureCreateView(linear, nullptr);
    WGPUTextureView camera_view = wgpuTextureCreateView(camera, nullptr);

    WGPUShaderModule shader = probe::create_shader(gpu, kLinearizeWgsl, "linearize");
    WGPURenderPipeline pipeline =
        probe::create_fullscreen_pipeline(gpu, shader, WGPUTextureFormat_RGBA16Float, "linearize");
    WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
    entry.binding = 0;
    entry.textureView = camera_view;
    WGPUBindGroupDescriptor bind_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bind_descriptor.layout = wgpuRenderPipelineGetBindGroupLayout(pipeline, 0);
    bind_descriptor.entryCount = 1;
    bind_descriptor.entries = &entry;
    WGPUBindGroup bind_group = wgpuDeviceCreateBindGroup(gpu.device, &bind_descriptor);

    probe::run_fullscreen_pass(gpu, pipeline, bind_group, linear_view);
    probe::wait_idle(gpu);

    wgpuBindGroupRelease(bind_group);
    wgpuRenderPipelineRelease(pipeline);
    wgpuShaderModuleRelease(shader);
    wgpuTextureViewRelease(camera_view);
    wgpuTextureViewRelease(linear_view);
    wgpuTextureRelease(camera);

    const float image_aspect = static_cast<float>(raw.width) / raw.height;
    const float proxy_aspect = static_cast<float>(kProxyWidth) / kProxyHeight;
    if (image_aspect > proxy_aspect) {
      params.aspect_fit[0] = 1.0f;
      params.aspect_fit[1] = image_aspect / proxy_aspect;
    } else {
      params.aspect_fit[0] = proxy_aspect / image_aspect;
      params.aspect_fit[1] = 1.0f;
    }
  }

  void build_proxy_pass() {
    proxy = probe::create_texture(gpu, kProxyWidth, kProxyHeight, WGPUTextureFormat_RGBA8Unorm,
                                  WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc,
                                  "proxy");
    proxy_view = wgpuTextureCreateView(proxy, nullptr);

    WGPUShaderModule shader = probe::create_shader(gpu, kProxyWgsl, "proxy");
    proxy_pipeline =
        probe::create_fullscreen_pipeline(gpu, shader, WGPUTextureFormat_RGBA8Unorm, "proxy");
    wgpuShaderModuleRelease(shader);

    WGPUSamplerDescriptor sampler_descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
    sampler_descriptor.magFilter = WGPUFilterMode_Linear;
    sampler_descriptor.minFilter = WGPUFilterMode_Linear;
    sampler_descriptor.addressModeU = WGPUAddressMode_ClampToEdge;
    sampler_descriptor.addressModeV = WGPUAddressMode_ClampToEdge;
    WGPUSampler sampler = wgpuDeviceCreateSampler(gpu.device, &sampler_descriptor);

    WGPUBufferDescriptor buffer_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    buffer_descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    buffer_descriptor.size = sizeof(Params);
    params_buffer = wgpuDeviceCreateBuffer(gpu.device, &buffer_descriptor);

    WGPUTextureView linear_view = wgpuTextureCreateView(linear, nullptr);
    WGPUBindGroupEntry entries[3] = {WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT,
                                     WGPU_BIND_GROUP_ENTRY_INIT};
    entries[0].binding = 0;
    entries[0].textureView = linear_view;
    entries[1].binding = 1;
    entries[1].sampler = sampler;
    entries[2].binding = 2;
    entries[2].buffer = params_buffer;
    entries[2].size = sizeof(Params);
    WGPUBindGroupDescriptor bind_descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    bind_descriptor.layout = wgpuRenderPipelineGetBindGroupLayout(proxy_pipeline, 0);
    bind_descriptor.entryCount = 3;
    bind_descriptor.entries = entries;
    proxy_bind_group = wgpuDeviceCreateBindGroup(gpu.device, &bind_descriptor);
    wgpuSamplerRelease(sampler);
    wgpuTextureViewRelease(linear_view);
  }

  // Returns a frame: 16-byte header (magic, width, height, seq) + rgba8 rows.
  std::vector<uint8_t> render_frame(float exposure, double* render_ms, double* readback_ms) {
    using clock = std::chrono::steady_clock;
    params.exposure = exposure;
    wgpuQueueWriteBuffer(gpu.queue, params_buffer, 0, &params, sizeof(Params));
    auto t0 = clock::now();
    probe::run_fullscreen_pass(gpu, proxy_pipeline, proxy_bind_group, proxy_view);
    probe::wait_idle(gpu);
    auto t1 = clock::now();
    std::vector<uint8_t> pixels = probe::read_texture(gpu, proxy, kProxyWidth, kProxyHeight, 4);
    auto t2 = clock::now();
    *render_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
    *readback_ms = std::chrono::duration<double, std::milli>(t2 - t1).count();

    std::vector<uint8_t> frame(16 + pixels.size());
    std::memcpy(frame.data(), "LFRM", 4);
    const uint32_t header[3] = {kProxyWidth, kProxyHeight, ++seq};
    std::memcpy(frame.data() + 4, header, 12);
    std::memcpy(frame.data() + 16, pixels.data(), pixels.size());
    return frame;
  }
};

struct PerSocketData {};

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: probe_frame <file.raw>\n");
    return 2;
  }
  try {
    Renderer renderer;
    renderer.gpu = probe::create_gpu(16384);
    probe::print_gpu_report(renderer.gpu);

    probe::DecodedRaw raw = probe::decode_raw(argv[1]);
    std::printf("decoded %s %ux%u in %.0f ms\n", raw.camera.c_str(), raw.width, raw.height,
                raw.decode_ms);
    renderer.upload_and_linearize(raw);
    renderer.build_proxy_pass();
    raw.rgba.clear();
    raw.rgba.shrink_to_fit();

    double render_ms = 0;
    double readback_ms = 0;
    auto warmup = renderer.render_frame(0.0f, &render_ms, &readback_ms);
    std::printf("proxy %ux%u: render %.2f ms, readback %.2f ms, frame %zu bytes\n", kProxyWidth,
                kProxyHeight, render_ms, readback_ms, warmup.size());
    std::printf("listening on ws://127.0.0.1:%d\n", kPort);
    std::fflush(stdout);

    uWS::App()
        .ws<PerSocketData>(
            "/*",
            {.compression = uWS::DISABLED,
             .maxPayloadLength = 1 << 20,
             .idleTimeout = 0,
             .maxBackpressure = 64 << 20,
             .open = [](auto* /*ws*/) { std::printf("client connected\n"); },
             .message =
                 [&renderer](auto* ws, std::string_view message, uWS::OpCode) {
                   nlohmann::json request = nlohmann::json::parse(message, nullptr, false);
                   if (request.is_discarded()) return;
                   if (request.contains("quit")) {
                     std::printf("client asked to quit\n");
                     std::exit(0);
                   }
                   const float exposure = request.value("exposure", 0.0f);
                   double render = 0;
                   double readback = 0;
                   std::vector<uint8_t> frame = renderer.render_frame(exposure, &render, &readback);
                   ws->send(
                       std::string_view(reinterpret_cast<const char*>(frame.data()), frame.size()),
                       uWS::OpCode::BINARY);
                   nlohmann::json timing = {
                       {"seq", renderer.seq}, {"render_ms", render}, {"readback_ms", readback}};
                   ws->send(timing.dump(), uWS::OpCode::TEXT);
                 },
             .close = [](auto* /*ws*/, int,
                         std::string_view) { std::printf("client disconnected\n"); }})
        .listen(kPort,
                [](auto* socket) {
                  if (socket == nullptr) {
                    std::fprintf(stderr, "listen failed on port %d\n", kPort);
                    std::exit(1);
                  }
                })
        .run();
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "probe_frame failed: %s\n", error.what());
    return 1;
  }
}
