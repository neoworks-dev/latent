# Lightroom (desktop) edit operations — reference index

All pages fetched 2026-09-16 from `helpx.adobe.com` (direct `WebFetch` was blocked by an Akamai 403 for the entire domain; content was retrieved via the `r.jina.ai` reader proxy, with `WebSearch` used as a fallback for pages the proxy could not render). This directory is the source material for Latent's op-stack spec — the consolidated table at the bottom is the primary artifact.

## File index

| File | Covers |
|---|---|
| `profiles.md` | Profile panel: raw/creative profile groups, Amount slider, Favorites, import, manage groups |
| `presets.md` | Presets panel: Amount slider, Recommended/Premium/Subject/Yours categories, Favorites, manage groups |
| `light.md` | Light panel: Auto, Exposure, Contrast, Highlights, Shadows, Whites, Blacks; histogram interaction; clipping indicators |
| `curves.md` | Parametric Curve and Point Curve (RGB/R/G/B channels, presets, Refine Saturation) |
| `color.md` | Color Mixer (drag-to-adjust Hue/Saturation/Luminance); global Saturation/Vibrance references |
| `color-grading.md` | Color Grading: Shadows/Midtones/Highlights/Global wheels, Blending, Balance |
| `point-color.md` | Point Color: sampled-swatch Hue/Saturation/Luminance Shift, Variance, Range sliders |
| `effects.md` | Effects panel: Texture, Clarity, Dehaze, Vignette + sub-sliders |
| `detail.md` | Detail panel: Sharpening, Noise Reduction, Color Noise Reduction, Grain |
| `enhance-details.md` | Enhance dialog: Denoise, Raw Details, Super Resolution (separate stacked-DNG outputs) |
| `enhance-generative-ai.md` | Enhance with AI: Generative Upscale (Topaz), AI Sharpen (Topaz) |
| `optics.md` | Optics panel: Chromatic Aberration, Lens Corrections (Distortion/Vignetting), Defringe |
| `geometry.md` | Crop, Rotate, Flip, Geometry/Upright, Transform sliders |
| `extend-generative-expand.md` | Generative Expand: Enable Expand, Method (Firefly Fill & Expand / Content-Aware Fill) |
| `masking.md` | Masking panel: AI masks, manual masks (Brush/Gradient), Range masks, mask management, local-adjustment sliders |
| `remove-heal.md` | Remove tool family: Generative Remove, Detect Objects, Clone, Heal, Remove People, Reflection Removal, Dust Removal |
| `lens-blur.md` | Lens Blur: Blur Amount, Focus method, Aperture/bokeh shape, Highlights, Refinement (reconstructed — see Failed pages) |
| `hdr.md` | HDR Optimization: HDR toggle, Visualize HDR, clipping indicator (reconstructed — see Failed pages) |
| `hdr-panorama.md` | Photo Merge: Merge to HDR, Merge to Panorama, Merge to HDR Panorama |
| `calibration.md` | Note: no Calibration panel in Lightroom desktop (cloud); Lightroom Classic–only feature, included for reference |
| `versions.md` | Versions panel: Named/Auto tabs, Create Version, export a version |
| `copy-paste-edits.md` | Copy/Paste Edit Settings dialog, Reset To Original/Open (workflow, not a slider) |
| `content-credentials.md` | Content Credentials (C2PA export metadata — not a photo edit operation) |
| `generate-videos.md` | Generate Video (AI image-to-video — not a photo edit operation) |
| `edit-in-other-apps.md` | Send-to-external-app round trip (workflow, not a slider) |

## Source URLs (fetched 2026-09-16)

