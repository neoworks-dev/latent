// Photos that arrive already developed: PNG and JPEG. Latent's truth is an op-stack over
// linear pixels, so a rendered file is linearised on the way in and joins the same pipeline
// a raw does. The differences are that the demosaic is already done, that the metadata comes
// from exiv2 instead of LibRaw, and that 8 bits of source cannot take a shadow lift the way
// a sensor's 14 can — the file's limit, not the engine's.
#pragma once

#include "image/jpeg.h"
#include "raw/raw_decode.h"
#include "raw/raw_metadata.h"

#include <cstdint>

#include <string>

namespace latent {

// True for png/jpg/jpeg, case-insensitive.
bool is_rendered_extension(const std::string& path);

// True for everything the catalog imports on its extension alone: a raw, a PNG or a JPEG.
// A merged .tif is not here — it is recognised by the sidecar beside it, and that check
// lives in latent_merge, one library up.
bool is_photo_extension(const std::string& path);

// PNG or JPEG to the 16-bit linear RGBA `decode_raw` produces. The file's transfer function
// is undone, its ICC profile (sRGB when it carries none) is transformed onto the working
// space's linear sRGB primaries, EXIF orientation is baked into the pixels the way LibRaw
// bakes a camera flip, and alpha is composited onto white.
//
// `min_long_edge` is `decode_raw`'s proxy hint, with the same meaning: a JPEG honours it
// with a scaled DCT decode, a PNG has no such trick and always decodes whole. Callers that
// pass it must read `width`/`height` back.
//
// Throws std::runtime_error when the file will not decode.
DecodedRaw decode_rendered_image(const std::string& path, uint32_t min_long_edge = 0);

// exiv2 rather than LibRaw. Fields the file does not carry stay empty or zero; a PNG with
// no eXIf chunk still reports its dimensions.
RawMetadata read_rendered_metadata(const std::string& path);

// The two calls above dispatched on extension, LibRaw for a raw. The catalog and the
// thumbnailer go through these; a merged .tif still needs its own branch at the call site.
RawMetadata read_photo_metadata(const std::string& path);
Rgb8Image load_photo_preview(const std::string& path, uint32_t max_edge);

}  // namespace latent
