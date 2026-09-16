#include "export/export_job.h"

#include "export/color_space.h"

#include <filesystem>
#include <string>
#include <unordered_set>
#include <utility>

namespace latent {

namespace {

std::string uniquify(const std::string& name, std::unordered_set<std::string>& taken) {
  if (taken.insert(name).second) return name;
  const std::filesystem::path path(name);
  const std::string stem = path.stem().string();
  const std::string extension = path.extension().string();
  for (int suffix = 2; suffix < 10000; ++suffix) {
    std::string candidate = stem + "-" + std::to_string(suffix) + extension;
    if (taken.insert(candidate).second) return candidate;
  }
  return name;
}

}  // namespace

std::vector<ExportTarget> plan_export(const ExportOptions& options,
                                      const std::vector<int64_t>& photo_ids,
                                      const std::vector<std::string>& source_paths) {
  std::vector<ExportTarget> targets;
  targets.reserve(photo_ids.size());
  std::unordered_set<std::string> taken;
  const std::filesystem::path directory(options.output_dir);
  for (size_t i = 0; i < photo_ids.size(); ++i) {
    ExportTarget target;
    target.photo_id = photo_ids[i];
    target.source_path = i < source_paths.size() ? source_paths[i] : std::string();
    const std::string name =
        export_file_name(options.file_name_template, target.source_path, i + 1, options.format);
    target.output_path = (directory / uniquify(name, taken)).string();
    targets.push_back(std::move(target));
  }
  return targets;
}

ExportOutcome run_export(const ExportOptions& options, const std::vector<ExportTarget>& targets,
                         const ExportCallbacks& callbacks) {
  ExportOutcome outcome;
  EncodeOptions encode;
  encode.format = options.format;
  encode.quality = options.quality;
  encode.dpi = options.resize.dpi;
  encode.icc = export_icc_profile(options.color_space);

  std::filesystem::create_directories(options.output_dir);

  for (const ExportTarget& target : targets) {
    if (callbacks.cancelled && callbacks.cancelled()) {
      outcome.cancelled = true;
      break;
    }
    // The path goes out before the work, not after: a 24 MP render takes long enough that
    // a bar naming the file it is on is the only useful thing to show.
    if (callbacks.progress) callbacks.progress(outcome.done, targets.size(), target.output_path);
    try {
      const Rgb16Image image = callbacks.render(target);
      const std::vector<uint8_t> bytes = encode_export(image, encode);
      write_export_file(target.output_path, bytes);
      ++outcome.written;
    } catch (const std::exception& error) {
      const std::string message = "export failed for " + target.output_path + ": " + error.what();
      if (outcome.error.empty()) outcome.error = message;
      if (callbacks.warn) callbacks.warn(message);
    }
    ++outcome.done;
  }
  return outcome;
}

}  // namespace latent