- https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html — main page (Profile, Light, Curves, Color, Color Grading, Point Color, Effects, Detail, Optics, Lens Blur (brief), Copy/Paste, Local Adjustments, Versions)
- https://helpx.adobe.com/lightroom/desktop/edit-photos/presets.html — Presets (fetch failed, reconstructed via WebSearch)
- https://helpx.adobe.com/lightroom/desktop/edit-photos/crop-rotate-geometry.html — Crop, Rotate, Geometry (also yielded the full left-nav TOC used to enumerate every "Edit photos" sub-page)
- https://helpx.adobe.com/lightroom/desktop/edit-photos/remove-tool.html — Generative Remove / Detect Objects
- https://helpx.adobe.com/lightroom/desktop/edit-photos/clone-tool.html — Clone tool
- https://helpx.adobe.com/lightroom/desktop/using/heal-tool.html — Heal tool
- https://helpx.adobe.com/lightroom/desktop/edit-photos/remove-people.html — Remove unwanted people (fetch failed, reconstructed via WebSearch)
- https://helpx.adobe.com/lightroom/desktop/edit-photos/remove-reflections.html — Reflection Removal
- https://helpx.adobe.com/lightroom/desktop/edit-photos/remove-dust.html — Dust Removal
- https://helpx.adobe.com/lightroom/desktop/edit-photos/masking.html — Masking
- https://helpx.adobe.com/lightroom/desktop/edit-photos/enhance-images-with-generative-ai.html — Generative Upscale / AI Sharpen
- https://helpx.adobe.com/lightroom/desktop/edit-photos/hdr-panorama.html — Merge to HDR / Panorama / HDR Panorama
- https://helpx.adobe.com/lightroom/desktop/edit-photos/hdr-output.html — HDR Optimization (fetch failed, reconstructed via WebSearch)
- https://helpx.adobe.com/lightroom/desktop/edit-photos/enhance-details.html — Denoise / Raw Details / Super Resolution
- https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-in-other-apps.html — Edit in other apps (nav-only in fetched content; cross-confirmed via WebSearch)
- https://helpx.adobe.com/lightroom/desktop/edit-photos/content-credentials-lightroom.html — Content Credentials
- https://helpx.adobe.com/lightroom/desktop/edit-photos/generate-videos-from-images.html — Generate Video
- https://helpx.adobe.com/lightroom/desktop/edit-photos/extend-photos-with-generative-expand.html — Generative Expand
- https://helpx.adobe.com/lightroom-cc/using/lens-blur.html — Lens Blur (fetch failed entirely; reconstructed via WebSearch, mixes Classic/desktop terminology)

## Failed pages / partial reconstructions

Direct fetching (`WebFetch`) was blocked (HTTP 403) for the entire `helpx.adobe.com` domain from this environment; all content was retrieved via the `r.jina.ai` reader proxy instead. The following pages additionally failed even through that proxy (returned an empty tracker-pixel stub, a 404, or a 422 after 3–4 retries with cache-bypass headers) and were reconstructed from `WebSearch` result summaries instead of the raw page text:

- `presets.html` — reconstructed (see `presets.md`)
- `hdr-output.html` — reconstructed (see `hdr.md`)
- `remove-people.html` — reconstructed (see `remove-heal.md`)
- Lens Blur dedicated page — could not locate a working desktop URL at all (`lightroom-cc/using/lens-blur.html` returned no content; `lightroom/desktop/using/lens-blur.html` returned 404); reconstructed from search results that blend Lightroom desktop and Lightroom Classic naming (see `lens-blur.md`)
- `edit-in-other-apps.html` — proxy returned mostly site navigation; short workflow description cross-confirmed via WebSearch

No dedicated Calibration page exists under Lightroom desktop's "Edit photos" docs at all — see `calibration.md`.

## Consolidated op-stack table

Every edit operation found across all panels. "Range" is exactly what Adobe's help text states; `unstated` means the page describes direction/effect but never gives numeric bounds — do not assume Lightroom Classic's classic ±100/±5 EV bounds apply to Lightroom desktop (cloud) without in-app verification.

