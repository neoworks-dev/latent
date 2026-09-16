# Masking

Source: https://helpx.adobe.com/lightroom/desktop/edit-photos/masking.html (fetched 2026-09-16)

The Masking panel provides local-adjustment tools — both AI-powered and manual — for editing specific areas of a photo. All local-adjustment sliders in `light.md`'s Auto section and elsewhere apply to whatever mask is currently selected.

## AI-based mask tools

| Tool | Description |
|---|---|
| Select Subject | Runs an analysis and automatically selects the photo's main subject (shown as a red overlay by default) |
| Select Sky | Runs an analysis and automatically selects the sky |
| Select Background | Runs an analysis and automatically detects the background (non-subject area) |
| Select Landscape | Detects up to 8 landscape elements: Sky, Mountains, Architecture, Vegetation, Water, Snow, Natural Ground, Artificial Ground. Pick the element to mask from the Create New Mask menu |
| Select Objects | Automatically detects an object; can also select another object using the Brush or Rectangle Select tool |
| Select People | Detects people in the photo (Person 1, Person 2, ...); supports selecting specific parts — skin, beard, clothes, hair, teeth, etc. |

All AI masks support **Add** and **Subtract** to refine the selection.

## Manual mask tools

| Tool | Control | Range | Description |
|---|---|---|---|
| Brush | Size | unstated (brush diameter, px) | Diameter of the brush tip |
| Brush | Feather | unstated | Soft-edged transition width (distance between inner/outer circle of brush cursor) |
| Brush | Flow | unstated | Rate at which the adjustment is applied |
| Brush | Density | unstated | Amount of transparency in the stroke |
| Brush | Auto Mask | on/off | Confines brush strokes to areas of similar color |
| Linear Gradient | drag into area | n/a | Adjusts a large portion of the photo with a gradually fading transition |
| Radial Gradient | Feather | unstated | Softness of the oval-shaped local-adjustment boundary |

## Range mask tools

| Tool | Control | Range | Description |
|---|---|---|---|
| Color Range | Select + drag | n/a | Samples colors in the photo to build the mask |
| Color Range | Shift + click | up to 5 samples | Adds additional color samples |
| Color Range | Alt/Option + click | n/a | Removes a color sample |
| Color Range | Refine | unstated | Narrows or broadens the range of selected colors |
| Luminance Range | Select Luminance | unstated | Defines the endpoints of the selected brightness range |
| Luminance Range | Show Luminance Map | on/off | Shows a black-and-white brightness map; red = masked area (intersection of luminance range + local adjustment) |
| Depth Range | Select Depth | unstated | Defines endpoints of the selected camera-distance range (requires photo with depth data) |
| Depth Range | Show Depth Map | on/off | Shows a black-and-white depth map (white = foreground, black = background); red = masked area |

## Mask management

| Action | Description |
|---|---|
| Add | Adds another masking tool to the current (parent) mask to further refine the selection |
| Subtract | Removes areas from the current mask using a masking tool; shown as a child mask |
| Rename | Renames a mask (three-dot menu or right-click) |
| Invert (selection) | Selects everything except the initial selection |
| Invert Mask | Inverts all masks in a group; "Duplicate and Invert" creates an inverse copy |
| Intersect with Mask | Intersects the current mask with another chosen mask |
| Overlay color | Change the default red overlay: color picker + Opacity slider (unstated range), "Unaffected Areas" toggle, and Mode presets (Color Overlay on B&W, Image on B&W, Image on Black, Image on White, etc.) |
| Presets (Lighten, Darken, Warmer, Cooler, ...) | Quick-start local-adjustment presets applied to a mask, from the Presets dropdown |
| Batch paste (Subject/Sky masks) | Copy Edit Settings → select Masking (and other groups) → Copy; then Paste to Entire Selection on other photos |

## Local-adjustment sliders (applied within any selected mask)

| Control | Range | Description |
|---|---|---|
| Feather | unstated | Softens the edges of the selected mask |
| Edge | unstated | Expands or contracts the mask's edges |
| Exposure | unstated | Overall brightness of the masked area (dodge/burn-like) |
| Contrast | unstated | Contrast, mainly affecting midtones, within the masked area |
| Highlights | unstated | Recovers highlight detail within the masked area |
| Shadows | unstated | Recovers shadow detail within the masked area |
| Whites | unstated | White point within the masked area |
| Blacks | unstated | Black point within the masked area |
| Curves | n/a | Local tone curve for the masked area |
| Temp | unstated | Local color temperature (warmer/cooler); useful for mixed-lighting scenes |
| Tint | unstated | Compensates a green or magenta cast within the masked area |
| Hue | unstated | Local hue shift; enable "Use Fine Adjustment" for precise changes (e.g. skin tone) |
| Saturation | unstated | Local color vividness |
| Colorize | on/off + color swatch | Applies a tint to the masked area; effect is preserved if the photo is converted to black-and-white |
| Texture | unstated (left = smoothen, right = accentuate) | Local texture without changing color/tonality |
| Clarity | unstated | Local edge contrast (adds local depth) |
| Dehaze | unstated | Reduces or increases haze locally |
| Grain: Size / Roughness | unstated | Adds film grain to the masked area (available since the June 2023 / v6.4 release) |
| Sharpness | unstated (negative values blur) | Local edge sharpening; negative = blur |
| Noise Reduction | unstated | Reduces luminance noise locally (relevant when opening up shadow areas) |
| Moiré | unstated | Removes moiré artifacts / color aliasing locally |
| Defringe | unstated | Removes fringe colors along edges locally |
| Refine Saturation | unstated | Manual saturation control tied to local Point Curve adjustments |

## Interactions

- Point Color (`point-color.md`) can be combined with Masking for localized single-color edits.
- Presets group "Adaptive" (Subject, Sky) in `presets.md` can be applied together with the Select Subject / Select Sky AI masks.
