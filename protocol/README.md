# Wire protocol: engine ↔ UI

One WebSocket per UI session, `ws://127.0.0.1:<port>/`. The engine prints the port on
stdout as `listening on ws://127.0.0.1:<port>` and the Electron main process passes it to
the renderer.

- **Text frames** carry JSON-RPC 2.0. Requests from the UI, responses from the engine, and
  engine → UI notifications (no `id`). Method names and params are defined in
  `messages.schema.json`; every request has a `<method>Params` and `<method>Result` def.
- **Binary frames** carry pixels, never JSON. Layout in `frames.md`.

`messages.schema.json` is the single source of truth. `packages/protocol` generates TS types
from it (`bun run generate` there); the engine's tests validate its handlers against it.
Never hand-edit the generated file.

Versioning: `engine.hello` returns `protocolVersion`. Bump it on any breaking change to a
def; additive optional fields do not bump it.

`engine.hello` also answers `catalogPath` (the SQLite file this daemon opened — a UI shows
it, a test asserts it is the throwaway one) and `mcpUrl`, the streamable-HTTP endpoint of
the engine's MCP server. `mcpUrl` is **absent**, not empty, when the daemon ran with
`--no-mcp` or the SDK failed to load; the same is true of the mock engine, which has no
interpreter.

## Photo ids

`PhotoId` is a SQLite rowid, an i64, and every method takes the full range. The one
exception is thumbnails: `LTHM` carries the id in a u32 (`frames.md`), so an id above
**4294967295** cannot be tagged. `catalog.thumbnail` and `catalog.thumbnails` answer
`-32602` for such an id rather than send a frame with a truncated target — for the batch
call too, because an unrepresentable id is a malformed request and not a photo that failed
to render, so it does not belong in `missing`.

## Requests

Every row is `<Method>Params` → `<Method>Result` in the schema. Both tables are the
contract: a method missing from either the schema's `MethodName` enum or
`packages/protocol/src/methods.ts` fails the protocol test.

