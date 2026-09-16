// The detectors behind mask.detect, and the shape stubs that stand in for them.
//
// `request.image` is an **image-space** render: the server hands it the stack below the
// masked op with every geometry op removed (src/server/server.cpp, `detect_input_stack`),
// so the boxes and points a model answers with are already normalised over the uncropped
// photo — the space a mask stores (protocol Mask.space). A detector never sees the crop and
// never has to undo one.
#include "ai/mask_detect.h"

#include "ai/dedicated.h"
#include "ai/florence2.h"
#include "ai/model_store.h"
#include "ai/ort_session.h"
#include "ai/preprocess.h"
#include "ai/sam2.h"

#include <cmath>
#include <cstdlib>
#include <cstring>

#include <algorithm>
#include <optional>
#include <string_view>

namespace latent {

namespace {

// The stub works at a fixed size and the raster is resampled per view, so the shape does
// not change when the window does.
constexpr uint32_t kStubLongEdge = 1024;

GrayImage blank(uint32_t width, uint32_t height) {
  GrayImage image;
  image.width = width;
  image.height = height;
  image.pixels.assign(static_cast<size_t>(width) * height, 0);
  return image;
}

// A soft centre ellipse: what "the subject" looks like to something that cannot see.
GrayImage centre_ellipse(uint32_t width, uint32_t height, double radius_x, double radius_y) {
  GrayImage image = blank(width, height);
  for (uint32_t y = 0; y < height; ++y) {
    const double dy = (((y + 0.5) / height) - 0.5) / radius_y;
    for (uint32_t x = 0; x < width; ++x) {
      const double dx = (((x + 0.5) / width) - 0.5) / radius_x;
      const double reach = std::sqrt((dx * dx) + (dy * dy));
      const double t = std::clamp((1.0 - reach) / 0.15, 0.0, 1.0);
      image.pixels[(static_cast<size_t>(y) * width) + x] =
          static_cast<uint8_t>(std::lround(t * t * (3.0 - (2.0 * t)) * 255));
    }
  }
  return image;
}

// The top 40 % fading out: what a sky is, roughly, when the horizon is where it usually is.
GrayImage top_gradient(uint32_t width, uint32_t height) {
  GrayImage image = blank(width, height);
  for (uint32_t y = 0; y < height; ++y) {
    const double v = (y + 0.5) / height;
    const double t = std::clamp((0.45 - v) / 0.15, 0.0, 1.0);
    const auto level = static_cast<uint8_t>(std::lround(t * t * (3.0 - (2.0 * t)) * 255));
    std::memset(image.pixels.data() + (static_cast<size_t>(y) * width), level, width);
  }
  return image;
}

GrayImage inverted(GrayImage image) {
  for (uint8_t& pixel : image.pixels) {
    pixel = static_cast<uint8_t>(255 - pixel);
  }
  return image;
}

class StubDetector : public MaskDetector {
 public:
  std::string name() const override { return "stub-shapes"; }

