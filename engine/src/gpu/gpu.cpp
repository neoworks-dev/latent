#include "gpu/gpu.h"

#include <cstdio>
#include <cstring>

#include <stdexcept>
#include <vector>

namespace latent {

namespace {

std::string to_string(WGPUStringView view) {
  if (view.data == nullptr) return {};
  if (view.length == WGPU_STRLEN) return std::string(view.data);
  return std::string(view.data, view.length);
}

void on_device_lost(WGPUDevice const*, WGPUDeviceLostReason reason, WGPUStringView message, void*,
                    void*) {
  std::fprintf(stderr, "[wgpu device lost] reason %d: %s\n", static_cast<int>(reason),
               to_string(message).c_str());
}

void on_log(WGPULogLevel level, WGPUStringView message, void*) {
  if (level > WGPULogLevel_Warn) return;
  std::fprintf(stderr, "[wgpu] %s\n", to_string(message).c_str());
}

// wgpu-native v29 panics inside wgpuInstanceWaitAny ("not implemented"), so every future
// here uses AllowProcessEvents and is pumped until its callback sets `done`.
void pump_until(WGPUInstance instance, const bool& done) {
  while (!done) {
    wgpuInstanceProcessEvents(instance);
  }
}

}  // namespace

Gpu::Gpu(uint32_t requested_texture_dim) {
  wgpuSetLogCallback(on_log, nullptr);

  WGPUInstanceExtras extras{};
  extras.chain.sType = static_cast<WGPUSType>(WGPUSType_InstanceExtras);
  extras.backends = WGPUInstanceBackend_Vulkan;
  WGPUInstanceDescriptor instance_descriptor = WGPU_INSTANCE_DESCRIPTOR_INIT;
  instance_descriptor.nextInChain = &extras.chain;
  instance_ = wgpuCreateInstance(&instance_descriptor);
  if (instance_ == nullptr) throw std::runtime_error("wgpuCreateInstance returned null");

  struct AdapterRequest {
    bool done = false;
    WGPUAdapter adapter = nullptr;
    std::string message;
  } adapter_request;

  WGPURequestAdapterOptions adapter_options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
  adapter_options.powerPreference = WGPUPowerPreference_HighPerformance;
  adapter_options.backendType = WGPUBackendType_Vulkan;
  WGPURequestAdapterCallbackInfo adapter_callback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
  adapter_callback.mode = WGPUCallbackMode_AllowProcessEvents;
  adapter_callback.userdata1 = &adapter_request;
  adapter_callback.callback = [](WGPURequestAdapterStatus status, WGPUAdapter adapter,
                                 WGPUStringView message, void* userdata1, void*) {
    auto* request = static_cast<AdapterRequest*>(userdata1);
    if (status == WGPURequestAdapterStatus_Success) request->adapter = adapter;
    request->message = to_string(message);
    request->done = true;
  };
  wgpuInstanceRequestAdapter(instance_, &adapter_options, adapter_callback);
  pump_until(instance_, adapter_request.done);
  adapter_ = adapter_request.adapter;
  if (adapter_ == nullptr) {
    throw std::runtime_error("requestAdapter failed: " + adapter_request.message);
  }

  info_ = WGPU_ADAPTER_INFO_INIT;
  wgpuAdapterGetInfo(adapter_, &info_);
  WGPULimits adapter_limits = WGPU_LIMITS_INIT;
  wgpuAdapterGetLimits(adapter_, &adapter_limits);
  if (adapter_limits.maxTextureDimension2D < requested_texture_dim) {
    throw std::runtime_error("adapter maxTextureDimension2D " +
                             std::to_string(adapter_limits.maxTextureDimension2D) + " < required " +
                             std::to_string(requested_texture_dim));
  }

  report_.adapter = to_string(info_.device);
  report_.max_texture_dimension_2d = adapter_limits.maxTextureDimension2D;
  report_.max_buffer_size = adapter_limits.maxBufferSize;
  report_.shader_f16 = wgpuAdapterHasFeature(adapter_, WGPUFeatureName_ShaderF16);

  std::vector<WGPUFeatureName> features;
  if (report_.shader_f16) features.push_back(WGPUFeatureName_ShaderF16);

  WGPULimits required = WGPU_LIMITS_INIT;
  required.maxTextureDimension2D = requested_texture_dim;
  required.maxBufferSize = adapter_limits.maxBufferSize;

  struct DeviceRequest {
    bool done = false;
    WGPUDevice device = nullptr;
    std::string message;
  } device_request;

  WGPUDeviceDescriptor device_descriptor = WGPU_DEVICE_DESCRIPTOR_INIT;
  device_descriptor.label = gpu_string("latentd");
  device_descriptor.requiredLimits = &required;
  device_descriptor.requiredFeatureCount = features.size();
  device_descriptor.requiredFeatures = features.data();
  device_descriptor.uncapturedErrorCallbackInfo.userdata1 = this;
  device_descriptor.uncapturedErrorCallbackInfo.callback =
      [](WGPUDevice const*, WGPUErrorType type, WGPUStringView message, void* userdata1, void*) {
        auto* gpu = static_cast<Gpu*>(userdata1);
        gpu->last_error_ =
            "wgpu error " + std::to_string(static_cast<int>(type)) + ": " + to_string(message);
        std::fprintf(stderr, "[wgpu uncaptured] %s\n", gpu->last_error_.c_str());
      };
  device_descriptor.deviceLostCallbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
  device_descriptor.deviceLostCallbackInfo.callback = on_device_lost;

  WGPURequestDeviceCallbackInfo device_callback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
  device_callback.mode = WGPUCallbackMode_AllowProcessEvents;
  device_callback.userdata1 = &device_request;
  device_callback.callback = [](WGPURequestDeviceStatus status, WGPUDevice device,
                                WGPUStringView message, void* userdata1, void*) {
    auto* request = static_cast<DeviceRequest*>(userdata1);
    if (status == WGPURequestDeviceStatus_Success) request->device = device;
    request->message = to_string(message);
    request->done = true;
  };
  wgpuAdapterRequestDevice(adapter_, &device_descriptor, device_callback);
  pump_until(instance_, device_request.done);
  device_ = device_request.device;
  if (device_ == nullptr) {
    throw std::runtime_error("requestDevice failed: " + device_request.message);
  }
  queue_ = wgpuDeviceGetQueue(device_);
}

Gpu::~Gpu() {
  if (queue_ != nullptr) wgpuQueueRelease(queue_);
  if (device_ != nullptr) wgpuDeviceRelease(device_);
  wgpuAdapterInfoFreeMembers(info_);
  if (adapter_ != nullptr) wgpuAdapterRelease(adapter_);
  if (instance_ != nullptr) wgpuInstanceRelease(instance_);
}

TextureHandle Gpu::create_texture(uint32_t width, uint32_t height, WGPUTextureFormat format,
                                  WGPUTextureUsage usage, const char* label) const {
  WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
  descriptor.label = gpu_string(label);
  descriptor.usage = usage;
  descriptor.dimension = WGPUTextureDimension_2D;
  descriptor.size = WGPUExtent3D{width, height, 1};
  descriptor.format = format;
  descriptor.mipLevelCount = 1;
  descriptor.sampleCount = 1;
  WGPUTexture texture = wgpuDeviceCreateTexture(device_, &descriptor);
  if (texture == nullptr) throw std::runtime_error(std::string("createTexture failed: ") + label);
  return TextureHandle(texture);
}

ShaderModuleHandle Gpu::create_shader(std::string_view wgsl, const char* label) const {
  WGPUShaderSourceWGSL source = WGPU_SHADER_SOURCE_WGSL_INIT;
  source.code = WGPUStringView{wgsl.data(), wgsl.size()};
  WGPUShaderModuleDescriptor descriptor = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
  descriptor.label = gpu_string(label);
  descriptor.nextInChain = &source.chain;
  WGPUShaderModule module = wgpuDeviceCreateShaderModule(device_, &descriptor);
  if (module == nullptr) {
    throw std::runtime_error(std::string("createShaderModule failed: ") + label);
  }
  return ShaderModuleHandle(module);
}

RenderPipelineHandle Gpu::create_fullscreen_pipeline(WGPUShaderModule shader,
                                                     WGPUTextureFormat target_format,
                                                     const char* label) const {
  WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
  target.format = target_format;

  WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
  fragment.module = shader;
  fragment.entryPoint = gpu_string("fs");
  fragment.targetCount = 1;
  fragment.targets = &target;

  WGPURenderPipelineDescriptor descriptor = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
  descriptor.label = gpu_string(label);
  descriptor.vertex.module = shader;
  descriptor.vertex.entryPoint = gpu_string("vs");
  descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
  descriptor.fragment = &fragment;

  WGPURenderPipeline pipeline = wgpuDeviceCreateRenderPipeline(device_, &descriptor);
  if (pipeline == nullptr) {
    throw std::runtime_error(std::string("createRenderPipeline failed: ") + label);
  }
  return RenderPipelineHandle(pipeline);
}

BufferHandle Gpu::create_uniform_buffer(uint64_t size, const char* label) const {
  WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
  descriptor.label = gpu_string(label);
  descriptor.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
  descriptor.size = size;
  WGPUBuffer buffer = wgpuDeviceCreateBuffer(device_, &descriptor);
  if (buffer == nullptr) throw std::runtime_error(std::string("createBuffer failed: ") + label);
  return BufferHandle(buffer);
}

BindGroupHandle Gpu::create_bind_group(WGPURenderPipeline pipeline,
                                       std::span<const WGPUBindGroupEntry> entries) const {
  WGPUBindGroupDescriptor descriptor = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
  descriptor.layout = wgpuRenderPipelineGetBindGroupLayout(pipeline, 0);
  descriptor.entryCount = entries.size();
  descriptor.entries = entries.data();
  WGPUBindGroup bind_group = wgpuDeviceCreateBindGroup(device_, &descriptor);
  wgpuBindGroupLayoutRelease(descriptor.layout);
  if (bind_group == nullptr) throw std::runtime_error("createBindGroup failed");
  return BindGroupHandle(bind_group);
}

void Gpu::write_buffer(WGPUBuffer buffer, uint64_t offset, const void* data, size_t size) const {
  wgpuQueueWriteBuffer(queue_, buffer, offset, data, size);
}

void Gpu::write_texture(WGPUTexture texture, uint32_t width, uint32_t height,
                        uint32_t bytes_per_pixel, const void* data, size_t size) const {
  WGPUTexelCopyTextureInfo destination{};
  destination.texture = texture;
  destination.aspect = WGPUTextureAspect_All;
  WGPUTexelCopyBufferLayout layout{};
  layout.bytesPerRow = width * bytes_per_pixel;
  layout.rowsPerImage = height;
  WGPUExtent3D extent{width, height, 1};
  wgpuQueueWriteTexture(queue_, &destination, data, size, &layout, &extent);
}

WGPUCommandEncoder Gpu::begin_commands(const char* label) const {
  WGPUCommandEncoderDescriptor descriptor = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
  descriptor.label = gpu_string(label);
  return wgpuDeviceCreateCommandEncoder(device_, &descriptor);
}

void Gpu::encode_fullscreen_pass(WGPUCommandEncoder encoder, WGPURenderPipeline pipeline,
                                 WGPUBindGroup bind_group, WGPUTextureView target) const {
  WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
  attachment.view = target;
  attachment.loadOp = WGPULoadOp_Clear;
  attachment.storeOp = WGPUStoreOp_Store;
  attachment.clearValue = WGPUColor{0, 0, 0, 1};

  WGPURenderPassDescriptor pass_descriptor = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
  pass_descriptor.colorAttachmentCount = 1;
  pass_descriptor.colorAttachments = &attachment;

  WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
  wgpuRenderPassEncoderSetPipeline(pass, pipeline);
  if (bind_group != nullptr) wgpuRenderPassEncoderSetBindGroup(pass, 0, bind_group, 0, nullptr);
  wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
  wgpuRenderPassEncoderEnd(pass);
  wgpuRenderPassEncoderRelease(pass);
}

void Gpu::submit(WGPUCommandEncoder encoder) const {
  WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, nullptr);
  wgpuCommandEncoderRelease(encoder);
  wgpuQueueSubmit(queue_, 1, &commands);
  wgpuCommandBufferRelease(commands);
}