| Method | Params | Result | Notes |
| --- | --- | --- | --- |
| `engine.hello` | `client?` | version, GPU limits, `catalogPath`, `mcpUrl?` | First call on a new socket |
| `ops.describe` | — | `ops[]` | Generated panels come from this: `section`, `order`, per-param `display` |
| `photo.open` | `path` | id, size, camera, `sidecarLoaded`, `catalog?` | Opening catalogs the file; `catalog` is the row, so no follow-up `catalog.get` |
| `photo.close` | `photoId` | — | |
| `stack.get` | `photoId` | stack + `revision` + undo/redo flags + `histogram?` | Shape reused by every stack write |
| `stack.set` | `photoId`, `stack` | as `stack.get` | |
| `op.add` | `photoId`, `op`, `params?`, `index?`, `parentId?`, `transient?`, `mask?`, `opacity?` | as `stack.get`, plus `opId` | `transient` = first tick of a drag: no snapshot, no sidecar; the drag undoes as one step. `op: "group"` adds a layer; `parentId` puts the op under that layer's mask, where its own `mask` and `opacity` are ignored |
| `op.update` | `photoId`, `opId`, `params`, `enabled?`, `transient?`, `mask?`, `opacity?` | as `stack.get` | `transient` = mid-drag: no snapshot, no sidecar write. `mask` is a full replacement, `null` clears; a mask on a non-maskable op, or a `mask`/`opacity` on an op inside a group, is dropped with an `engine.log` warning. `opId` reaches a group's child as readily as a top-level entry |
| `op.remove` | `photoId`, `opId` | as `stack.get` | A group goes with the adjustments under it |
| `history.undo` / `history.redo` | `photoId` | as `stack.get` | Cursor over snapshots, never a pop |
| `history.list` | `photoId` | `entries[]`, `index` | One row per snapshot, described by its diff from the one before it: `kind`, `op?`, `opId?`, `changes[]` of `{param, from?, to?}`. Values are the parameters' own — the UI formats them with `ops.describe`'s spec — and a non-scalar (a curve) reports a change with neither side |
| `history.jump` | `photoId`, `index` | as `stack.get` | The cursor straight to one snapshot; out of range is -32602. A drag in flight is rolled back first |
| `view.open` | `photoId`, `width`, `height` | `viewId` | One canvas, one proxy size |
| `view.close` | `viewId` | — | |
| `view.render` | `viewId`, `width?`, `height?`, `geometry?`, `viewport?` | `seq`, size, `contentRect?`, `imageTransform?`, `viewport?`, `renderMs`, `readbackMs`, `revision`, `histogram?` | Sends one `LFRM` frame first. `geometry: "full"` renders the uncropped image for the crop tool; `viewport` is zoom and pan |
| `python.run` | `code`, `photoId?`, `timeoutMs?` | `ok`, `stdout`, `stderr`, `durationMs`, `value?`, `runId?` | `timeoutMs` default 30000 |
| `catalog.import` | `paths`, `recursive?` | `jobId`, `thumbnailJobId?` | `recursive` default **true**; progress via `job.progress` |
| `catalog.list` | filters below | `photos`, `total` | |
| `catalog.get` | `photoId` | one row | |
| `catalog.folders` | — | `folders[]` with counts | |
| `catalog.setRating` | `photoId`, `rating` | the row | Publishes `catalog.changed` |
| `catalog.setFlag` | `photoId`, `flag` | the row | Publishes `catalog.changed` |
| `catalog.collections` | — | `collections[]` | |
| `catalog.collectionSet` | `collectionId?`, `name?`, `add?`, `remove?`, `delete?` | `collections[]` | Create / rename / edit / delete in one call |
| `catalog.thumbnail` | `photoId`, `size?` | `photoId`, size | One `LTHM` frame first; failure is an RPC error |
| `catalog.thumbnails` | `photoIds`, `size?` | `requested`, `sent`, `missing[]` | One `LTHM` frame per photo, then the result |
| `catalog.remove` | `photoIds` | `removed` | Rows only — never the files |
| `job.cancel` | `jobId` | `cancelled` | Stops a running job at its next safe point |
| `merge.hdr` | `photoIds`, `deghost?`, `autoAlign?`, `outputPath?` | `jobId` | 2–7 exposures → one linear 16-bit TIFF, catalogued. Progress as `job.progress` kind `merge` |
| `merge.panorama` | `photoIds`, `projection?`, `boundaryWarp?`, `autoCrop?`, `outputPath?` | `jobId` | 2–12 overlapping frames in shooting order |
| `merge.hdrPanorama` | `photoIds`, plus both option sets | `jobId` | Bracket sets found from the exposure pattern, HDR each, then stitch |
| `merge.preview` | `kind`, `photoIds`, the same options, `longEdge?` | `jobId` | The same merge from the embedded JPEGs; the last tick names a PNG |
| `mask.preview` | `photoId`, `opId`, `componentId?`, `viewId?` | `width`, `height`, `contentRect?`, `imageTransform?`, `coverage` | One `LMSK` frame (r8) first, then the result. Combined mask, or one component's raster |
| `mask.detect` | `photoId`, `opId`, `componentId`, `hint?` | `jobId` | Starts the AI rasterisation of an AI-kind component; component goes `pending` → `ready`/`failed` via `stack.changed`, job ticks `job.progress` kind `mask` |
| `mask.stroke` | `photoId`, `opId`, `componentId`, `points`, `erase?`, `size?`, `flow?`, `transient?` | as `stack.get` | Appends a brush segment; the engine owns strokes and rasters. One pointer-down = transient segments + one committed call = one undo step |

### Mask coordinates

A **layer** is an `Op` named `group`: a mask, an `opacity`, and the adjustments that share
them in `ops` (PROMPT.md §3.7). It has no params and no definition in `ops.describe`. Its
children are develop ops — never geometry, never a generative op, never another group — and
carry `enabled` alone. The layer renders as one branch blended back through the mask once, so
`mask.preview { opId }` for a layer is the mask every adjustment under it shares. A generative
op keeps its own `mask`: that region is what a backend painted, not a layer.

