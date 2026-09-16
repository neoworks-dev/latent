# Color Grading

Source: https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html#color (fetched 2026-09-16, "Add color tint to your photos with Color Grading" subsection)

Adds a color tint to a photo's shadows, midtones, and highlights — e.g. stylizing an image by adding a color from the opposite side of the color wheel to make shadows and highlights appear more prominent.

## Color Grading panel

| Control | Range | Description |
|---|---|---|
| Range select | Shadows / Midtones / Highlights / Global | Selects which tonal range the color wheel and sliders affect (chosen via icons in the panel's menu bar) |
| Color wheel (per range) | drag position | Selects the tint color for the currently selected range |
| Hue (Global) | unstated | Tint hue, adjustable directly when Global is selected |
| Saturation (Global) | unstated | Tint intensity, adjustable directly when Global is selected |
| Luminance (Global) | unstated | Tint brightness, adjustable directly when Global is selected |
| Midtones / Shadows / Highlights sliders | unstated | Manual adjustment of the color grading applied to each range (alternative to dragging the wheel) |
| Blending | unstated | Controls the transition smoothness between Midtones, Shadows, and Highlights |
| Balance | unstated | Shifts the balance of contribution between shadow and highlight tinting |

## Interactions

- Global mode tints the entire image at once instead of splitting shadows/midtones/highlights independently.
- Complements the per-channel Point Curve (`curves.md`), which can achieve a similar split-tone effect via Red/Green/Blue channel curves.
