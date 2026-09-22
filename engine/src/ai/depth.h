// Monocular depth: Depth Anything V2 Small (DINOv2-S backbone, DPT head, Apache-2.0).
//
// What it answers is *relative inverse* depth — big where something is near, small where
// it is far, with no unit and no zero point — normalised per image into 0..1. That is
// enough for what Latent does with it: the `relight` op places a virtual light at a depth
// on the same scale and only ever compares two of them, and the `depth` mask kind turns a
// band of it into a selection. Nothing here reconstructs metric distance and nothing should
// start to.
//
// One depth map belongs to the *photo*, not to an edit: it describes the scene, so no
// slider can make it stale (src/server/server.cpp caches it under the sidecar directory).
#pragma once

#include "image/gray.h"
#include "image/jpeg.h"

#include <cstdint>
#include <onnxruntime_cxx_api.h>

#include <array>
#include <memory>
#include <string>
#include <vector>

namespace latent {

class DepthAnythingV2 {
 public:
  explicit DepthAnythingV2(const std::string& directory);

  // 0..1 nearness at the image's own size, 1 being the closest thing in frame. The graph's
  // spatial dimensions are dynamic in multiples of 14; this feeds the square `image_size`
  // from config.json and resizes the answer back, which is the upstream DPTImageProcessor
  // with `keep_aspect_ratio` off.
  std::vector<float> depth(const Rgb8Image& image);

 private:
  uint32_t image_size_ = 518;
  std::array<float, 3> mean_{};
  std::array<float, 3> deviation_{};
  std::string input_name_;
  std::string output_name_;
  Ort::Session session_;
};

// Normalises one plane of inverse depth into 0..1 against its own 1st and 99th percentile.
// Not min/max: a single blown pixel of sky or one lens flare otherwise takes the whole
// range and flattens the scene into a handful of levels. Exposed for the tests.
void normalize_depth(std::vector<float>& plane);

struct DepthRequest {
  // The photo as the engine renders it with no geometry op applied, display-referred sRGB,
  // long edge ~1024 — the same image space a mask raster is stored in.
  Rgb8Image image;
};

struct DepthResult {
  bool ok = false;
  // Why it failed, for job.progress's `error`.
  std::string message;
  // What produced the map, so a model change reads as a different cache entry.
  std::string model;
  // 0 = farthest, 65535 = nearest. 16-bit because a sky is a very shallow gradient over a
  // very large area: at 8 bits the relight pass reads its quantisation steps as terraces and
  // draws a contour line along every one of them.
  Gray16Image map;
};

// The seam `depth.estimate` goes through, so the whole path — job, progress, PNG cache,
// relight pass — can be exercised without a 50 MB checkpoint.
class DepthEstimator {
 public:
  virtual ~DepthEstimator() = default;
  DepthEstimator() = default;
  DepthEstimator(const DepthEstimator&) = delete;
  DepthEstimator& operator=(const DepthEstimator&) = delete;

  virtual std::string name() const = 0;
  // Runs on the worker thread: no engine state, no GPU, no socket.
  virtual DepthResult estimate(const DepthRequest& request) = 0;
};

// The stub when LATENT_DEPTH_STUB=1 is set in the environment, otherwise onnxruntime.
std::unique_ptr<DepthEstimator> make_depth_estimator();

}  // namespace latent