Every mask component's coordinates — a gradient's two points, a radial's centre and radii, a
brush's stroke points and its diameter, an object's box and points — are normalised **0..1
over the image**: the uncropped, unrotated, untransformed photo at the size `photo.open`
reports, camera orientation already applied by the decode. They are *not* over the content
rect. A mask painted on the subject therefore stays on the subject when a crop, a straighten,
a rotate, a flip or the Transform sliders move afterwards, which is what Lightroom does. Use
`imageTransform` to put one on a canvas and its inverse to turn a pointer into one.

`Mask.space` names the convention. `image` is the above and the only thing the engine writes.
`content` is the pre-2026-09-16 convention, 0..1 over the content rect of whatever view drew
it; only a sidecar written before the change holds one, and the engine converts it through
that stack's own geometry the first time it opens the photo and writes `image` back. Points
convert exactly; a radial's radii and angle and a brush's diameter are scaled by the map's
local factor, which is exact for a crop and best effort for a straighten. An absent `space`
means `image` — a client that does not send the field is a client that never applied geometry
either, and the two spaces coincide for an uncropped photo.

`mask.preview` keeps answering a **view-space** raster: it is what the overlay blits onto the
frame, letterboxed and cropped exactly like the frame it lies over. Its `contentRect` and
`imageTransform` say where the photo is inside it.

`mask.detect` renders its input with the geometry stage bypassed and only the ops *below* the
masked op applied, so a detector's boxes and points come back in image coordinates and line
up with the mask that stores them.
| `generative.run` | `photoId`, `opId` | `jobId` | Runs one generative op through its backend; progress via `job.progress` kind `generative`, result via `stack.changed`. The only thing that ever starts a run |
| `generative.status` | — | `backend`, `ready`, `comfy`, `models?`, `workflows` | Whether a run can succeed: is `comfy` installed, is its server up, which graphs have their weights |
| `export.run` | `photoIds`, `format`, `colorSpace`, `outputDir`, `quality?`, `resize?`, `sharpen?`, `fileNameTemplate?` | `jobId`, `total` | Starts a batch export; progress via `job.progress` kind `export`, whose `message` is the file being written |

### `export.run`

Full resolution, the same passes as the preview, encoded in the engine (PROMPT.md §3.6).
The call returns as soon as the job is queued; `total` is `photoIds.length`, so a progress
bar can size itself before the first tick.

- **`format`** — `jpeg` (8-bit, ICC in APP2), `tiff16` and `png` (16 bits per channel),
  `avif` (10-bit AV1). `quality` (1–100, default 90) is read by `jpeg` and `avif` only.
  A build without libavif answers `-32602` for `avif`.
- **`colorSpace`** — `srgb`, `displayP3`, `adobeRGB`, `rec2020`, `proPhoto`. The last GPU
  pass applies the matrix and the encoding curve, and lcms2 generates the ICC that is
  embedded from the same primaries and curve, so the file never disagrees with itself.
- **`resize`** — absent means native: the crop rect at sensor resolution. `longEdge` wins
  over `width`/`height`; both of those together are a box the image is fitted inside.
  `dpi` is metadata only (JFIF density, PNG `pHYs`, TIFF resolution) and moves no pixels.
  Resampling is a box filter in linear light, before the output curve.
- **`sharpen`** — `{ target: screen | matte | glossy, amount?: low | standard | high }`,
  Lightroom's output sharpening. It is the last pass before the colour transform. Absent
  means none.
- **`fileNameTemplate`** — `{name}` (the source file's stem), `{index}` (1-based position
  in this run), `{ext}`. Default `{name}`. It names a **file**, not a path: separators are
  stripped, so a template can never write outside `outputDir`. Two photos whose names
  collide inside one run get `-2`, `-3` … appended; an existing file on disk is
  overwritten, because re-exporting the same edit to the same folder is the normal case.

A photo that is not open is decoded for the export, rendered from its `.latent` sidecar —
cached AI mask rasters included — and dropped again; an open photo is exported from its
live stack. One photo that fails does not take the batch down: the job keeps going, warns
through `engine.log`, and its last `job.progress` carries `state: "error"` with the first
failure in `error`. `job.cancel` stops it between photos and keeps the files already
written, exactly like `catalog.import`.

