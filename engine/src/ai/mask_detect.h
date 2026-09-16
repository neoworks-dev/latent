// The one seam every AI mask kind goes through (PROMPT.md 3.7). `mask.detect` renders the
// stack below the op, hands it here on the worker thread, and the result lands back as a
// cached raster the component points at — never inline in a slider tick.
//
// Two implementations. `LATENT_MASK_STUB=1` selects a shape generator, so the whole path —
// job, progress, pending -> ready, sidecar, overlay — can be exercised end to end without a
// 400 MB checkpoint. Without it, onnxruntime on the CUDA EP (ai/ort_session.h), routed by
// kind: `objects` and `text` to SAM 2 (with Florence-2 in front of `text`, because SAM 2
// has no text input), `subject`/`background` to BiRefNet-lite, `sky`/`people` to
// SegFormer-B2 ADE20K. A model that is not in the store fails with a message naming it;
// stale is never auto-run and neither is missing.
#pragma once

#include "image/gray.h"
#include "image/jpeg.h"
#include "ops/mask.h"

#include <memory>
#include <string>

#include <nlohmann/json.hpp>

namespace latent {

struct MaskDetectRequest {
  MaskKind kind = MaskKind::Subject;
  // The component's params, with mask.detect's `hint` already merged in.
  nlohmann::json params = nlohmann::json::object();
  // The stack below the op, display-referred sRGB, long edge ~1024. The stub ignores it;
  // a real detector is nothing without it.
  Rgb8Image image;
};

struct MaskDetectResult {
  bool ok = false;
  // Why it failed, for job.progress's `error` and the component's params.error.
  std::string message;
  // What produced the raster, stored on the component so a model change reads as stale.
  std::string model;
  GrayImage raster;
};

class MaskDetector {
 public:
  virtual ~MaskDetector() = default;
  MaskDetector() = default;
  MaskDetector(const MaskDetector&) = delete;
  MaskDetector& operator=(const MaskDetector&) = delete;

  virtual std::string name() const = 0;
  // Runs on the worker thread: no engine state, no GPU, no socket.
  virtual MaskDetectResult detect(const MaskDetectRequest& request) = 0;
};

// The stub when LATENT_MASK_STUB=1 is set in the environment, otherwise the one that
// reports the model is missing.
std::unique_ptr<MaskDetector> make_mask_detector();

}  // namespace latent
