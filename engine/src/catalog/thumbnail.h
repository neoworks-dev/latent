// Catalog thumbnails: JPEG, long edge `size`, cached under ~/.cache/latent/thumbs. The
// cache key is the file's content hash when we have one, so two catalog rows for the same
// bytes share a thumbnail and re-importing does not regenerate it.
#pragma once

#include <cstdint>

#include <optional>
#include <string>
#include <vector>

namespace latent {

struct Thumbnail {
  std::vector<uint8_t> jpeg;
  uint32_t width = 0;
  uint32_t height = 0;
};

std::string thumbnail_cache_path(const std::string& key, uint32_t size);

// std::nullopt when the file is not cached yet. Never throws for a missing file.
std::optional<Thumbnail> read_cached_thumbnail(const std::string& cache_path);

// Decodes the raw (embedded preview first, half-size demosaic second), writes the cache
// entry and returns it. Slow: only ever call this from a worker thread.
Thumbnail make_thumbnail(const std::string& raw_path, const std::string& cache_path, uint32_t size);

// Drops every cached size for one key. Used by catalog.remove; never touches the raw.
void forget_thumbnails(const std::string& key);

}  // namespace latent