Each file is written through a `.part` temporary and renamed, so a cancelled or crashed
export never leaves a half-written image where a whole one is expected.

### Generative ops

`generative_fill` and `remove` are cached rasters, not formulas (PROMPT.md §3.5). Three
engine-owned fields ride along on `Op`:

- `result` — the PNG the last run produced, relative to the photo's raster dir, `$XDG_DATA_HOME/latent/rasters/<sha256>/`.
- `resultRect` — `[x0, y0, x1, y1]` of that PNG inside the content rect, 0..1. The crop's
  bounding box after it was snapped to a multiple of eight pixels.
- `inputHash` — sha256 over the ops that produced the crop, the op's mask and the op's
  params.

A client round-trips all three untouched, exactly as it does a mask component's `raster`.
`stale` is the fourth and is **derived**: the engine adds it to every `stack.get` and
`stack.changed` when `inputHash` no longer matches, and never writes it to the sidecar. A
stale op keeps rendering its last result; only `generative.run` replaces it.

`generative.status` blocks on a subprocess (`comfy` is a Python CLI), so the engine answers
it from its worker thread. Call it once on connect and when a generative panel opens, not
per frame.

### `ops.describe`

The UI's source of truth for panels. Beyond `name`, `panel`, `label` and `params`, each op
carries `section` — the Lightroom heading it is drawn under (`Light`, `Color`, `Effects`,
`Detail`, `Optics`, `Geometry`) — and `order`, its 1-based position inside that section,
following Lightroom's slider order. Group by `section`, sort by `order`; an op without one
sorts last, then by name.

Each param may carry `display`, a hint for the control: `kind` is `slider` (the default),
`kelvin`, `curve`, `hsl` or `toggle`, and `tint` names the gradient to paint under the
track (`temperature`, `tint`, `hue`, `saturation`). It is advisory — a UI that ignores it
still builds a correct control out of `type`, `min`, `max` and `step` — and a slider with
no gradient simply omits `tint`.

### `view.render`

`contentRect` is `[x, y, width, height]` of the image inside the frame, in proxy pixels.
The frame is the view's full size and the image is letterboxed inside it, so the two only
agree when the aspects do; crop, rotate and the Transform sliders change the content rect
without changing the frame, and a zoomed viewport makes it *larger* than the frame with a
negative origin. Read it as signed numbers. It is optional and additive: a client talking
to an engine that does not send it falls back to fitting the frame's own aspect into its
canvas, which is what the rect says whenever nothing is cropped.

`histogram` is counted over the image rect of the frame that just went out — 256 bins per
channel of the 8-bit display pixels, plus the share of them at either end. `stack.get`
answers with the same shape, but from whatever frame the view drew last: a stack write is
answered before the next render, so that copy is one render behind the edit it reports,
and a panel that wants the histogram of the pixels on screen reads this one.

`imageTransform` is the geometry stage as nine numbers: **image-normalised to view pixel**,
a row-major 3x3 applied to `(x, y, 1)` with a homogeneous divide.

```
px = (m0*x + m1*y + m2) / w
py = (m3*x + m4*y + m5) / w
w  =  m6*x + m7*y + m8
```

Projective and not affine, because the Transform sliders' keystone is. It carries crop,
straighten, rotate, flip, Transform and the viewport's zoom and pan together, so its inverse
turns a pointer into a mask coordinate and the matrix itself turns a mask coordinate into a
canvas pixel. **Lens distortion is not in it**: the radial term has no closed-form inverse,
so the matrix is exact wherever `lens_correction.distortion` is 0 (its default) and off by
that term otherwise; the shader applies the term separately, in the forward direction, where
it is exact. `mask.preview` answers with the same matrix for its own raster grid. Optional
and additive — without it a client falls back to `contentRect`, which says the same thing
whenever nothing is cropped.