void Gpu::wait_idle() const {
  wgpuDevicePoll(device_, true, nullptr);
}

void Gpu::raise_pending_error() {
  if (last_error_.empty()) return;
  const std::string message = last_error_;
  last_error_.clear();
  throw std::runtime_error(message);
}

void Gpu::read_texture(WGPUTexture texture, uint32_t width, uint32_t height,
                       uint32_t bytes_per_pixel, std::span<uint8_t> out) const {
  // bytesPerRow must be a multiple of 256 for texture-to-buffer copies.
  const uint32_t unpadded_row = width * bytes_per_pixel;
  const uint32_t padded_row = (unpadded_row + 255) / 256 * 256;
  const uint64_t buffer_size = static_cast<uint64_t>(padded_row) * height;
  if (out.size() < static_cast<size_t>(unpadded_row) * height) {
    throw std::runtime_error("read_texture destination too small");
  }

  WGPUBufferDescriptor buffer_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
  buffer_descriptor.label = gpu_string("readback");
  buffer_descriptor.usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst;
  buffer_descriptor.size = buffer_size;
  BufferHandle staging(wgpuDeviceCreateBuffer(device_, &buffer_descriptor));
  if (!staging) throw std::runtime_error("createBuffer(readback) failed");

  WGPUTexelCopyTextureInfo source{};
  source.texture = texture;
  source.aspect = WGPUTextureAspect_All;
  WGPUTexelCopyBufferInfo destination{};
  destination.buffer = staging.get();
  destination.layout.bytesPerRow = padded_row;
  destination.layout.rowsPerImage = height;
  WGPUExtent3D extent{width, height, 1};

  WGPUCommandEncoder encoder = begin_commands("readback");
  wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &extent);
  submit(encoder);

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
  wgpuBufferMapAsync(staging.get(), WGPUMapMode_Read, 0, buffer_size, callback);
  while (!map_state.done) {
    wgpuDevicePoll(device_, true, nullptr);
  }
  if (!map_state.ok) throw std::runtime_error("mapAsync failed: " + map_state.message);

  const auto* mapped =
      static_cast<const uint8_t*>(wgpuBufferGetConstMappedRange(staging.get(), 0, buffer_size));
  for (uint32_t row = 0; row < height; ++row) {
    std::memcpy(out.data() + static_cast<size_t>(row) * unpadded_row,
                mapped + static_cast<size_t>(row) * padded_row, unpadded_row);
  }
  wgpuBufferUnmap(staging.get());
}

}  // namespace latent
