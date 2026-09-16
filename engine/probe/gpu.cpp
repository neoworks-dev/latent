#include "gpu.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <stdexcept>

namespace probe {

namespace {

std::string to_string(WGPUStringView view) {
  if (view.data == nullptr) return {};
  if (view.length == WGPU_STRLEN) return std::string(view.data);
  return std::string(view.data, view.length);
}

void on_uncaptured_error(WGPUDevice const*, WGPUErrorType type, WGPUStringView message,
                         void* userdata1, void*) {
  auto* gpu = static_cast<Gpu*>(userdata1);
  gpu->last_error =
      "error type " + std::to_string(static_cast<int>(type)) + ": " + to_string(message);
  std::fprintf(stderr, "[wgpu uncaptured] %s\n", gpu->last_error.c_str());
}

void on_device_lost(WGPUDevice const*, WGPUDeviceLostReason reason, WGPUStringView message, void*,
                    void*) {
  std::fprintf(stderr, "[wgpu device lost] reason %d: %s\n", static_cast<int>(reason),
               to_string(message).c_str());
}

void on_log(WGPULogLevel level, WGPUStringView message, void*) {
  if (level > WGPULogLevel_Warn) return;
  std::fprintf(stderr, "[wgpu log %d] %s\n", static_cast<int>(level), to_string(message).c_str());
}

// wgpu-native v29 panics inside wgpuInstanceWaitAny ("not implemented"), so every
// future here uses AllowProcessEvents and is pumped until its callback sets `done`.
void pump_until(WGPUInstance instance, const bool& done) {
  while (!done)
    wgpuInstanceProcessEvents(instance);
}

WGPUAdapter request_adapter(WGPUInstance instance) {
  WGPURequestAdapterOptions options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
  options.powerPreference = WGPUPowerPreference_HighPerformance;
  options.backendType = WGPUBackendType_Vulkan;

  struct Result {
    bool done = false;
    WGPUAdapter adapter = nullptr;
    std::string message;
  } result;

  WGPURequestAdapterCallbackInfo callback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
  callback.mode = WGPUCallbackMode_AllowProcessEvents;
  callback.userdata1 = &result;
  callback.callback = [](WGPURequestAdapterStatus status, WGPUAdapter adapter,
                         WGPUStringView message, void* userdata1, void*) {
    auto* out = static_cast<Result*>(userdata1);
    if (status == WGPURequestAdapterStatus_Success) out->adapter = adapter;
    out->message = to_string(message);
    out->done = true;
  };

  wgpuInstanceRequestAdapter(instance, &options, callback);
  pump_until(instance, result.done);
  if (result.adapter == nullptr)
    throw std::runtime_error("requestAdapter failed: " + result.message);
  return result.adapter;
}

WGPUDevice request_device(Gpu& gpu, const WGPULimits& required,
                          const std::vector<WGPUFeatureName>& features) {
  WGPUDeviceDescriptor descriptor = WGPU_DEVICE_DESCRIPTOR_INIT;
  descriptor.label = sv("latent-probe");
  descriptor.requiredLimits = &required;
  descriptor.requiredFeatureCount = features.size();
  descriptor.requiredFeatures = features.data();
  descriptor.uncapturedErrorCallbackInfo.callback = on_uncaptured_error;
  descriptor.uncapturedErrorCallbackInfo.userdata1 = &gpu;
  descriptor.deviceLostCallbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
  descriptor.deviceLostCallbackInfo.callback = on_device_lost;

  struct Result {
    bool done = false;
    WGPUDevice device = nullptr;
    std::string message;
  } result;

  WGPURequestDeviceCallbackInfo callback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
  callback.mode = WGPUCallbackMode_AllowProcessEvents;
  callback.userdata1 = &result;
  callback.callback = [](WGPURequestDeviceStatus status, WGPUDevice device, WGPUStringView message,
                         void* userdata1, void*) {
    auto* out = static_cast<Result*>(userdata1);
    if (status == WGPURequestDeviceStatus_Success) out->device = device;
    out->message = to_string(message);
    out->done = true;
  };

  wgpuAdapterRequestDevice(gpu.adapter, &descriptor, callback);
  pump_until(gpu.instance, result.done);
  if (result.device == nullptr) throw std::runtime_error("requestDevice failed: " + result.message);
  return result.device;
}

}  // namespace

Gpu create_gpu(uint32_t requested_texture_dim) {
  Gpu gpu;
  wgpuSetLogCallback(on_log, nullptr);

  WGPUInstanceExtras extras{};
  extras.chain.sType = static_cast<WGPUSType>(WGPUSType_InstanceExtras);
  extras.backends = WGPUInstanceBackend_Vulkan;
  WGPUInstanceDescriptor instance_descriptor = WGPU_INSTANCE_DESCRIPTOR_INIT;
  instance_descriptor.nextInChain = &extras.chain;
  gpu.instance = wgpuCreateInstance(&instance_descriptor);
  if (gpu.instance == nullptr) throw std::runtime_error("wgpuCreateInstance returned null");

  gpu.adapter = request_adapter(gpu.instance);

  gpu.info = WGPU_ADAPTER_INFO_INIT;
  wgpuAdapterGetInfo(gpu.adapter, &gpu.info);
  gpu.adapter_limits = WGPU_LIMITS_INIT;
  wgpuAdapterGetLimits(gpu.adapter, &gpu.adapter_limits);
  gpu.has_f16 = wgpuAdapterHasFeature(gpu.adapter, WGPUFeatureName_ShaderF16);
  gpu.has_float32_filterable =
      wgpuAdapterHasFeature(gpu.adapter, WGPUFeatureName_Float32Filterable);

  if (gpu.adapter_limits.maxTextureDimension2D < requested_texture_dim) {
    throw std::runtime_error("adapter maxTextureDimension2D " +
                             std::to_string(gpu.adapter_limits.maxTextureDimension2D) +
                             " < requested " + std::to_string(requested_texture_dim));
  }

  WGPULimits required = WGPU_LIMITS_INIT;
  required.maxTextureDimension2D = requested_texture_dim;
  required.maxBufferSize = gpu.adapter_limits.maxBufferSize;
  std::vector<WGPUFeatureName> features;
  if (gpu.has_f16) features.push_back(WGPUFeatureName_ShaderF16);
  if (gpu.has_float32_filterable) features.push_back(WGPUFeatureName_Float32Filterable);

  gpu.device = request_device(gpu, required, features);
  gpu.queue = wgpuDeviceGetQueue(gpu.device);
  gpu.device_limits = WGPU_LIMITS_INIT;
  wgpuDeviceGetLimits(gpu.device, &gpu.device_limits);
  return gpu;
}

void destroy_gpu(Gpu& gpu) {
  if (gpu.queue) wgpuQueueRelease(gpu.queue);
  if (gpu.device) wgpuDeviceRelease(gpu.device);
  wgpuAdapterInfoFreeMembers(gpu.info);
  if (gpu.adapter) wgpuAdapterRelease(gpu.adapter);
  if (gpu.instance) wgpuInstanceRelease(gpu.instance);
  gpu = Gpu{};
}

void print_gpu_report(const Gpu& gpu) {
  std::printf("wgpu-native version   %u\n", wgpuGetVersion());
  std::printf("adapter               %s (%s), backend %d, type %d, vendor 0x%04x device 0x%04x\n",
              to_string(gpu.info.device).c_str(), to_string(gpu.info.description).c_str(),
              static_cast<int>(gpu.info.backendType), static_cast<int>(gpu.info.adapterType),
              gpu.info.vendorID, gpu.info.deviceID);
  std::printf("maxTextureDimension2D %u (device %u)\n", gpu.adapter_limits.maxTextureDimension2D,
              gpu.device_limits.maxTextureDimension2D);
  std::printf("maxBufferSize         %llu MiB\n",
              static_cast<unsigned long long>(gpu.adapter_limits.maxBufferSize >> 20));
  std::printf(
      "maxStorageBufferBindingSize %llu MiB\n",
      static_cast<unsigned long long>(gpu.adapter_limits.maxStorageBufferBindingSize >> 20));
  std::printf("shader-f16            %s\n", gpu.has_f16 ? "yes" : "no");
  std::printf("float32-filterable    %s\n", gpu.has_float32_filterable ? "yes" : "no");
}

WGPUTexture create_texture(const Gpu& gpu, uint32_t width, uint32_t height,
                           WGPUTextureFormat format, WGPUTextureUsage usage, const char* label) {
  WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
  descriptor.label = sv(label);
  descriptor.usage = usage;
  descriptor.dimension = WGPUTextureDimension_2D;
  descriptor.size = WGPUExtent3D{width, height, 1};
  descriptor.format = format;
  descriptor.mipLevelCount = 1;
  descriptor.sampleCount = 1;
  WGPUTexture texture = wgpuDeviceCreateTexture(gpu.device, &descriptor);
  if (texture == nullptr) throw std::runtime_error(std::string("createTexture failed: ") + label);
  return texture;
}

WGPUShaderModule create_shader(const Gpu& gpu, std::string_view wgsl, const char* label) {
  WGPUShaderSourceWGSL source = WGPU_SHADER_SOURCE_WGSL_INIT;
  source.code = WGPUStringView{wgsl.data(), wgsl.size()};
  WGPUShaderModuleDescriptor descriptor = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
  descriptor.label = sv(label);
  descriptor.nextInChain = &source.chain;
  WGPUShaderModule module = wgpuDeviceCreateShaderModule(gpu.device, &descriptor);
  if (module == nullptr)
    throw std::runtime_error(std::string("createShaderModule failed: ") + label);
  return module;
}

WGPURenderPipeline create_fullscreen_pipeline(const Gpu& gpu, WGPUShaderModule shader,
                                              WGPUTextureFormat target_format, const char* label) {
  WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
  target.format = target_format;

  WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
  fragment.module = shader;
  fragment.entryPoint = sv("fs");
  fragment.targetCount = 1;
  fragment.targets = &target;

  WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
  descriptor.label = sv(label);
  descriptor.vertex.module = shader;
  descriptor.vertex.entryPoint = sv("vs");
  descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
  descriptor.fragment = &fragment;

  WGPURenderPipeline pipeline = wgpuDeviceCreateRenderPipeline(gpu.device, &descriptor);
  if (pipeline == nullptr)
    throw std::runtime_error(std::string("createRenderPipeline failed: ") + label);
  return pipeline;
}

void run_fullscreen_pass(const Gpu& gpu, WGPURenderPipeline pipeline, WGPUBindGroup bind_group,
                         WGPUTextureView target) {
  WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
  attachment.view = target;
  attachment.loadOp = WGPULoadOp_Clear;
  attachment.storeOp = WGPUStoreOp_Store;
  attachment.clearValue = WGPUColor{0, 0, 0, 1};

  WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
  pass_descriptor.colorAttachmentCount = 1;
  pass_descriptor.colorAttachments = &attachment;

  WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(gpu.device, nullptr);
  WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
  wgpuRenderPassEncoderSetPipeline(pass, pipeline);
  if (bind_group) wgpuRenderPassEncoderSetBindGroup(pass, 0, bind_group, 0, nullptr);
  wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
  wgpuRenderPassEncoderEnd(pass);
  wgpuRenderPassEncoderRelease(pass);

  WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, nullptr);
  wgpuCommandEncoderRelease(encoder);
  wgpuQueueSubmit(gpu.queue, 1, &commands);
  wgpuCommandBufferRelease(commands);
}

