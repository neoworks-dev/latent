# Lens Blur

Sources (fetched 2026-09-16):
- https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html#lens-blur (brief mention only)
- Direct fetch of the dedicated Lens Blur page failed after multiple attempts (helpx.adobe.com/lightroom-cc/using/lens-blur.html returned no content via proxy; helpx.adobe.com/lightroom/desktop/using/lens-blur.html returned 404). Content below reconstructed via WebSearch synthesis, which mixes Lightroom desktop and Lightroom Classic terminology — verify exact in-app labels before relying on names. See README for details.

AI-powered tool that adds a simulated optical blur (bokeh) to any part of a photo by building a depth map of the image (Adobe Sensei / AI), letting you blur background or foreground.

## Lens Blur controls (reconstructed, verify against app)

| Control | Range | Description |
|---|---|---|
| Blur Amount | unstated (default 50) | Strength of the simulated blur |
| Focus method | Subject Focus / Point or Area Focus | Subject Focus auto-detects the focal subject via AI; Point/Area Focus is set manually by clicking or dragging on the photo |
| Visualize Depth (depth map overlay) | on/off | Yellow/warm = near focal range, Blue/cool = far focal range, White = currently in-focus area |
| Aperture (bokeh shape) | Circle / Bubble / 5-blade / Ring ("Doughnut") / Anamorphic / Cat Eye | Shape rendered for out-of-focus highlights |
| Highlights (Bokeh Boost) | unstated | Brightness of out-of-focus light sources |
| Refinement: Focus brush | Amount, Brush Size, Feather, Flow (all unstated) | Manually brushes focus back into blurred areas |
| Refinement: Auto Mask | on/off | Confines the refinement brush to areas of similar color/edges |

## Interactions

- Distinct from the manual Radial/Linear Gradient or Brush depth-of-field-style effects in `masking.md`; Lens Blur is a dedicated AI depth-map-based tool.