  MaskDetectResult detect(const MaskDetectRequest& request) override {
    const double aspect = request.image.width == 0 || request.image.height == 0
                              ? 1.0
                              : static_cast<double>(request.image.width) / request.image.height;
    uint32_t width = kStubLongEdge;
    auto height = static_cast<uint32_t>(std::lround(kStubLongEdge / std::max(aspect, 1e-3)));
    if (height > kStubLongEdge) {
      height = kStubLongEdge;
      width = static_cast<uint32_t>(std::lround(kStubLongEdge * aspect));
    }
    width = std::max(width, 1U);
    height = std::max(height, 1U);

    MaskDetectResult result;
    result.ok = true;
    result.model = name();
    switch (request.kind) {
      case MaskKind::Sky:
        result.raster = top_gradient(width, height);
        return result;
      case MaskKind::Background:
        result.raster = inverted(centre_ellipse(width, height, 0.28, 0.38));
        return result;
      case MaskKind::Depth:
        result.raster = inverted(top_gradient(width, height));
        return result;
      default:
        result.raster = centre_ellipse(width, height, 0.28, 0.38);
        return result;
    }
  }
};

// ---- the real one -----------------------------------------------------------------------

// The SAM 2 prompt a component's params describe, in source-image pixels.
std::vector<Sam2Point> prompt_from_box(const DetectionBox& box) {
  return {{box[0], box[1], Sam2Label::BoxTopLeft}, {box[2], box[3], Sam2Label::BoxBottomRight}};
}

std::optional<DetectionBox> box_param(const nlohmann::json& params, const Rgb8Image& image) {
  if (!params.contains("box") || !params["box"].is_array() || params["box"].size() != 4) {
    return std::nullopt;
  }
  // Normalised over the content rect, which is exactly what `image` is.
  const auto width = static_cast<float>(image.width);
  const auto height = static_cast<float>(image.height);
  const auto x0 = params["box"][0].get<float>() * width;
  const auto y0 = params["box"][1].get<float>() * height;
  const auto x1 = params["box"][2].get<float>() * width;
  const auto y1 = params["box"][3].get<float>() * height;
  return DetectionBox{std::min(x0, x1), std::min(y0, y1), std::max(x0, x1), std::max(y0, y1)};
}

std::vector<Sam2Point> points_param(const nlohmann::json& params, const Rgb8Image& image) {
  std::vector<Sam2Point> points;
  if (!params.contains("points") || !params["points"].is_array()) return points;
  for (const nlohmann::json& point : params["points"]) {
    if (!point.is_array() || point.size() != 2) continue;
    points.push_back({point[0].get<float>() * static_cast<float>(image.width),
                      point[1].get<float>() * static_cast<float>(image.height),
                      Sam2Label::Foreground});
  }
  return points;
}

// The encoder costs ~100 ms and 17 MB; every further prompt on the same photo is 6 ms.
// One entry, because the alternative is holding embeddings for photos nobody is editing.
struct EncoderCache {
  uint64_t key = 0;
  Sam2Embedding embedding;
};

// FNV-1a over the pixel bytes, eight at a time. A cache key, not a content address: this
// runs on every prompt and sha-256 over 4 MB would cost more than the decode it saves.
uint64_t image_key(const Rgb8Image& image) {
  uint64_t hash = 0xcbf29ce484222325ULL;
  const auto mix = [&hash](uint64_t value) { hash = (hash ^ value) * 0x100000001b3ULL; };
  mix(image.width);
  mix(image.height);
  const size_t words = image.pixels.size() / sizeof(uint64_t);
  for (size_t i = 0; i < words; ++i) {
    uint64_t word = 0;
    std::memcpy(&word, image.pixels.data() + (i * sizeof(uint64_t)), sizeof(uint64_t));
    mix(word);
  }
  for (size_t i = words * sizeof(uint64_t); i < image.pixels.size(); ++i) {
    mix(image.pixels[i]);
  }
  return hash;
}

class OrtMaskDetector : public MaskDetector {
 public:
  std::string name() const override { return "onnxruntime"; }

  // Runs on the single worker thread (jobs/worker.h), which is what lets the cache below
  // be a plain member.
  MaskDetectResult detect(const MaskDetectRequest& request) override {
    MaskDetectResult result;
    if (request.image.width == 0 || request.image.height == 0) {
      result.message = "mask.detect has no image to look at";
      return result;
    }
    try {
      return route(request);
    } catch (const Ort::Exception& error) {
      result.message = std::string("onnxruntime: ") + error.what();
      return result;
    } catch (const std::exception& error) {
      result.message = error.what();
      return result;
    }
  }

 private:
  MaskDetectResult route(const MaskDetectRequest& request) {
    switch (request.kind) {
      case MaskKind::Objects:
        return run_objects(request);
      case MaskKind::Text:
        return run_text(request);
      case MaskKind::Subject:
      case MaskKind::Background:
        return run_salient(request);
      case MaskKind::Sky:
      case MaskKind::People:
        return run_semantic(request);
      case MaskKind::Depth: {
        MaskDetectResult result;
        result.message = "depth masks are not implemented yet";
        return result;
      }
      default: {
        MaskDetectResult result;
        result.message = "mask kind '" + std::string(mask_kind_name(request.kind)) +
                         "' rasterises inline, not through a model";
        return result;
      }
    }
  }

  static MaskDetectResult missing(std::string_view model) {
    MaskDetectResult result;
    result.message = missing_model_message(model);
    return result;
  }

