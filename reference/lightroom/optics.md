# Optics

Source: https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html#optics (fetched 2026-09-16)

Camera lenses can exhibit defects (chromatic aberration, geometric distortion, vignetting) at certain focal lengths, f-stops, and focus distances. The Optics panel corrects/minimizes these.

## Chromatic aberration

| Control | Range | Description |
|---|---|---|
| Remove Chromatic Aberration | on/off | Automatically corrects blue-yellow and red-green lateral fringes caused by the lens failing to focus all colors to the same point, sensor microlens aberrations, or flare |

## Lens corrections

| Control | Range | Description |
|---|---|---|
| Enable Lens Corrections | on/off | Applies a lens profile (based on camera/lens metadata: model, focal length, f-stop, focus distance) to correct geometric distortion and vignetting |
| Lens profile selection | categorical (Make / Model / Profile) | Manually select or change the matched lens profile if auto-detection fails or needs overriding |
| Distortion Correction | unstated (default 100) | 100 = full profile correction; >100 = stronger correction than profile default; <100 = weaker |
| Lens Vignetting | unstated (default 100) | 100 = full profile vignetting correction; >100 = stronger; <100 = weaker |

Note: Lens correction for all Micro 4/3 (MFT) lenses/cameras (Panasonic, Olympus, etc.), Fuji X, Leica Q, and many point-and-shoot Canon models happens automatically without a profile-selection step ("Built-in Lens Profile Applied").

## Defringe

Removes color fringing along high-contrast edges, including longitudinal chromatic aberration and residual artifacts that Remove Chromatic Aberration cannot fix.

| Control | Range | Description |
|---|---|---|
| Fringe hue select | Purple / Green | Chooses which fringe hue the Fringe Selector targets |
| Fringe Selector (eyedropper) | n/a | Hover/click a fringed edge in the photo to suppress or remove that hue |
| Amount | unstated | How much of the selected hue to suppress/remove |
| Hue | unstated | Width of the hue range targeted |

## Interactions

- Lens Corrections availability (which profiles can be selected) depends on whether the file is raw or non-raw.