`viewport` asks for zoom and pan and is **sticky per view**: send it when it changes, leave
it out and the view stays where it was. `scale` 1 is fit-to-view — the behaviour of every
render before the field existed — and 2 is twice that; a client computes 1:1 as
`imageWidth / (contentRect width at scale 1)`, or by reading the image's on-screen width off
`imageTransform`. `centerX`/`centerY` are the **image-normalised** point the view is centred
on; sending neither, or a scale of 1, means fit. The engine clamps the pan so a zoomed frame
is never part letterbox and echoes what it used in the result's `viewport`, so a client shows
what it got rather than what it asked for. Zoom changes which source texels the proxy's
sampling pass reads — the frame is always the view's size and is never read back at full
resolution. None of it is edit state: it never reaches the stack or the sidecar.

`geometry` picks how much of the geometry stage the frame applies. `stack` is the default
and the whole stack. `full` renders the **uncropped** image: the `crop` op's rect and its
`angle` are bypassed for that frame, so `contentRect` covers the whole image and the user
can see what is being cropped away. `rotate`, `flip` and `transform` move the whole image
and still apply. The stack is not touched — the flag is per render, and the next `stack`
render is the cropped picture again. This is what the crop tool asks for while it is open;
every other client leaves the field out.

The result's `revision` is the stack revision the frame was rendered from, the same counter
`stack.get` and `stack.changed` report. A client that coalesces slider drags compares it
with the revision of the last `stack.changed` it saw: equal means the canvas is showing the
newest state, lower means one more render is owed. `seq` counts frames, `revision` counts
states; they are not the same number.

### `catalog.list`