  Sam2Embedding& embed(Sam2& sam, const Rgb8Image& image) {
    const uint64_t key = image_key(image);
    if (cache_.key != key) {
      cache_.embedding = sam.encode(image);
      cache_.key = key;
    }
    return cache_.embedding;
  }

  MaskDetectResult run_objects(const MaskDetectRequest& request) {
    if (!model_installed(kSam2Model)) return missing(kSam2Model);
    const std::optional<DetectionBox> box = box_param(request.params, request.image);
    std::vector<Sam2Point> points = points_param(request.params, request.image);
    if (!box.has_value() && points.empty()) {
      MaskDetectResult result;
      result.message = "an objects mask needs a box or a point to start from";
      return result;
    }

    Sam2 sam(model_dir(kSam2Model));
    std::vector<Sam2Point> prompt =
        box.has_value() ? prompt_from_box(*box) : std::vector<Sam2Point>();
    prompt.insert(prompt.end(), points.begin(), points.end());

    MaskDetectResult result;
    result.ok = true;
    result.model = std::string(kSam2Model);
    result.raster = plane_to_gray(
        sam.decode(embed(sam, request.image), prompt, request.image.width, request.image.height),
        request.image.width, request.image.height);
    return result;
  }

  MaskDetectResult run_text(const MaskDetectRequest& request) {
    if (!model_installed(kFlorenceModel)) return missing(kFlorenceModel);
    if (!model_installed(kSam2Model)) return missing(kSam2Model);
    const std::string prompt = request.params.value("prompt", std::string());
    if (prompt.empty()) {
      MaskDetectResult result;
      result.message = "a text mask needs a prompt";
      return result;
    }

    std::optional<DetectionBox> box;
    {
      // Florence and SAM 2 must not be resident together: 16 GB with ComfyUI next door
      // does not stretch that far. The scope drops 1.25 GB of graphs before SAM 2 loads.
      Florence2 florence(model_dir(kFlorenceModel));
      box = florence.detect(request.image, prompt);
    }
    if (!box.has_value()) {
      MaskDetectResult result;
      result.message = "nothing matched \"" + prompt + "\"";
      return result;
    }

    Sam2 sam(model_dir(kSam2Model));
    MaskDetectResult result;
    result.ok = true;
    result.model = std::string(kFlorenceModel) + "+" + std::string(kSam2Model);
    result.raster = plane_to_gray(sam.decode(embed(sam, request.image), prompt_from_box(*box),
                                             request.image.width, request.image.height),
                                  request.image.width, request.image.height);
    return result;
  }

  MaskDetectResult run_salient(const MaskDetectRequest& request) {
    if (!model_installed(kBiRefNetModel)) return missing(kBiRefNetModel);
    BiRefNetLite birefnet(model_dir(kBiRefNetModel));
    std::vector<float> alpha = birefnet.alpha(request.image);
    if (request.kind == MaskKind::Background) {
      // 1 - matte, not the inverse of a threshold: the matte keeps hair and fur soft.
      for (float& value : alpha) {
        value = 1.0F - value;
      }
    }
    MaskDetectResult result;
    result.ok = true;
    result.model = std::string(kBiRefNetModel);
    result.raster = plane_to_gray(alpha, request.image.width, request.image.height);
    return result;
  }

  MaskDetectResult run_semantic(const MaskDetectRequest& request) {
    if (!model_installed(kSegFormerModel)) return missing(kSegFormerModel);
    SegFormerAde segformer(model_dir(kSegFormerModel));
    const int class_id =
        request.kind == MaskKind::Sky ? segformer.sky_class() : segformer.person_class();
    MaskDetectResult result;
    result.ok = true;
    result.model = std::string(kSegFormerModel);
    result.raster = plane_to_gray(segformer.class_probability(request.image, class_id),
                                  request.image.width, request.image.height);
    return result;
  }

  EncoderCache cache_;
};

}  // namespace

std::unique_ptr<MaskDetector> make_mask_detector() {
  const char* stub = std::getenv("LATENT_MASK_STUB");
  if (stub != nullptr && std::string_view(stub) == "1") {
    return std::make_unique<StubDetector>();
  }
  return std::make_unique<OrtMaskDetector>();
}

}  // namespace latent