void wait_idle(const Gpu& gpu) {
  wgpuDevicePoll(gpu.device, true, nullptr);
}

std::vector<uint8_t> read_texture(const Gpu& gpu, WGPUTexture texture, uint32_t width,
                                  uint32_t height, uint32_t bytes_per_pixel) {
  // bytesPerRow must be a multiple of 256 for texture-to-buffer copies.
  const uint32_t unpadded_row = width * bytes_per_pixel;
  const uint32_t padded_row = (unpadded_row + 255) / 256 * 256;
  const uint64_t buffer_size = static_cast<uint64_t>(padded_row) * height;

  WGPUBufferDescriptor buffer_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
  buffer_descriptor.label = sv("readback");
  buffer_descriptor.usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst;
  buffer_descriptor.size = buffer_size;
  WGPUBuffer staging = wgpuDeviceCreateBuffer(gpu.device, &buffer_descriptor);
  if (staging == nullptr) throw std::runtime_error("createBuffer(readback) failed");

  WGPUTexelCopyTextureInfo source{};
  source.texture = texture;
  source.mipLevel = 0;
  source.origin = WGPUOrigin3D{0, 0, 0};
  source.aspect = WGPUTextureAspect_All;

  WGPUTexelCopyBufferInfo destination{};
  destination.buffer = staging;
  destination.layout.offset = 0;
  destination.layout.bytesPerRow = padded_row;
  destination.layout.rowsPerImage = height;

  WGPUExtent3D extent{width, height, 1};

  WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(gpu.device, nullptr);
  wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &extent);
  WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, nullptr);
  wgpuCommandEncoderRelease(encoder);
  wgpuQueueSubmit(gpu.queue, 1, &commands);
  wgpuCommandBufferRelease(commands);

  struct MapState {
    bool done = false;
    bool ok = false;
    std::string message;
  } map_state;

  WGPUBufferMapCallbackInfo callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
  callback.mode = WGPUCallbackMode_AllowProcessEvents;
  callback.userdata1 = &map_state;
  callback.callback = [](WGPUMapAsyncStatus status, WGPUStringView message, void* userdata1,
                         void*) {
    auto* state = static_cast<MapState*>(userdata1);
    state->done = true;
    state->ok = status == WGPUMapAsyncStatus_Success;
    state->message = to_string(message);
  };
  wgpuBufferMapAsync(staging, WGPUMapMode_Read, 0, buffer_size, callback);
  while (!map_state.done)
    wgpuDevicePoll(gpu.device, true, nullptr);
  if (!map_state.ok) throw std::runtime_error("mapAsync failed: " + map_state.message);

  const auto* mapped =
      static_cast<const uint8_t*>(wgpuBufferGetConstMappedRange(staging, 0, buffer_size));
  std::vector<uint8_t> pixels(static_cast<size_t>(unpadded_row) * height);
  for (uint32_t row = 0; row < height; ++row) {
    std::memcpy(pixels.data() + static_cast<size_t>(row) * unpadded_row,
                mapped + static_cast<size_t>(row) * padded_row, unpadded_row);
  }
  wgpuBufferUnmap(staging);
  wgpuBufferRelease(staging);
  return pixels;
}

}  // namespace probe
