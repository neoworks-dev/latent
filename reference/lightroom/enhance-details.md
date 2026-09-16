# Enhance Details (Denoise / Raw Details / Super Resolution)

Source: https://helpx.adobe.com/lightroom/desktop/edit-photos/enhance-details.html (fetched 2026-09-16)

Achieves crisper details and better color rendering in raw images, and can increase image resolution up to 4x in raw and non-raw images (JPEG/TIFF). Each of the three modes below produces a new, separate DNG file stacked with the original — this is distinct from the in-panel Detail sliders (`detail.md`).

## Enhance dialog (Photo > Enhance, or right-click > Enhance)

| Control | Range | Description |
|---|---|---|
| Denoise | on/off (apply), Amount slider (unstated) | AI noise reduction ideal for low light / high ISO; output saved as `<name>-Enhance-NR.dng`. Supports Bayer/X-Trans mosaic raw, Linear DNGs (incl. HDR/Pano DNGs made in Lightroom/Camera Raw), and Apple ProRAW |
| Raw Details | on/off (apply) | Produces crisper detail and more accurate edge rendition, improved color rendering, reduced artifacts; output resolution unchanged from the original. Supports Bayer and X-Trans mosaic raw only |
| Super Resolution | on/off (apply) | Like Raw Details but at 2x linear resolution (4x total pixel count); useful for enlarging cropped images. Supports raw plus JPEG and TIFF. Can only be applied once per image (not re-appliable to an already-enhanced image) |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+Alt+E (Windows) / Control+Option+E (macOS) | Open the Enhance dialog with live preview |
| Ctrl+Alt+E (Windows) / Command+Option+E (macOS) | Batch-apply Denoise to all selected photos |

## File-format support

| Format | Denoise | Raw Details | Super Resolution |
|---|---|---|---|
| Bayer / X-Trans mosaic raw | yes | yes | yes |
| Linear DNG (incl. HDR/Pano made in Lightroom) | yes | no | no |
| Apple ProRAW | yes | no | no |
| JPEG / TIFF | no | no | yes |
| Foveon sensor, 4-color cameras, Pentax PSR, Sony ARQ, video | no | no | no |

## System requirements

macOS Mojave (10.14)+ or Windows 10 1903+; heavily uses available GPU. Apple Neural Engine is disabled for AI Denoise on Apple-silicon Macs (macOS Sonoma 14.0+).

## Interactions

- Enhance multiple images: select several photos, choose Photo > Enhance; the last-used mode (Raw Details or Super Resolution) is applied to all.
- Output files are always new DNGs stacked with the source — they do not modify the in-panel Detail sliders on the original.
