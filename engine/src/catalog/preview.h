// Catalog previews: the decoded photo at proxy resolution, cached as a 16-bit linear TIFF
// under ~/.cache/latent/previews. Keyed by the file's content hash the way a thumbnail is,
// so two rows of the same bytes share one preview and a re-import regenerates nothing.
//
// Why: photo.open's LibRaw decode is ~530 ms for 24 MP, which is the whole cost of moving
// between photos. A preview holds the same pixels the viewer shows at fit zoom and loads
// in tens of milliseconds, so an import can leave every photo ready to open. Full
// resolution is still decoded when something needs it — export, or zoom past the proxy.
//
// Generating one costs ~150 ms rather than a full decode, because nothing here reads the
// full-resolution pixels: the prewarm passes this long edge to decode_raw as its
// `min_long_edge` and gets a half-resolution decode with no demosaic (raw/raw_decode.h).
//
// Why a TIFF and not a private format: 16-bit linear deflate TIFF is already what a merge
// writes (merge/source_image.h), libtiff is already a dependency, and a cache anything can
// open is a cache that can be looked at when a preview comes out wrong.
#pragma once

#include "raw/raw_decode.h"

#include <cstdint>

#include <optional>
#include <string>

namespace latent {

// Long edge of a cached preview: enough for a fit-zoom view on a 4K display. Anything
// sharper than this is a full-res decode away.
constexpr uint32_t kPreviewLongEdge = 2048;

std::string preview_cache_path(const std::string& key);

// std::nullopt when the file is not cached, is from another version, or cannot be read.
// Never throws: a broken cache entry is a cache miss, not a failed open.
std::optional<DecodedRaw> read_cached_preview(const std::string& cache_path);

// Scales an already-decoded photo into the cache and returns the scaled copy. The decode
// itself stays with the caller: this library is the headless half, and reaching decode_raw
// from here would put latent_catalog behind latent_core, which is behind it.
DecodedRaw write_preview(const DecodedRaw& decoded, const std::string& cache_path);

// Drops one key's preview. Used by catalog.remove; never touches the photo.
void forget_previews(const std::string& key);

// The cache ceiling in bytes: `LATENT_PREVIEW_CACHE_GB` when it is set and parses, else
// the default. Zero turns the cache off.
uint64_t preview_cache_budget();

// Deletes least-recently-used entries until the cache fits `budget_bytes`, and returns
// what is left. Reading an entry touches its mtime, so "least recently used" is literal.
uint64_t prune_preview_cache(uint64_t budget_bytes);

}  // namespace latent
