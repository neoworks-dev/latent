# Binary frames

All multi-byte integers little-endian. Every binary frame starts with a 4-byte ASCII magic.

## `LFRM` — preview frame (engine → UI)

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `LFRM` |
| 4 | 4 | width (u32) |
| 8 | 4 | height (u32) |
| 12 | 4 | seq (u32), monotonically increasing per view |
| 16 | 4 | viewId (u32), which `view.open` this belongs to |
| 20 | 4 | format (u32): 0 = rgba8 sRGB |
| 24 | 8 | reserved |
| 32 | w·h·4 | pixels, row-major, tightly packed |

The UI draws the newest `seq` it has and drops older ones. The engine sends one frame per
completed render; the UI keeps at most one `view.render` request in flight per view.

The 8 `reserved` bytes stay zero and stay reserved: the layout is fixed, and anything new
a frame has to say goes in the JSON result of the call that produced it, not here.

## `LMSK` — mask raster (engine → UI)

Same header as `LFRM`; `viewId` holds the `viewId` the preview was sized for (0 when
`mask.preview` was called without one); `format` = 2 (r8, one byte per pixel, 0 = outside,
255 = fully inside); `seq` increments per `mask.preview` call on that socket. The body is
`w·h` bytes, tightly packed. Sent by `mask.preview`, exactly one frame **before** its RPC
result. The UI tints it over the view frame; it never uploads a mask back.

## `LTHM` — thumbnail (engine → UI)

Same header as `LFRM` with `viewId` replaced by `photoId` (u32). JPEG bytes follow the
32-byte header instead of raw pixels; `format` = 1 (jpeg).

**The photo id is a u32, and that is the contract.** `PhotoId` is a SQLite rowid (i64), so
the frame caps thumbnails at **4294967295**. The engine refuses a larger id with an RPC
error (`-32602`) instead of sending a frame whose target wrapped around: `catalog.thumbnail`
fails, and so does `catalog.thumbnails` — for the batch too, because an id that cannot be
labelled is a malformed request, not a photo that failed to render, so it is not listed in
`missing`. Widening the field would mean a new magic and a second parser on both sides; a
catalog would need four billion rows before it mattered.

Sent by `catalog.thumbnail` (one photo) and `catalog.thumbnails` (a batch, one frame per
photo). Every frame goes out **before** the RPC result, so a client that subscribes before
it calls has the pixels by the time the result names their size.

A thumbnail that cannot be produced — unknown photoId, unreadable file, decode failure —
is **never** a frame. `catalog.thumbnail` answers with an RPC error; `catalog.thumbnails`
succeeds and lists the id in `missing`. There is no empty frame, no zero-length payload and
no `format` value meaning "failed": a frame that exists carries a decodable JPEG.