| Panel | Control | Range |
|---|---|---|
| Profile | Profile selection | categorical |
| Profile | Amount (profile intensity) | unstated |
| Presets | Amount | 0–200 |
| Light | Auto | button |
| Light | Exposure | unstated |
| Light | Contrast | unstated |
| Light | Highlights | unstated |
| Light | Shadows | unstated |
| Light | Whites | unstated |
| Light | Blacks | unstated |
| Curves | Parametric Curve region | unstated |
| Curves | Point Curve control point | unstated |
| Curves | Point Curve preset | Linear / Medium Contrast / Strong Contrast |
| Curves | Refine Saturation | unstated |
| Color | Color Mixer (Hue/Saturation/Luminance drag) | unstated |
| Color | Saturation (global) | unstated |
| Color | Vibrance (global) | unstated |
| Color Grading | Color wheel (Shadows/Midtones/Highlights/Global) | drag position |
| Color Grading | Hue / Saturation / Luminance (Global) | unstated |
| Color Grading | Blending | unstated |
| Color Grading | Balance | unstated |
| Point Color | Hue Shift | unstated |
| Point Color | Saturation Shift | unstated |
| Point Color | Luminance Shift | unstated |
| Point Color | Variance | unstated |
| Point Color | Hue / Saturation / Luminance Range | unstated |
| Effects | Texture | unstated |
| Effects | Clarity | unstated |
| Effects | Dehaze | unstated |
| Effects | Vignette (Amount) | unstated |
| Effects | Vignette: Feather | unstated |
| Effects | Vignette: Midpoint | unstated |
| Effects | Vignette: Roundness | unstated |
| Effects | Vignette: Highlights | unstated |
| Detail | Sharpening (Amount) | unstated |
| Detail | Sharpening: Radius | unstated |
| Detail | Sharpening: Detail | unstated |
| Detail | Sharpening: Masking | unstated (0–100 implied) |
| Detail | Denoise (button) | on/off |
| Detail | Noise Reduction (Amount) | unstated |
| Detail | Noise Reduction: Detail | unstated |
| Detail | Noise Reduction: Contrast | unstated |
| Detail | Color Noise Reduction (Amount) | unstated |
| Detail | Color Noise Reduction: Detail | unstated |
| Detail | Color Noise Reduction: Smoothness | unstated |
| Detail | Grain (Amount) | unstated |
| Detail | Grain: Size | unstated (≥25 = blue tint) |
| Detail | Grain: Roughness | unstated |
| Enhance Details | Denoise (AI, full-image) | unstated Amount |
| Enhance Details | Raw Details | on/off |
| Enhance Details | Super Resolution | on/off (2x linear / 4x pixels) |
| Enhance (Generative AI) | Generative Upscale scale | 2x / 4x |
| Enhance (Generative AI) | AI Sharpen strength | Default / Strong |
| Optics | Remove Chromatic Aberration | on/off |
| Optics | Enable Lens Corrections | on/off |
| Optics | Distortion Correction | unstated (default 100) |
| Optics | Lens Vignetting | unstated (default 100) |
| Optics | Defringe: hue select | Purple / Green |
| Optics | Defringe: Amount | unstated |
| Optics | Defringe: Hue | unstated |
| Geometry | Crop overlay | n/a (drag) |
| Geometry | Aspect | categorical |
| Geometry | Constrain Aspect Ratio | on/off |
| Geometry | Straighten | unstated |
| Geometry | Constrain Crop | on/off |
| Geometry | Rotate Left/Right | 90° steps |
| Geometry | Flip Vertical / Horizontal | on/off |
| Geometry | Upright mode | Auto / Guided |
| Geometry | Transform: Distortion | unstated |
| Geometry | Transform: Vertical | unstated |
| Geometry | Transform: Horizontal | unstated |
| Geometry | Transform: Rotate | unstated |
| Geometry | Transform: Aspect | unstated |
| Geometry | Transform: Scale | unstated |
| Geometry | Transform: X Offset | unstated |
| Geometry | Transform: Y Offset | unstated |
| Generative Expand | Enable Expand | on/off |
| Generative Expand | Method | Firefly Fill & Expand / Content-Aware Fill |
| Masking | AI mask select | categorical (Subject/Sky/Background/Landscape/Objects/People) |
| Masking | Brush: Size | unstated |
| Masking | Brush: Feather | unstated |
| Masking | Brush: Flow | unstated |
| Masking | Brush: Density | unstated |
| Masking | Brush: Auto Mask | on/off |
| Masking | Radial Gradient: Feather | unstated |
| Masking | Color Range: Refine | unstated |
| Masking | Luminance Range: Select Luminance | unstated |
| Masking | Depth Range: Select Depth | unstated |
| Masking (local) | Feather | unstated |
| Masking (local) | Edge | unstated |
| Masking (local) | Exposure / Contrast / Highlights / Shadows / Whites / Blacks | unstated |
| Masking (local) | Curves | n/a |
| Masking (local) | Temp / Tint | unstated |
| Masking (local) | Hue / Saturation | unstated |
| Masking (local) | Colorize | on/off + hue |
| Masking (local) | Texture / Clarity / Dehaze | unstated |
| Masking (local) | Grain: Size / Roughness | unstated |
| Masking (local) | Sharpness | unstated (negative blurs) |
| Masking (local) | Noise Reduction | unstated |
| Masking (local) | Moiré | unstated |
| Masking (local) | Defringe | unstated |
| Masking (local) | Refine Saturation | unstated |
| Remove/Heal | Use generative AI (brush) | on/off |
| Remove/Heal | Detect objects | on/off |
| Remove/Heal | Remove: Size | unstated |
| Remove/Heal | Clone: Size / Feather / Opacity | unstated |
| Remove/Heal | Heal: Size / Feather / Opacity | unstated |
| Remove/Heal | Reflection Removal: Amount | -100 to 100 |
| Remove/Heal | Reflection Removal: Quality | Preview / Standard / Best |
| Remove/Heal | Dust Removal: Size | unstated |
| Remove/Heal | Dust Removal: Threshold | unstated |
| Lens Blur | Blur Amount | unstated (default 50) |
| Lens Blur | Focus method | Subject / Point / Area |
| Lens Blur | Aperture (bokeh shape) | Circle / Bubble / 5-blade / Ring / Anamorphic / Cat Eye |
| Lens Blur | Highlights (Bokeh Boost) | unstated |
| HDR | HDR toggle | on/off |
| HDR | Visualize HDR | on/off |
| HDR Panorama (merge) | Deghost Amount | None / Low / Medium / High |
| HDR Panorama (merge) | Layout projection | Spherical / Cylindrical / Perspective |
| HDR Panorama (merge) | Boundary Warp | unstated |
| HDR Panorama (merge) | Fill Edges / Auto Crop | on/off |
| Versions | Create Version | button + name |
| Copy/Paste | Select group | All / Modified / Default / None |
