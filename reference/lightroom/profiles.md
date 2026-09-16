# Profiles

Source: https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html#profile (fetched 2026-09-16)

Profiles control how color and tonality are rendered. They are a starting point/foundation for edits — applying a profile does **not** change or overwrite the values of other edit-control sliders, so profiles can be applied before or after other edits. On import, Adobe Color is applied by default to color photos and Adobe Monochrome to black-and-white photos.

## Profile panel

| Control | Range | Description |
|---|---|---|
| Profile selection | categorical (browse list) | Sets the base color/tonality rendering used as a starting point; does not alter other slider values |
| Amount (profile intensity) | unstated | Controls the strength of the effect; only shown for Adaptive, Artistic, B&W, Modern, and Vintage profiles |
| Favorite (star icon) | on/off | Marks a profile for quick access in the Favorites group |
| View mode | List / Grid / Large thumbnails | Display style for browsing profiles |
| Filter by type | Color / B&W | Filters the profiles shown in the browser |

## Profile groups

| Group | Applies to | Description |
|---|---|---|
| Adobe Raw | raw photos | Improves color rendering; Adobe Color is the default profile applied on import |
| Camera Matching | raw photos | Matches in-camera picture styles (e.g. Camera Standard, Camera Landscape) at capture time |
| Adaptive | raw photos | AI-adjusted tone/color/contrast tailored to the specific photo; has Amount slider; often better than Auto for HDR photos |
| Legacy | raw photos | Profiles carried over from earlier Lightroom versions |
| Artistic | any file type (raw, JPEG, TIFF) | Edgier color rendering with stronger color shifts; has Amount slider |
| B&W | any file type | Tone shifts optimized for black-and-white work; has Amount slider |
| Modern | any file type | Effects styled for modern photography; has Amount slider |
| Vintage | any file type | Replicates the look of vintage photos; has Amount slider |

## Import and management

| Action | Description |
|---|---|
| Import Profiles | Profile panel → Browse → three-dot menu → Import Profiles; imports third-party camera profiles in XMP format |
| Manage Profiles | Profile panel → Browse → three-dot menu → Manage Profiles; shows/hides profile groups in the browser. This setting is per-device (not synced between desktop and mobile) |

## Interactions

- Presets and Profiles (including third-party/custom) sync automatically across Lightroom desktop and mobile, but custom user presets/profiles do **not** sync with Lightroom Classic.
- See `presets.md` for the separate Presets panel, which reuses the same Amount-slider and Manage-groups mechanics.
