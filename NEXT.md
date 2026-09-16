# Next

Status and backlog. `PROMPT.md` §7 holds the phases; this file holds what is left, in the
order it should land. Each line is one agent-sized task with disjoint files. Strike lines
as they commit.

## Done — 2026-09-16

Phase 0 spine; Phase 0.5 sliders, panels, rail modes, filmstrip/library, console; Phase 1
masks and layers end to end (all mask kinds, AI detection through ORT, brush/linear/radial/
luminance/colour, layer list), tone curve editor, HSL mixer, upright thumbnails,
`contentRect`. Commits `d33a6d2`, `db0ef0b`, `23fb732`.

Round of five, same day: export (JPEG/TIFF16/PNG16/AVIF, lcms2 ICC, full-res masks, job,
`latent.export`, MCP `export`, pane); crop tool with `view.render { geometry: "full" }`;
masks in image space through one geometry matrix (`engine/src/ops/geometry`), sidecar
migration, viewer zoom/pan; HDR + panorama + HDR-pano merge into 16-bit linear TIFF
sources; generative fill/remove through ComfyUI (SDXL inpaint ran, Flux Fill wired) with
`inputHash`/`stale` and a composite pass; `Taskfile.yml` → AppImage. Found on the way:
`-rdynamic` exported vcpkg's zlib into cuDNN (segfault on every Florence-2 run in the
daemon; fixed with `--exclude-libs`).

## Blocking real use

1. `mask.refresh { photoId, opId, componentId? }` and a `stale` push: luminance/colour
   rasters are keyed on mask JSON only and do not follow the op's input.
2. Working space: the engine is linear sRGB primaries (LibRaw `output_color = 1`), the plan
   said Rec.2020. Decide: keep sRGB (docs now say so) or switch decode + `display.wgsl` +
   export matrices + the merge sidecar's `colorSpace` flag in one commit.
3. Export blocks the socket for one full-res render (0.3–1.5 s per 24 MP photo on the server
   thread); moving the GPU off the server thread is the real fix. Tiled export above
   `maxTextureDimension2D`. EXIF/IPTC in exported files. Export presets.
4. Merged photos are not stacked with their sources (needs a catalog stack concept); a
   re-scan does not re-import a merged `.tif` (`is_raw_extension`).

## UI gaps against Lightroom

5. Colour-grading wheels (shadows/midtones/highlights/global, blending, balance).
6. WB `mode` hides the inactive Temperature pair; sub-slider disclosure so the tone-curve
   region sliders stop reading as duplicate Highlights/Shadows; Info rail icon after Layers.
7. Crop: Upright/Constrain-Crop toggle, guide dropdown (rule-of-thirds only), crop rect
   under zoom/pan (draw through the painter's `map`, read `imageX/imageY`).
8. Mask polish: rename and nesting, overlay colour picker with opacity, colour-range
   eyedropper, `people` per person (SAM 2 seeded from SegFormer components), background
   points (needs a label per point in `MaskComponent.params.points`), tablet pressure,
   radial `angle` agreement between shader and painter on non-square photos.
9. Mixer per-band track tint (add `band` to `OpParamDisplay`), curve preset dropdown
   (Linear / Medium / Strong), endpoints slidable along the edges.
10. Generative: a text control in the generated panel (`display.kind: "text"` renders as
    the placeholder row today); Lightroom's Fill Edges for panoramas; download Flux Fill
    (`flux1-fill-dev`, `ae`, `clip_l`, `t5xxl_fp16`, ≈24 GB) — the graph switches on.
11. Viewer: before/after, compare pane, histogram with clipping.
12. Presets (save/apply/folder), copy/paste edits, batch apply across a selection.

## Perf

13. Half-res proxy while dragging: the one frame-path lever left (PROMPT §8.1; ~11 ms of
    WebSocket receive is bytes). Zoom did not move the budget (1:1 38.5 ms p50 total).
14. `catalog.thumbnails` cancellation and priority for the visible page.
15. Mask/AI rasters are stored at fit resolution and upsampled past 1:1; a zoom-aware
    raster tier must not land inside a stroke drag.
16. Panorama: feathered blend and no per-frame vignetting compensation (faint bands in flat
    sky); feature-matched homographies would lift the translation-only limit.

## Agent surface

17. Typed MCP tools beyond the eleven: stack edits, mask components, catalog filters.
18. Named snapshots and virtual copies in the sidecar.

## Phase 2–3, unchanged

19. `point_color`, `upright`, lens profiles (deferred from the op set).
20. Lens blur, AI denoise, enhance (same raster-op mechanics as generative fill).
21. Float/DNG output for merges (16-bit linear TIFF bounds a 6 EV bracket to ~10 bits).
22. SegFormer-B2 is NVIDIA NC-licensed: swap it before any sale. Model fetch on first run
    from the packaged app; flatpak next to the AppImage; real icon.
