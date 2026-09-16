# Copy and Paste Edit Settings / Reset

Source: https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html#copy-paste (fetched 2026-09-16)

Not an edit operation itself — a workflow/meta-operation for duplicating or discarding the op-stack across photos. Documented here because it governs how every other file in this directory's controls get batch-applied.

## Copy / Paste

| Control | Range | Description |
|---|---|---|
| Copy Edit Settings | Ctrl+C (Win) / Cmd+C (Mac), or Photo menu | Copies all edit settings from the current/selected photo |
| Choose Edit Settings to Copy | Ctrl+Shift+C (Win) / Shift+Cmd+C (Mac), or Photo menu | Opens the Copy Settings dialog to choose which setting groups to copy |
| Select (in Copy Settings dialog) | All / Modified / Default / None | All = every settings group; Modified = only settings changed on the photo; Default = a default group set (Tools and Geometry groups excluded by default); None = clears the selection |
| Paste Edit Settings | Ctrl+V (Win) / Cmd+V (Mac), or Photo menu | Applies the copied settings to the selected photo(s) |

## Reset

| Control | Range | Description |
|---|---|---|
| Reset To Original | Shift+R | Restores the photo to its as-imported state |
| Reset To Open | Shift+Cmd+R (Mac) | Restores the photo to the state it was in when last opened in Lightroom |

## Interactions

- The Copy Settings dialog's group list maps directly onto this directory's panel files (Light, Color, Effects, Detail, Optics, Geometry, Masking, etc.) — each is an independently copyable/pasteable group.
