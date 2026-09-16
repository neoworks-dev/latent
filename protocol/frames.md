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

## `LTHM` — thumbnail (engine → UI)

Same header as `LFRM` with `viewId` replaced by `photoId` (u32). JPEG bytes follow the
32-byte header instead of raw pixels; `format` = 1 (jpeg).
