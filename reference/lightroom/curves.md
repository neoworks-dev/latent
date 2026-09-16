# Curves

Source: https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html#light (fetched 2026-09-16, "Fine-tune the tonal scale using the Curve" subsection)

The Curve, inside the Light panel, gives more control over tonal range and contrast than the basic tone sliders. Horizontal axis = input tonal values (black left → light right). Vertical axis = output tonal values (black bottom → white top). A point moved up = lighter tone; moved down = darker tone. A straight 45° line = no change (input exactly equals output).

## Parametric Curve

| Control | Range | Description |
|---|---|---|
| Curve region drag | unstated (up = lighter, down = darker) | Drag up/down on the curve to adjust the affected tonal region; the affected region and new tonal value are shown in the lower-right corner while dragging |

## Point Curve

| Control | Range | Description |
|---|---|---|
| Channel select | RGB Channels / Red Channel / Green Channel / Blue Channel | Selects which channel the Point Curve edits |
| Add control point | click on curve | Adds an editable point to the curve |
| Delete control point | right-click (Windows) / Control-click (macOS) → Delete Control Point | Removes a point |
| Drag control point | unstated | Reshapes the curve |
| Curve preset | Linear / Medium Contrast / Strong Contrast | Dropdown at lower-right corner; applies a preset curve shape |
| Reset Channel | right-click (Windows) / Control-click (macOS) anywhere in graph | Restores a linear (45°) curve for the current channel |
| Refine Saturation | unstated | Adjusts saturation in the RGB Channel in conjunction with Point Curve adjustments |

## Interactions

- The Point Curve's per-channel (R/G/B) adjustments can be used for color grading/split-toning style effects (shifting hues in shadows vs. highlights via individual channel curves).
- The same "Curves" control (as a single combined entry) is also exposed inside Masking local adjustments — see `masking.md`.
