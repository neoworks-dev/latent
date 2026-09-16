# Calibration

Source: WebSearch synthesis of helpx.adobe.com Lightroom Classic Develop-module pages (fetched 2026-09-16). No dedicated Calibration page exists under Lightroom desktop (cloud) `edit-photos/` docs, and it is not part of the Lightroom desktop "Edit photos" table of contents.

**Lightroom desktop (the cloud-based app documented in every other file in this directory) has no Calibration / Camera Calibration panel.** Camera calibration is a **Lightroom Classic–only** feature. This file is included for completeness/reference only — treat all rows below as unverified against the desktop app and out of scope for a Lightroom-desktop-compatible op-stack.

## Camera Calibration panel (Lightroom Classic only — unverified for desktop)

| Control | Range | Description |
|---|---|---|
| Process Version | categorical | Selects the Camera Raw processing engine version used to render the photo; different process versions expose different options elsewhere in Develop |
| Red Primary: Hue / Saturation | unstated | Adjusts calibration of the camera's red channel |
| Green Primary: Hue / Saturation | unstated | Adjusts calibration of the camera's green channel |
| Blue Primary: Hue / Saturation | unstated | Adjusts calibration of the camera's blue channel |
| Shadows: Tint | unstated | Adjusts a green/magenta cast specifically in shadow tones during calibration |

## Note on monitor calibration (unrelated feature)

Adobe's help content also uses "calibration" to mean *monitor* color calibration (a system/OS or third-party colorimeter task, not a photo edit operation), and is out of scope for the op-stack.
