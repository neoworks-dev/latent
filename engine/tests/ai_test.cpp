// The parts of engine/src/ai that can be checked without a GPU, a 1.8 GB model store or a
// network: the resampler and normaliser every model shares, the byte-level BPE that
// replaces a tokenizer dependency, and the routing table that decides which model a mask
// kind reaches. The two tests that do want the store detect it and skip when it is absent,
// so ctest stays green on a machine that has never run scripts/models/fetch.py.
#include "ai/bpe_tokenizer.h"
#include "ai/florence2.h"
#include "ai/mask_detect.h"
#include "ai/model_store.h"
#include "ai/preprocess.h"

#include <cstdlib>

#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using namespace latent;

namespace {

Rgb8Image solid(uint32_t width, uint32_t height, uint8_t red, uint8_t green, uint8_t blue) {
  Rgb8Image image;
  image.width = width;
  image.height = height;
  image.pixels.reserve(static_cast<size_t>(width) * height * 3);
  for (size_t i = 0; i < static_cast<size_t>(width) * height; ++i) {
    image.pixels.push_back(red);
    image.pixels.push_back(green);
    image.pixels.push_back(blue);
  }
  return image;
}

// Swaps the model store for the duration of a test and puts the old one back.
class StoreOverride {
 public:
  explicit StoreOverride(const std::string& root) {
    const char* previous = std::getenv("LATENT_MODEL_STORE");
    if (previous != nullptr) {
      had_previous_ = true;
      previous_ = previous;
    }
    setenv("LATENT_MODEL_STORE", root.c_str(), 1);
  }
  ~StoreOverride() {
    if (had_previous_) {
      setenv("LATENT_MODEL_STORE", previous_.c_str(), 1);
    } else {
      unsetenv("LATENT_MODEL_STORE");
    }
  }
  StoreOverride(const StoreOverride&) = delete;
  StoreOverride& operator=(const StoreOverride&) = delete;

 private:
  bool had_previous_ = false;
  std::string previous_;
};

MaskDetectResult detect_kind(MaskDetector& detector, MaskKind kind, nlohmann::json params) {
  MaskDetectRequest request;
  request.kind = kind;
  request.params = params.is_object() ? std::move(params) : nlohmann::json::object();
  request.image = solid(16, 12, 40, 80, 120);
  return detector.detect(request);
}

}  // namespace

TEST_CASE("preprocess normalises and squashes to a square", "[ai]") {
  // One flat colour: the resize cannot change it, so only the normalisation is under test.
  const std::vector<float> tensor =
      preprocess_square(solid(2, 2, 0, 128, 255), 2, kImageNetMean, kImageNetStd, Filter::Bilinear);
  REQUIRE(tensor.size() == 2 * 2 * 3);
  const float red = (0.0F - 0.485F) / 0.229F;
  const float green = ((128.0F / 255.0F) - 0.456F) / 0.224F;
  const float blue = (1.0F - 0.406F) / 0.225F;
  for (size_t i = 0; i < 4; ++i) {
    CHECK(tensor[i] == Catch::Approx(red).epsilon(1e-5));
    CHECK(tensor[4 + i] == Catch::Approx(green).epsilon(1e-5));
    CHECK(tensor[8 + i] == Catch::Approx(blue).epsilon(1e-5));
  }
}

TEST_CASE("the resampler follows PIL's convention", "[ai]") {
  const std::vector<float> quad{0.0F, 100.0F, 200.0F, 40.0F};

  SECTION("downscaling averages, because the filter support grows with the ratio") {
    const std::vector<float> one = resample_plane(quad, 2, 2, 1, 1, Filter::Bilinear);
    REQUIRE(one.size() == 1);
    CHECK(one[0] == Catch::Approx(85.0F).epsilon(1e-5));
  }

  SECTION("upscaling is plain bilinear with align_corners=False") {
    const std::vector<float> wide = resample_plane(quad, 2, 2, 4, 2, Filter::Bilinear);
    REQUIRE(wide.size() == 8);
    // Output centres land at 0.25, 0.75, 1.25 and 1.75 source pixels.
    CHECK(wide[0] == Catch::Approx(0.0F));
    CHECK(wide[1] == Catch::Approx(25.0F).epsilon(1e-5));
    CHECK(wide[2] == Catch::Approx(75.0F).epsilon(1e-5));
    CHECK(wide[3] == Catch::Approx(100.0F));
  }

  SECTION("an unchanged size is a copy, not a filter pass") {
    CHECK(resample_plane(quad, 2, 2, 2, 2, Filter::Bilinear) == quad);
  }
}

TEST_CASE("a 0..1 plane becomes an r8 raster", "[ai]") {
  const std::vector<float> plane{-0.5F, 0.0F, 0.5F, 1.5F};
  const GrayImage raster = plane_to_gray(plane, 4, 1);
  REQUIRE(raster.width == 4);
  REQUIRE(raster.height == 1);
  CHECK(raster.pixels == std::vector<uint8_t>{0, 0, 128, 255});
}

