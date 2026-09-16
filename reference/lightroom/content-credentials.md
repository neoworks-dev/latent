# Content Credentials

Source: https://helpx.adobe.com/lightroom/desktop/edit-photos/content-credentials-lightroom.html (fetched 2026-09-16)

Not a photo edit operation — export-time metadata (based on the C2PA open standard, co-founded by Adobe) recording attribution and edit history. Included for completeness since it is listed in the Lightroom desktop "Edit photos" table of contents.

## Content Credentials settings (Preferences > Export)

| Control | Range | Description |
|---|---|---|
| Apply Content Credentials | on/off (at export, via Custom Settings) | Attaches/publishes Content Credentials with the exported file |
| Storage method | Publish to Content Credentials cloud / Attach to files / Attach and publish to cloud / Don't include | Where the credential record lives. Cloud publishing keeps files smaller and the record recoverable, but is less private — it may surface in searches for similar content |
| Producer | identity info | Includes the creator's verified name |
| Connected accounts | social profiles | Includes linked social media accounts |
| Edits and activity | on/off | Includes the editing history in the credential |

## Limitations

- Not preserved across an Edit-in-Photoshop round trip unless Content Credentials is explicitly re-enabled and the file is re-exported/re-imported at each step.
- Not supported for PSD or PSB export formats.
- Applies the same way when adding photos to a Shared Album (the same "Apply Content Credentials" option appears in that dialog).
