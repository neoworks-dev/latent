# Remove / Heal / Clone (Distraction Removal)

Sources (fetched 2026-09-16):
- https://helpx.adobe.com/lightroom/desktop/edit-photos/remove-tool.html (Generative Remove, Detect objects)
- https://helpx.adobe.com/lightroom/desktop/using/heal-tool.html (Heal)
- https://helpx.adobe.com/lightroom/desktop/edit-photos/clone-tool.html (Clone)
- https://helpx.adobe.com/lightroom/desktop/edit-photos/remove-reflections.html (Reflection Removal)
- https://helpx.adobe.com/lightroom/desktop/edit-photos/remove-dust.html (Dust Removal)
- https://helpx.adobe.com/lightroom/desktop/edit-photos/remove-people.html — direct fetch failed after 4 attempts; content below reconstructed via WebSearch, see README

All tools live under the Remove tool icon. Remove, Clone, and Heal work offline; Generative Remove requires an internet connection (no generative credits are deducted for it).

## Generative Remove ("Use generative AI")

| Control | Range | Description |
|---|---|---|
| Use generative AI (brush) | on/off (default on) | Brush over the object to remove; Adobe Firefly detects and removes it, generating a fill that blends with the frame |
| Detect objects | on/off | Loosely circle or scribble over an object; Lightroom auto-detects the object plus its shadow/reflection and masks it. Combinable with "Use generative AI" |
| Add | mode | Adds more objects to the current selection |
| Subtract | mode | Removes objects from the current selection |
| Overlay color | categorical | Sets the color of the Remove overlay |
| Size | unstated | Brush size used to make the selection |
| Show Overlay on Hover | on/off | Shows the mask overlay when hovering the image |
| Visualize Spots | on/off + Threshold (unstated) | Highlights detectable spots to aid precise selection |
| Refresh | button | Regenerates the fill with new content (Detect Objects used alone) |
| Generate / Generate More | button | Produces variations (3 if Detect Objects + Use generative AI are combined) |
| Change source area | Cmd+drag (macOS) / Ctrl+drag (Windows) | Manually changes the sampled source area when using Detect Objects alone |

## Clone tool

| Control | Range | Description |
|---|---|---|
| Size | unstated (brush diameter, px) | Diameter of the brush tip |
| Feather | unstated | Soft-edged transition between brushed area and surrounding pixels |
| Opacity | unstated | Opacity of the cloned adjustment |
| Refresh | button | Updates the spot with different source pixels |

Clone replicates pixels from a source area to a target area — useful for consistent patterns, or removing dust spots/blemishes/objects.

## Heal tool

| Control | Range | Description |
|---|---|---|
| Size | unstated | Brush diameter |
| Feather | unstated | Soft-edged transition between brushed area and surrounding pixels |
| Opacity | unstated | Opacity of the healed adjustment |
| Refresh | button | Re-samples the spot with different content |
| Reset Healing | right-click → Reset Healing | Removes all healing adjustments |
| Show Overlay on Hover | on/off | Shows changed pixels/texture on hover |
| Visualize Spots + Threshold | on/off, unstated | Highlights spots for precise editing |

Heal borrows texture from a source area and matches it to the target area's surrounding color/tone (vs. Clone, which copies pixels directly).

## Remove unwanted people

Description (via WebSearch, direct fetch failed): identifies the main subject, detects unwanted people in the background, and removes them using the same generative-fill pipeline as Generative Remove. On Lightroom on the web, a "Remove All" button removes all flagged background people at once, followed by "Generate" to produce a new background.

## Reflection Removal (Distraction Removal panel)

| Control | Range | Description |
|---|---|---|
| Apply | button | Auto-detects and removes a window reflection |
| Amount | -100 to 100 | 100 = fully removed-reflection view; 0 = original image; -100 = view only the reflection |
| Quality | Preview / Standard / Best | Preview = lowest res/fastest; Standard = normal screen resolution; Best = full resolution/slowest |

Tip: adjust reflections first, then edit the image with other tools.

## Dust Removal (Distraction Removal panel)

| Control | Range | Description |
|---|---|---|
| Apply | button | Auto-detects and removes sensor/lens dust spots |
| Size | unstated | Size of the area removed per spot |
| Visualize spots | on/off | Shows extra dust spots as a mask |
| Threshold | unstated (drag right = more detail) | Sensitivity of the dust-spot mask visualization |
| Refresh / Delete (per spot) | button | Re-processes or removes an individual spot |

## Interactions / batch editing

- All tools in this family support Copy Edit Settings / Paste Edit Settings and multi-photo batch application (see `copy-paste-edits.md`).
- Dust Removal re-runs detection on each photo when settings are pasted, to account for differing spot size/location.