TEST_CASE("mask.detect routes every kind to the model that owns it", "[ai]") {
  // An empty store makes each kind report the model it wanted, which is the routing table
  // observed from outside — no GPU, no weights, no inference.
  const std::string empty = std::string(LATENT_TEST_FIXTURES) + "/empty-model-store";
  StoreOverride override_store(empty);
  const std::unique_ptr<MaskDetector> detector = make_mask_detector();
  REQUIRE(detector->name() == "onnxruntime");

  const nlohmann::json box = {{"box", {0.2, 0.2, 0.8, 0.8}}};
  CHECK(detect_kind(*detector, MaskKind::Objects, box).message ==
        "model sam2-hiera-base-plus not installed (run scripts/models/fetch.py)");
  CHECK(detect_kind(*detector, MaskKind::Text, {{"prompt", "the hat"}}).message ==
        "model florence-2-base not installed (run scripts/models/fetch.py)");
  CHECK(detect_kind(*detector, MaskKind::Subject, {}).message ==
        "model birefnet-lite not installed (run scripts/models/fetch.py)");
  CHECK(detect_kind(*detector, MaskKind::Background, {}).message ==
        "model birefnet-lite not installed (run scripts/models/fetch.py)");
  CHECK(detect_kind(*detector, MaskKind::Sky, {}).message ==
        "model segformer-b2-ade20k not installed (run scripts/models/fetch.py)");
  CHECK(detect_kind(*detector, MaskKind::People, {}).message ==
        "model segformer-b2-ade20k not installed (run scripts/models/fetch.py)");

  // Two kinds never reach a model at all.
  CHECK(detect_kind(*detector, MaskKind::Depth, {}).message ==
        "depth masks are not implemented yet");
  CHECK(detect_kind(*detector, MaskKind::Brush, {}).message ==
        "mask kind 'brush' rasterises inline, not through a model");

  for (MaskKind kind :
       {MaskKind::Objects, MaskKind::Text, MaskKind::Subject, MaskKind::Sky, MaskKind::Depth}) {
    CHECK_FALSE(detect_kind(*detector, kind, box).ok);
  }
}

TEST_CASE("an objects mask without a hint says so instead of guessing", "[ai]") {
  if (!model_installed(kSam2Model)) {
    WARN("sam2-hiera-base-plus is not in the model store; skipping the empty-hint check");
    return;
  }
  const std::unique_ptr<MaskDetector> detector = make_mask_detector();
  const MaskDetectResult result = detect_kind(*detector, MaskKind::Objects, {});
  CHECK_FALSE(result.ok);
  CHECK(result.message == "an objects mask needs a box or a point to start from");
}

TEST_CASE("Florence-2's <loc_###> bins de-quantise to pixels", "[ai]") {
  // 1000 bins per axis, bin centre, truncated: scripts/models/florence2.py.
  const DetectionBox box = dequantize_box({0, 500, 999, 1000}, 1000, 2000);
  CHECK(box[0] == Catch::Approx(0.0F));
  CHECK(box[1] == Catch::Approx(1001.0F));
  CHECK(box[2] == Catch::Approx(999.0F));
  CHECK(box[3] == Catch::Approx(2001.0F));

  const std::vector<DetectionBox> boxes =
      parse_boxes("</s><s>the person<loc_401><loc_232><loc_741><loc_854></s>", 1000, 1000);
  REQUIRE(boxes.size() == 1);
  CHECK(boxes[0][0] == Catch::Approx(401.0F));
  CHECK(boxes[0][3] == Catch::Approx(854.0F));
  CHECK(parse_boxes("</s><s>a hat</s>", 100, 100).empty());
}

TEST_CASE("LATENT_MASK_STUB=1 still selects the shape generator", "[ai]") {
  setenv("LATENT_MASK_STUB", "1", 1);
  const std::unique_ptr<MaskDetector> detector = make_mask_detector();
  unsetenv("LATENT_MASK_STUB");
  CHECK(detector->name() == "stub-shapes");
  const MaskDetectResult result = detect_kind(*detector, MaskKind::Subject, {});
  CHECK(result.ok);
  CHECK(result.model == "stub-shapes");
}

TEST_CASE("the byte-level BPE agrees with the Python tokenizer", "[ai]") {
  if (!model_installed(kFlorenceModel)) {
    WARN("florence-2-base is not in the model store; skipping the tokenizer comparison");
    return;
  }
  const std::string fixture_path = std::string(LATENT_TEST_FIXTURES) + "/florence-tokenizer.json";
  std::ifstream fixture(fixture_path);
  REQUIRE(fixture.good());
  const nlohmann::json cases = nlohmann::json::parse(fixture)["cases"];
  REQUIRE(cases.size() >= 10);

  const BpeTokenizer tokenizer = BpeTokenizer::from_directory(model_dir(kFlorenceModel));
  for (const nlohmann::json& entry : cases) {
    const auto text = entry["text"].get<std::string>();
    const auto expected = entry["ids"].get<std::vector<int64_t>>();
    INFO("prompt: " << text);
    CHECK(tokenizer.encode(text) == expected);
  }
}

TEST_CASE("decoding keeps the <loc_###> tokens the box parser needs", "[ai]") {
  if (!model_installed(kFlorenceModel)) {
    WARN("florence-2-base is not in the model store; skipping the decode check");
    return;
  }
  const BpeTokenizer tokenizer = BpeTokenizer::from_directory(model_dir(kFlorenceModel));
  const std::vector<int64_t> ids = tokenizer.encode("the hat");
  CHECK(tokenizer.decode(ids) == "the hat");
  // 50269 is <loc_0>; the bins are added tokens, not merges, so they survive verbatim.
  CHECK(tokenizer.decode(std::vector<int64_t>{50269, 50270}) == "<loc_0><loc_1>");
}