Filters, all optional, all AND-ed: `folder` (exact match), `photoIds` (exactly those rows,
in the list's order), `query` (case-insensitive substring over filename and camera),
`collectionId`, `flag`, `minRating`, plus `sort`, `descending`, `limit`, `offset`.

Rows with equal sort keys are ordered by **filename ascending, then photoId ascending**.
The tie-breaker is part of the contract: paging is only stable if two calls with the same
filters return the same order.

### `catalog.thumbnails`

The batch form of `catalog.thumbnail`. A filmstrip asks once per page instead of once per
cell. The engine sends one `LTHM` frame per photo it can render, then the result. A photo
that produced nothing — unknown id, unreadable file, decode failure — is listed in
`missing` and has no frame; the call itself still succeeds. `catalog.thumbnail` keeps the
old behaviour (RPC error on failure) and is not deprecated. `frames.md` has the rule.

### `catalog.remove`

Deletes catalog rows, their thumbnails and their collection memberships. **Files on disk
and their `.latent` sidecars are never touched** — re-importing the path brings the photo
back with a new `photoId`. Unknown ids are ignored, so `removed` can be less than
`photoIds.length`. Publishes `catalog.changed { reason: "remove", photoIds }`.

### Jobs

`catalog.import` (later: export, thumbnail rebuilds) returns a `jobId` immediately and
reports through `job.progress`. `job.cancel { jobId }` asks a running job to stop at its
next safe point and answers `{ cancelled }` — `false` when the job is unknown or already
finished. Work already done stands: a cancelled import keeps the photos it registered, and
its last `job.progress` carries `finished: true` with `state: "cancelled"`.

`state` is optional and additive: `running` until the job ends, then `done`, `cancelled` or
`error`. A client written before `state` existed reads `finished` and is still correct.

An import queues thumbnails behind itself, and `catalog.import`'s result names that second
job as `thumbnailJobId` — reserved up front, so one result gives a client both bars and it
can cancel the thumbnails before the import that feeds them is done. The thumbnail job's
`job.progress` carries `parentJobId` = the import's `jobId`; a job nobody spawned has no
`parentJobId`. It always reports, even when the import found nothing or was cancelled —
then over zero photos. Nest the child bar under its parent rather than showing two
unrelated ones.

`result` is optional and additive, and present **only on a job's last notification**: it is
what the job produced, for the jobs whose output is not the catalog itself. A merge answers
`{ photoId, path, width, height, durationMs }`; a merge preview answers
`{ previewPath, previewUrl, width, height, durationMs }` and no `photoId`. An import and a
thumbnail rebuild have no `result` — their output is the rows a `catalog.changed` already
announced.

### Photo Merge

`merge.hdr`, `merge.panorama` and `merge.hdrPanorama` take catalog ids, not open photos,
and answer `{ jobId }` at once — a full-resolution merge is tens of seconds. The work runs
on the engine's worker thread: decode every source, align, merge, write.

The output is a **new source image**, not an edit: a 16-bit TIFF of linear, already
demosaiced, already white-balanced RGB, plus a sidecar `<file>.latent-source.json` carrying
the flag, the camera, the as-shot multipliers and the radiance `scale`. `photo.open` opens
it like a raw — there is no linearise or camera-matrix stage to skip, because the pixels are
already in the working space — and the whole op-stack applies on top. The engine registers
it in the catalog and names the row in the job's last `job.progress` `result.photoId`,
alongside a `catalog.changed { reason: "import" }`.

Naming follows Lightroom: `<first source>-HDR.tif`, `-Pano.tif`, `-HDRPano.tif`, next to
the sources, stepping a counter rather than overwriting. `outputPath` overrides it.

16 bits have to hold the whole merged range, so an HDR merge divides by its own peak and
records the divisor as `scale` in the sidecar: stored value × `scale` = radiance relative to
the brightest bracket's white level. A 6 EV bracket therefore leaves 10 bits below a single
frame's white. Float and DNG output are Phase 3 (PROMPT.md §7).

`merge.preview` runs the same merge over the raws' **embedded JPEG previews** instead of a
full decode — about a second instead of a minute — and writes a PNG. Its last
`job.progress` carries `result.previewUrl`, an absolute
`http://127.0.0.1:<engine port>/preview/<name>.png` served by the daemon's own listener.
That is the one HTTP route the engine has, it only ever serves files inside its preview
directory, and it exists because a renderer loaded over `http://` cannot read `file://`.
A renderer's CSP needs `img-src http://127.0.0.1:*` for it (`apps/editor/index.html`).
The preview is approximate by construction: an embedded JPEG is display-referred and
carries the camera's own tone curve, which undoing the sRGB transfer does not undo.
Nothing is written to the catalog.

### `python.run`

`timeoutMs` (default 30000) is a wall-clock budget. On expiry the engine interrupts the
script with `KeyboardInterrupt` and answers with an error result (`ok: false`, traceback in
`stderr`) — it never drops the call.

When the engine streams a run's output it tags the run with `runId` and sends
`python.output { runId, stream, text }` notifications **to the calling socket, before that
call's result**. The result still carries the complete `stdout`/`stderr`, so a console that
showed the live output replaces it with the result's when the call returns; one or the
other is rendered, never both.

`python.finished { runId, durationMs, ok }` closes that stream: it goes to the same socket
**after the run's last `python.output` and before the RPC result**, so a console can stop
its spinner and print the timing without waiting on the reply. The result repeats
`durationMs` — optional there only so a client built against an older engine still
typechecks; `latentd` and the mock always send it. `ok` mirrors the result's: an
interrupted run announces `ok: false` and puts the traceback in the result's `stderr`.

## Notifications

Engine → UI, no `id`. Calling one as a method is a `-32601` error.

| Notification | Params | When |
| --- | --- | --- |
| `stack.changed` | `stack.get` result + `photoId` + `source` + `client?` | Any writer moved a stack: UI, script, MCP, undo/redo, sidecar load |
| `engine.log` | `level`, `message`, `photoId?` | Engine-side diagnostics worth showing |
| `catalog.changed` | `photoIds`, `reason` | `import` / `rating` / `flag` / `collection` / `edit` / `remove` |
| `job.progress` | `jobId`, `kind`, `done`, `total`, `finished`, `parentJobId?`, `state?`, `message?`, `error?` | Long-running work |
| `python.output` | `runId`, `stream`, `text` | Output a still-running script produced |
| `python.finished` | `runId`, `durationMs`, `ok` | That run ended — after its last output, before its result |

### `stack.changed`

`source` is the closed enum the UI branches on. `client` is the same information one step
finer and free-form, so it can name the tool that wrote: `ui`, `external`, `python`,
`mcp:<tool>` (today only `mcp:run_python`), `history`, `load`. Both are per socket — the
writer sees `ui`, everyone else `external` — and a script or an agent is nobody's own
action, so its label reaches every socket unchanged. Print `client` in a console or a
history list; never branch on it, because the `mcp:` suffix is open-ended.
