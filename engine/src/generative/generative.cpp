#include "generative/generative.h"

#include "ops/registry.h"
#include "ops/sha256.h"

#include <cmath>

#include <algorithm>
#include <vector>

namespace latent {

namespace {

// Half coverage: the same threshold mask.preview reports its own coverage against.
constexpr uint8_t kInsideMask = 127;
constexpr uint32_t kCropQuantum = 8;
constexpr uint32_t kMinimumCrop = 64;

PipelineStage stage_of(const Op& op) {
  const OpDefinition* definition = find_op_definition(op.name);
  if (definition == nullptr) return PipelineStage::Tone;
  return definition->stage;
}

std::string hash_of(const nlohmann::json& value) {
  const std::string text = value.dump();
  return sha256_hex({reinterpret_cast<const uint8_t*>(text.data()), text.size()});
}

}  // namespace

bool is_generative_op(std::string_view name) {
  return name == "generative_fill" || name == "remove";
}

Stack generative_input_stack(const Stack& stack, std::string_view op_id) {
  size_t index = stack.size();
  for (size_t i = 0; i < stack.size(); ++i) {
    if (stack[i].id == op_id) index = i;
  }

  Stack input;
  for (size_t i = 0; i < stack.size(); ++i) {
    const Op& op = stack[i];
    if (!op.enabled || op.id == op_id) continue;
    const PipelineStage stage = stage_of(op);
    if (stage == PipelineStage::Geometry) {
      input.push_back(op);
      continue;
    }
    if (stage > PipelineStage::Generative) continue;
    // Two generative ops share one stage, so only the stack decides which is underneath.
    if (stage == PipelineStage::Generative && i > index) continue;
    input.push_back(op);
  }
  return input;
}

std::string generative_input_hash(const Stack& stack, std::string_view op_id) {
  const Op* op = find_op(stack, op_id);
  if (op == nullptr) return {};
  const nlohmann::json keyed = {{"below", stack_to_json(generative_input_stack(stack, op_id))},
                                {"mask", op->mask.has_value() ? *op->mask : nlohmann::json()},
                                {"params", op->params}};
  return hash_of(keyed);
}

bool generative_is_stale(const Stack& stack, const Op& op) {
  if (!is_generative_op(op.name) || op.result.empty()) return false;
  // A result with no hash came from an engine that did not record one; treat it as fresh
  // rather than permanently stale, because there is nothing to compare it against.
  if (op.input_hash.empty()) return false;
  return generative_input_hash(stack, op.id) != op.input_hash;
}

void annotate_generative_stale(nlohmann::json& stack_json, const Stack& stack) {
  if (!stack_json.is_array()) return;
  for (size_t i = 0; i < stack.size() && i < stack_json.size(); ++i) {
    if (!is_generative_op(stack[i].name) || stack[i].result.empty()) continue;
    stack_json[i]["stale"] = generative_is_stale(stack, stack[i]);
  }
}

std::string generative_result_relative_path(std::string_view op_id) {
  return "generative/" + std::string(op_id) + ".png";
}

std::optional<GenerativeRect> rect_from_json(const std::vector<double>& value) {
  if (value.size() != 4) return std::nullopt;
  GenerativeRect rect{value[0], value[1], value[2], value[3]};
  if (!(rect.x1 > rect.x0) || !(rect.y1 > rect.y0)) return std::nullopt;
  return rect;
}

std::optional<GenerativeRect> mask_bounds(std::span<const uint8_t> coverage,
                                          const MaskWindow& window, double padding) {
  if (window.content_width == 0 || window.content_height == 0) return std::nullopt;
  uint32_t min_x = window.content_width;
  uint32_t min_y = window.content_height;
  uint32_t max_x = 0;
  uint32_t max_y = 0;
  bool found = false;
  for (uint32_t y = 0; y < window.content_height; ++y) {
    const size_t row = static_cast<size_t>(window.content_y + y) * window.stride + window.content_x;
    for (uint32_t x = 0; x < window.content_width; ++x) {
      if (row + x >= coverage.size() || coverage[row + x] <= kInsideMask) continue;
      found = true;
      min_x = std::min(min_x, x);
      min_y = std::min(min_y, y);
      max_x = std::max(max_x, x);
      max_y = std::max(max_y, y);
    }
  }
  if (!found) return std::nullopt;

  // Padding is a share of the long edge in both axes, so the context around a wide hole is
  // as thick as the context around a tall one.
  const double reach = padding * std::max(window.content_width, window.content_height);
  const double pad_x = reach / window.content_width;
  const double pad_y = reach / window.content_height;
  GenerativeRect rect;
  rect.x0 = std::clamp((min_x / static_cast<double>(window.content_width)) - pad_x, 0.0, 1.0);
  rect.y0 = std::clamp((min_y / static_cast<double>(window.content_height)) - pad_y, 0.0, 1.0);
  rect.x1 = std::clamp(((max_x + 1) / static_cast<double>(window.content_width)) + pad_x, 0.0, 1.0);
  rect.y1 =
      std::clamp(((max_y + 1) / static_cast<double>(window.content_height)) + pad_y, 0.0, 1.0);
  return rect;
}

CropBox crop_box(const GenerativeRect& rect, uint32_t content_width, uint32_t content_height) {
  const auto quantize = [](uint32_t value, uint32_t limit) {
    const uint32_t snapped = (value / kCropQuantum) * kCropQuantum;
    return std::min(std::max(snapped, std::min(kMinimumCrop, limit)), limit);
  };
  CropBox box;
  box.width =
      quantize(static_cast<uint32_t>(std::lround(rect.width() * content_width)), content_width);
  box.height =
      quantize(static_cast<uint32_t>(std::lround(rect.height() * content_height)), content_height);
  const auto centre_x = static_cast<int64_t>(std::lround((rect.x0 + rect.x1) / 2 * content_width));
  const auto centre_y = static_cast<int64_t>(std::lround((rect.y0 + rect.y1) / 2 * content_height));
  const int64_t max_x = static_cast<int64_t>(content_width) - box.width;
  const int64_t max_y = static_cast<int64_t>(content_height) - box.height;
  box.x = static_cast<uint32_t>(std::clamp(centre_x - (box.width / 2), int64_t{0}, max_x));
  box.y = static_cast<uint32_t>(std::clamp(centre_y - (box.height / 2), int64_t{0}, max_y));
  return box;
}

GenerativeRect rect_of(const CropBox& box, uint32_t content_width, uint32_t content_height) {
  GenerativeRect rect;
  rect.x0 = static_cast<double>(box.x) / std::max(content_width, 1U);
  rect.y0 = static_cast<double>(box.y) / std::max(content_height, 1U);
  rect.x1 = static_cast<double>(box.x + box.width) / std::max(content_width, 1U);
  rect.y1 = static_cast<double>(box.y + box.height) / std::max(content_height, 1U);
  return rect;
}

uint32_t view_size_for_crop(const GenerativeRect& rect, uint32_t probe_size, uint32_t target) {
  const double share = std::max({rect.width(), rect.height(), 1e-3});
  const double wanted = target / share;
  // Never below the probe: a crop that is already big enough is rendered once, not twice.
  return static_cast<uint32_t>(
      std::clamp(std::lround(wanted), static_cast<long>(probe_size), static_cast<long>(4096)));
}

}  // namespace latent
