# Merge to HDR, Panorama, and HDR Panorama (Photo Merge)

Source: https://helpx.adobe.com/lightroom/desktop/edit-photos/hdr-panorama.html (fetched 2026-09-16)

Combines multiple photos into a single merged photo. All three merge types produce a stack (source files + merged result on top) and support applying all Edit-panel settings afterward, same as any single photo.

## Merge to HDR

Combines exposure-bracketed photos into one HDR photo.

| Control | Range | Description |
|---|---|---|
| Auto Align | on/off | Aligns slightly misaligned handheld shots |
| Auto Settings | on/off | Provides an evenly-toned starting point, previewed live; can continue editing afterward |
| Deghost Amount | None / Low / Medium / High | Corrects semi-transparent "ghosting" from frame-to-frame movement. Low = little/minor movement, Medium = considerable movement, High = high movement |
| Show Deghost Overlay | on/off (key: O) | Highlights where deghost corrections are applied |

Shortcut: Photo > Photo Merge > HDR — Cmd (macOS) / Ctrl (Windows) + Shift + H. Output filename suffix: `HDR.dng`.

### Recommended exposure count by bracket

| Camera bracket setting | Optimum # of exposures to merge |
|---|---|
| -1.5 to +1.5 | 2 |
| -3.0 to +3.0 | 3 |
| -4.5 to +4.5 | 4 |
| -6.0 to +6.0 | 5 |

Capture tips: use Automatic Exposure Bracketing; use a tripod (or minimize movement).

## Merge to Panorama

Combines standard-exposure photos into a panorama.

| Control | Range | Description |
|---|---|---|
| Layout projection | Spherical / Cylindrical / Perspective | Spherical: maps to the inside of a sphere (360° experience); best for very wide/multirow panoramas. Cylindrical: maps to a cylinder, keeps verticals straight; good for wide panoramas. Perspective: maps to a flat surface, keeps straight lines straight; best for architecture, but wide panoramas may distort near edges |
| Boundary Warp | unstated | Warps the panorama to fill the canvas, preserving detail near the boundary that cropping would otherwise lose. Higher value = boundary fits more closely to the rectangular frame |
| Fill Edges | on/off | Automatically fills uneven edges of the merged image |
| Auto Crop | on/off | Removes undesired transparent areas around the merged photo |

Shortcut: Photo > Photo Merge > Panorama Merge — Cmd (macOS) / Ctrl (Windows) + Shift + M. Output filename suffix: `Pano.dng`.

Capture tips: do not use Automatic Panorama mode on the camera; use a tripod; keep exposure consistent across shots.

## Merge to HDR Panorama

Combines multiple exposure-bracketed photos (with consistent exposure offsets) directly into an HDR panorama in one step. Uses the same **Layout projection / Boundary Warp / Fill Edges / Auto Crop** controls as Merge to Panorama above.

Shortcut/menu: Photo > Photo Merge > HDR Panorama. Output filename suffix: `HDRPano.dng`.

### Requirements

- All images must contain exposure metadata (exposure time, f-number, ISO).
- Each bracketed set must have the same number of images.
- Each bracketed set must use the same exposure offsets (e.g. 0, -1, +1) — values can differ, but the offset *pattern* must match across sets.
- Bracketed sets must be captured contiguously.
- No two images within one bracket set may share the same exposure value.

If requirements aren't met, Lightroom offers to create a normal panorama instead.

## Interactions

- Boundary Warp / Fill Edges / Auto Crop overlap conceptually with `extend-generative-expand.md`, which fills empty edges via generative AI instead of warping/cropping.
