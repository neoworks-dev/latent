# Generative Expand

Source: https://helpx.adobe.com/lightroom/desktop/edit-photos/extend-photos-with-generative-expand.html (fetched 2026-09-16)

Extends a photo's frame beyond its original dimensions, filling the new transparent area with generated content that blends with the rest of the photo. Useful for fixing poorly-framed shots, repurposing a photo for a different aspect ratio (banners, social crops), or filling gaps left by geometric/perspective edits. Lives inside the Crop, Rotate, Geometry panel.

## Generative Expand panel

| Control | Range | Description |
|---|---|---|
| Enable Expand | on/off | Turns on Generative Expand within the Crop/Rotate/Geometry panel |
| Crop edge drag | n/a | Drag a crop edge outward to define the area to expand into (expand one edge at a time for best quality) |
| Aspect (expand) | categorical | Select target aspect ratio, or use Rotate Aspect Ratio, then drag crop edges to fit |
| Method | Firefly Fill & Expand / Content-Aware Fill | Firefly Fill & Expand analyzes lighting/perspective to generate a realistic background (uses generative credits); Content-Aware Fill fills from similar surrounding content (no credits required) |
| Generate | button | Produces 3 variations (Firefly Fill & Expand) or 1 variation (Content-Aware Fill) |
| Generate More | button | Produces another set of variations |
| Preview toggle (eye icon, press-and-hold) | n/a | Shows the photo without the expanded portion |
| Remove all generations | button (via panel menu) | Clears generated variations |
| Keep | button | Commits the selected variation as part of the photo |
| Cancel | button | Discards the expansion |

## Interactions

- Usable on panoramic photos or after Geometry perspective correction (`geometry.md`), both of which can leave empty edges to fill.
