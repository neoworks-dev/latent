# HDR Optimization

Source: https://helpx.adobe.com/lightroom/desktop/edit-photos/hdr-output.html (fetched 2026-09-16 — direct fetch returned an empty tracker-pixel stub via proxy after multiple retries; content below reconstructed via WebSearch summary, see README)

HDR displays offer greater brightness/contrast than SDR displays; photos optimized for HDR have brighter highlights and more detailed shadows. This feature is about editing/viewing/exporting an already-HDR-capable image — distinct from `hdr-panorama.md`'s Merge to HDR, which combines multiple exposures into one HDR file. Source images can be a single-exposure raw file, an iPhone HEIF, or a file created via Merge to HDR.

## HDR editing controls

| Control | Range | Description |
|---|---|---|
| HDR toggle (Edit > HDR / HDR icon) | on/off | Enables HDR editing for the current photo; automatically shows the Histogram |
| Visualize HDR | on/off | Checkbox to preview HDR data directly on the photo |
| Whites clipping indicator (in HDR mode) | n/a | Shows which pixels are in the HDR range: yellow = HDR pixels your monitor can currently display, red = HDR pixels your monitor cannot currently display |

## Histogram (HDR mode)

- Dotted white lines mark parts of the image brighter than the White slider's parameter.
- The gray bar at the base of the Histogram reflects device screen brightness (increases as you decrease device brightness, and vice versa).

## Notes / unverified

- Lightroom Classic's HDR Output documentation describes an **HDR Limit** slider (highlight headroom) and separate **SDR Rendition** controls (for previewing/exporting an HDR photo on an SDR display). It is unconfirmed whether identical controls exist in Lightroom desktop (cloud) — flagged as unstated/unverified rather than assumed present.
