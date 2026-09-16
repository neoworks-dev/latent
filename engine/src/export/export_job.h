// The export job: everything between "the options parsed" and "the files are on disk",
// with the two things it cannot own — rendering, which needs the GPU thread, and progress,
// which needs the socket — passed in as callbacks. That is what lets the Catch2 tests run
// a whole job with a stub renderer and no device.
#pragma once

#include "export/encoder.h"
#include "export/export_options.h"

#include <cstdint>

#include <functional>
#include <string>
#include <vector>

namespace latent {

struct ExportTarget {
  int64_t photo_id = 0;
  std::string source_path;
  std::string output_path;
};

// One output path per photo, in the order the ids were given. Two photos whose names
// collide after the template is applied get `-2`, `-3` … appended rather than silently
// overwriting each other; an existing file on disk is still overwritten, because
// re-exporting the same edit to the same folder is the normal case.
std::vector<ExportTarget> plan_export(const ExportOptions& options,
                                      const std::vector<int64_t>& photo_ids,
                                      const std::vector<std::string>& source_paths);

struct ExportCallbacks {
  // Renders one photo at full resolution. Throws to fail just that photo.
  std::function<Rgb16Image(const ExportTarget&)> render;
  // done, total, and the file being written — `job.progress`'s `message`.
  std::function<void(size_t, size_t, const std::string&)> progress;
  std::function<bool()> cancelled;
  std::function<void(const std::string&)> warn;
};

struct ExportOutcome {
  size_t written = 0;
  size_t done = 0;
  bool cancelled = false;
  // The first failure's message; the job keeps going and reports it at the end, because
  // one unreadable photo should not throw away a batch of forty.
  std::string error;
};

ExportOutcome run_export(const ExportOptions& options, const std::vector<ExportTarget>& targets,
                         const ExportCallbacks& callbacks);

}  // namespace latent
