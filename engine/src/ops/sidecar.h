// `<photo>.latent` — the on-disk form of one photo's stack (PROMPT.md 3.3). The engine
// is the only writer; it rewrites the file on every non-transient change.
#pragma once

#include "ops/op.h"

#include <optional>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace latent {

struct Sidecar {
  int version = 1;
  std::string source_path;
  std::string source_hash;
  Stack stack;
};

std::string sidecar_path_for(std::string_view photo_path);

nlohmann::json sidecar_to_json(const Sidecar& sidecar);
Sidecar sidecar_from_json(const nlohmann::json& value);

// Writes via a temporary file and a rename so a crash cannot truncate an existing
// sidecar. Throws std::runtime_error on I/O failure.
void write_sidecar(const std::string& path, const Sidecar& sidecar);

// std::nullopt when the file does not exist. Throws OpError when it exists but is junk.
std::optional<Sidecar> read_sidecar(const std::string& path);

}  // namespace latent
