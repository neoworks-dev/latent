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
| `op.add` | `photoId`, `op`, `params?`, `index?`, `transient?` | as `stack.get` | `transient` = first tick of a drag: no snapshot, no sidecar; the drag undoes as one step |
| `op.update` | `photoId`, `opId`, `params`, `enabled?`, `transient?` | as `stack.get` | `transient` = mid-drag: no snapshot, no sidecar write |
| `op.remove` | `photoId`, `opId` | as `stack.get` | |
| `history.undo` / `history.redo` | `photoId` | as `stack.get` | Cursor over snapshots, never a pop |
| `view.open` | `photoId`, `width`, `height` | `viewId` | One canvas, one proxy size |
| `view.close` | `viewId` | — | |
| `view.render` | `viewId`, `width?`, `height?` | `seq`, size, `renderMs`, `readbackMs`, `revision` | Sends one `LFRM` frame first |
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
