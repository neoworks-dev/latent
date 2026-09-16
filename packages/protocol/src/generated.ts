// GENERATED from protocol/messages.schema.json by packages/protocol/scripts/generate.ts.
// Do not edit. Change the schema and run `bun run generate`.

export type MethodName =
  | "engine.hello"
  | "ops.describe"
  | "photo.open"
  | "photo.close"
  | "stack.get"
  | "stack.set"
  | "op.add"
  | "op.update"
  | "op.remove"
  | "history.undo"
  | "history.redo"
  | "view.open"
  | "view.close"
  | "view.render"
  | "python.run"
  | "catalog.import"
  | "catalog.list"
  | "catalog.get"
  | "catalog.folders"
  | "catalog.setRating"
  | "catalog.setFlag"
  | "catalog.collections"
  | "catalog.collectionSet"
  | "catalog.thumbnail"
  | "catalog.thumbnails"
  | "catalog.remove"
  | "job.cancel"
  | "stack.changed"
  | "engine.log"
  | "catalog.changed"
  | "job.progress"
  | "python.output"
  | "python.finished";
/**
 * Engine → UI messages without an id. Calling one as a method is a -32601 error.
 */
export type NotificationName =
  | "stack.changed"
  | "engine.log"
  | "catalog.changed"
  | "job.progress"
  | "python.output"
  | "python.finished";
/**
 * Stable catalog id (SQLite rowid), so an i64. LTHM binary frames carry it in a u32 slot (protocol/frames.md), which caps thumbnails at 4294967295: catalog.thumbnail and catalog.thumbnails answer -32602 for a larger id instead of sending a frame with a truncated target. Every other method takes the full range.
 */
export type PhotoId = number;
export type ViewId = number;
export type OpId = string;
export type Stack = Op[];
export type PhotoFlag = "none" | "pick" | "reject";
/**
 * One python.run execution. Unique per engine process, so a client can tell its own run's output from another socket's.
 */
export type RunId = number;
/**
 * Notification: the stack of a photo changed by any writer (UI, script, MCP). Carries the new state so the UI never re-fetches.
 */
export type StackChangedParams = StackGetResult & {
  photoId: PhotoId;
  /**
   * `ui` = the receiving client made this change itself; `external` = another socket did; `python`/`mcp` = a script or agent; `history` = undo/redo; `load` = sidecar restore on open.
   */
  source: "ui" | "external" | "python" | "mcp" | "history" | "load";
  /**
   * Who caused the change, one step more specific than `source` and free-form so it can name a tool: `ui`, `external`, `python`, `mcp:<tool>` (e.g. `mcp:run_python`), `history`, `load`. Per socket like `source` is — the writer sees `ui`, the others `external`. A console prints it; nothing branches on it.
   */
  client?: string;
};
export type JobId = number;

/**
 * JSON-RPC 2.0 methods between the Latent engine and its UI. Each method has <Method>Params and <Method>Result. Phase 0 surface only.
 */
export interface LatentProtocol {
  Envelope?: Envelope;
  RpcError?: RpcError;
  MethodName?: MethodName;
  NotificationName?: NotificationName;
  PhotoId?: PhotoId;
  ViewId?: ViewId;
  OpId?: OpId;
  Op?: Op;
  MaskRef?: MaskRef;
  Stack?: Stack;
  OpParamSpec?: OpParamSpec;
  OpParamDisplay?: OpParamDisplay;
  OpDefinition?: OpDefinition;
  Histogram?: Histogram;
  EngineHelloParams?: EngineHelloParams;
  EngineHelloResult?: EngineHelloResult;
  OpsDescribeParams?: OpsDescribeParams;
  OpsDescribeResult?: OpsDescribeResult;
  PhotoOpenParams?: PhotoOpenParams;
  PhotoOpenResult?: PhotoOpenResult;
  PhotoCloseParams?: PhotoCloseParams;
  PhotoCloseResult?: PhotoCloseResult;
  StackGetParams?: StackGetParams;
  StackGetResult?: StackGetResult;
  StackSetParams?: StackSetParams;
  StackSetResult?: StackGetResult;
  OpAddParams?: OpAddParams;
  OpAddResult?: StackGetResult;
  OpUpdateParams?: OpUpdateParams;
  OpUpdateResult?: StackGetResult;
  OpRemoveParams?: OpRemoveParams;
  OpRemoveResult?: StackGetResult;
  HistoryUndoParams?: StackGetParams;
  HistoryUndoResult?: StackGetResult;
  HistoryRedoParams?: StackGetParams;
  HistoryRedoResult?: StackGetResult;
  ViewOpenParams?: ViewOpenParams;
  ViewOpenResult?: ViewOpenResult;
  ViewCloseParams?: ViewCloseParams;
  ViewCloseResult?: ViewCloseResult;
  ViewRenderParams?: ViewRenderParams;
  ViewRenderResult?: ViewRenderResult;
  PythonRunParams?: PythonRunParams;
  PythonRunResult?: PythonRunResult;
  PythonOutputParams?: PythonOutputParams;
  PythonFinishedParams?: PythonFinishedParams;
  StackChangedParams?: StackChangedParams;
  EngineLogParams?: EngineLogParams;
  PhotoFlag?: PhotoFlag;
  CatalogPhoto?: CatalogPhoto;
  CatalogCollection?: CatalogCollection;
  JobId?: JobId;
  RunId?: RunId;
  CatalogImportParams?: CatalogImportParams;
  CatalogImportResult?: CatalogImportResult;
  CatalogListParams?: CatalogListParams;
  CatalogListResult?: CatalogListResult;
  CatalogGetParams?: CatalogGetParams;
  CatalogGetResult?: CatalogPhoto;
  CatalogFoldersParams?: CatalogFoldersParams;
  CatalogFoldersResult?: CatalogFoldersResult;
  CatalogSetRatingParams?: CatalogSetRatingParams;
  CatalogSetRatingResult?: CatalogPhoto;
  CatalogSetFlagParams?: CatalogSetFlagParams;
  CatalogSetFlagResult?: CatalogPhoto;
  CatalogCollectionsParams?: CatalogCollectionsParams;
  CatalogCollectionsResult?: CatalogCollectionsResult;
  CatalogCollectionSetParams?: CatalogCollectionSetParams;
  CatalogCollectionSetResult?: CatalogCollectionsResult;
  CatalogThumbnailParams?: CatalogThumbnailParams;
  CatalogThumbnailResult?: CatalogThumbnailResult;
  CatalogThumbnailsParams?: CatalogThumbnailsParams;
  CatalogThumbnailsResult?: CatalogThumbnailsResult;
  CatalogRemoveParams?: CatalogRemoveParams;
  CatalogRemoveResult?: CatalogRemoveResult;
  JobCancelParams?: JobCancelParams;
  JobCancelResult?: JobCancelResult;
  CatalogChangedParams?: CatalogChangedParams;
  JobProgressParams?: JobProgressParams;
}
/**
 * JSON-RPC 2.0 envelope. `id` absent on notifications.
 */
export interface Envelope {
  jsonrpc: "2.0";
  id?: number | string;
  method?: MethodName;
  params?: {
    [k: string]: unknown | undefined;
  };
  result?: unknown;
  error?: RpcError;
}
export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}
/**
 * One entry of the op-stack. `op` names a definition from ops.describe; `params` validates against that definition's schema.
 */
export interface Op {
  id: OpId;
  op: string;
  params: {
    [k: string]: unknown | undefined;
  };
  mask?: MaskRef;
  enabled: boolean;
}
/**
 * Phase 1. Reserved so Op's shape does not change when masks arrive.
 */
export interface MaskRef {
  kind: string;
}
/**
 * One slider/control of an op, in Lightroom terms.
 */
export interface OpParamSpec {
  name: string;
  label?: string;
  type: "number" | "integer" | "boolean" | "enum" | "curve";
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  default: unknown;
  values?: string[];
  display?: OpParamDisplay;
}
/**
 * How a generated panel should draw this param. Advisory: a UI that ignores it still renders a correct control from `type`, `min`, `max` and `step`.
 */
export interface OpParamDisplay {
  /**
   * `slider` is the default control. `kelvin` is a white-balance temperature slider, `curve` a tone-curve editor, `hsl` an eight-band colour mixer, `toggle` a checkbox.
   */
  kind: "slider" | "kelvin" | "curve" | "hsl" | "toggle";
  /**
   * Gradient to paint under the track, the way Lightroom tints Temp blue→yellow and Tint green→magenta.
   */
  tint?: "temperature" | "tint" | "hue" | "saturation";
}
export interface OpDefinition {
  name: string;
  /**
   * Lightroom's Edit-panel section this op is drawn in. The display name of `panel`, and the heading a generated panel groups under.
   */
  section?: "Light" | "Color" | "Effects" | "Detail" | "Optics" | "Geometry";
  /**
   * Position inside `section`, ascending, following Lightroom's slider order. Ops without one sort last, then by name.
   */
  order?: number;
  panel: "light" | "color" | "effects" | "detail" | "optics" | "geometry" | "generative";
  label: string;
  params: OpParamSpec[];
}
export interface Histogram {
  bins: number;
  r: number[];
  g: number[];
  b: number[];
  clippedShadowsPct: number;
  clippedHighlightsPct: number;
}
export interface EngineHelloParams {
  client?: string;
}
export interface EngineHelloResult {
  engineVersion: string;
  protocolVersion: number;
  /**
   * Absolute path of the SQLite catalog this daemon opened. A UI shows which catalog it is on; a test asserts it is the throwaway one and not ~/.local/share/latent/catalog.db.
   */
  catalogPath: string;
  /**
   * Streamable-HTTP endpoint of the engine's MCP server, e.g. http://127.0.0.1:7801/mcp. Absent when the daemon was started with --no-mcp or the SDK failed to load.
   */
  mcpUrl?: string;
  gpu: {
    adapter: string;
    maxTextureDimension2D: number;
    shaderF16: boolean;
  };
}
export interface OpsDescribeParams {}
export interface OpsDescribeResult {
  ops: OpDefinition[];
}
export interface PhotoOpenParams {
  path: string;
}
/**
 * Opening a file catalogs it, so `catalog` carries the row and a client never has to follow photo.open with catalog.get. It is absent only when the engine opened a file it did not catalog.
 */
export interface PhotoOpenResult {
  photoId: PhotoId;
  width: number;
  height: number;
  camera: string;
  /**
   * SHA-256 hex of the raw file, as stored in the sidecar.
   */
  hash: string;
  /**
   * True when an existing .latent sidecar was read and its stack restored.
   */
  sidecarLoaded: boolean;
  catalog?: CatalogPhoto;
}
/**
 * One catalog row. `photoId` is the stable id used everywhere else.
 */
export interface CatalogPhoto {
  photoId: PhotoId;
  path: string;
  /**
   * Absolute directory containing the file.
   */
  folder: string;
  filename: string;
  width: number;
  height: number;
  camera: string;
  lens?: string;
  /**
   * ISO 8601 from EXIF; absent when unknown.
   */
  capturedAt?: string;
  /**
   * ISO 8601.
   */
  importedAt: string;
  /**
   * ISO 8601 of the last non-transient stack change; absent when never edited.
   */
  editedAt?: string;
  rating: number;
  flag: PhotoFlag;
  hasSidecar: boolean;
  /**
   * SHA-256 hex of the raw file, the same value photo.open returns. Present once the engine has hashed the file — an import registers a row before hashing it, so a freshly imported row can lack it until it is opened.
   */
  hash?: string;
  iso?: number;
  /**
   * e.g. "1/250"
   */
  shutter?: string;
  aperture?: number;
  focalLength?: number;
}
export interface PhotoCloseParams {
  photoId: PhotoId;
}
export interface PhotoCloseResult {}
export interface StackGetParams {
  photoId: PhotoId;
}
export interface StackGetResult {
  stack: Stack;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  histogram?: Histogram;
}
export interface StackSetParams {
  photoId: PhotoId;
  stack: Stack;
}
export interface OpAddParams {
  photoId: PhotoId;
  op: string;
  /**
   * Omitted keys take the registry defaults; omitted entirely adds the op at defaults.
   */
  params?: {
    [k: string]: unknown | undefined;
  };
  /**
   * Insert position; end of stack when omitted.
   */
  index?: number;
  /**
   * True when the add is the first tick of a slider drag: no history snapshot, no sidecar write, so the whole drag undoes as one step. The first non-transient update after it snapshots.
   */
  transient?: boolean;
}
export interface OpUpdateParams {
  photoId: PhotoId;
  opId: OpId;
  /**
   * Partial; merged into the op's params.
   */
  params: {
    [k: string]: unknown | undefined;
  };
  enabled?: boolean;
  /**
   * True while a slider is being dragged: no history snapshot, no sidecar write. The first non-transient update after a drag snapshots.
   */
  transient?: boolean;
}
export interface OpRemoveParams {
  photoId: PhotoId;
  opId: OpId;
}
/**
 * A view is one canvas showing one photo at one proxy size. Frames for it arrive as LFRM binary frames tagged with viewId.
 */
export interface ViewOpenParams {
  photoId: PhotoId;
  width: number;
  height: number;
}
export interface ViewOpenResult {
  viewId: ViewId;
}
export interface ViewCloseParams {
  viewId: ViewId;
}
export interface ViewCloseResult {}
/**
 * Ask for a frame of the view's current state. Resizing happens here too.
 */
export interface ViewRenderParams {
  viewId: ViewId;
  width?: number;
  height?: number;
}
export interface ViewRenderResult {
  seq: number;
  /**
   * Stack revision the frame was rendered from — the same counter as StackGetResult.revision. A client that coalesced slider drags compares it with the revision of the last stack.changed it saw to know whether the frame it is holding is the newest state or one render behind.
   */
  revision: number;
  /**
   * Size of the frame that was sent, so a client that dropped it still knows the view size.
   */
  width: number;
  height: number;
  renderMs: number;
  readbackMs: number;
}
export interface PythonRunParams {
  code: string;
  /**
   * Stable catalog id (SQLite rowid), so an i64. LTHM binary frames carry it in a u32 slot (protocol/frames.md), which caps thumbnails at 4294967295: catalog.thumbnail and catalog.thumbnails answer -32602 for a larger id instead of sending a frame with a truncated target. Every other method takes the full range.
   */
  photoId?: number;
  /**
   * Wall-clock budget for the script. On expiry the engine interrupts it with KeyboardInterrupt and answers with an error result (`ok: false`, the traceback in `stderr`), never by dropping the call. Default 30000.
   */
  timeoutMs?: number;
}
export interface PythonRunResult {
  ok: boolean;
  /**
   * Wall-clock time the script took, measured around the interpreter call. The same number the run's python.finished carries. Optional only so a client written against an older engine still typechecks; latentd and the mock always send it.
   */
  durationMs?: number;
  stdout: string;
  stderr: string;
  /**
   * repr() of the script's last expression, if any.
   */
  value?: string;
  /**
   * Set when the engine streamed the run's output as python.output notifications. `stdout`/`stderr` still carry the complete streams, so a client that showed the live output replaces it with these when the call returns.
   */
  runId?: number;
}
/**
 * Notification: output a still-running script has produced. Sent to the socket that issued python.run, before that call's result. Long scripts stream; a short one may answer with the result alone.
 */
export interface PythonOutputParams {
  runId: RunId;
  stream: "stdout" | "stderr";
  /**
   * The chunk as written, newlines included. Never re-sent, never trimmed.
   */
  text: string;
}
/**
 * Notification: a run ended. Sent to the socket that issued python.run, after that run's last python.output and before the RPC result, so a console can close the output stream without waiting for the result to arrive.
 */
export interface PythonFinishedParams {
  runId: RunId;
  /**
   * Wall-clock time the script took. Matches the run's PythonRunResult.durationMs.
   */
  durationMs: number;
  /**
   * False when the script raised or ran out of its timeoutMs budget; the traceback is in the result's stderr, not here.
   */
  ok: boolean;
}
export interface EngineLogParams {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  /**
   * Stable catalog id (SQLite rowid), so an i64. LTHM binary frames carry it in a u32 slot (protocol/frames.md), which caps thumbnails at 4294967295: catalog.thumbnail and catalog.thumbnails answer -32602 for a larger id instead of sending a frame with a truncated target. Every other method takes the full range.
   */
  photoId?: number;
}
export interface CatalogCollection {
  collectionId: number;
  name: string;
  count: number;
}
/**
 * Registers files (or every raw in the given directories) in the catalog and queues thumbnails. Returns immediately; progress arrives as job.progress notifications.
 */
export interface CatalogImportParams {
  /**
   * @minItems 1
   */
  paths: [string, ...string[]];
  /**
   * Descend into subdirectories. Default true; only directories in `paths` are affected.
   */
  recursive?: boolean;
}
export interface CatalogImportResult {
  jobId: JobId;
  /**
   * The thumbnail job the import queues behind itself, reserved up front so a client can follow both from the one result. Its job.progress carries parentJobId = jobId. It always reports, even when the import found nothing or was cancelled — then with total 0. Absent from an engine that does not queue thumbnails.
   */
  thumbnailJobId?: number;
}
/**
 * Catalog rows, filtered and sorted. Every property narrows the result; combining them is an AND. Rows with equal sort keys are ordered by filename ascending, then by photoId ascending, so paging is stable and the same list never reshuffles between calls.
 */
export interface CatalogListParams {
  /**
   * Exact folder match; omit for every photo.
   */
  folder?: string;
  /**
   * Exactly these rows, in the list's sort order. Ids that are not in the catalog are left out rather than erroring. Useful for refreshing a selection without re-listing a page.
   */
  photoIds?: PhotoId[];
  /**
   * Case-insensitive substring match over filename and camera. Empty string matches everything.
   */
  query?: string;
  collectionId?: number;
  flag?: PhotoFlag;
  minRating?: number;
  sort?: "capturedAt" | "importedAt" | "filename" | "rating" | "editedAt";
  descending?: boolean;
  limit?: number;
  offset?: number;
}
export interface CatalogListResult {
  photos: CatalogPhoto[];
  /**
   * Matches before limit/offset.
   */
  total: number;
}
export interface CatalogGetParams {
  photoId: PhotoId;
}
export interface CatalogFoldersParams {}
export interface CatalogFoldersResult {
  folders: {
    path: string;
    count: number;
  }[];
}
export interface CatalogSetRatingParams {
  photoId: PhotoId;
  rating: number;
}
export interface CatalogSetFlagParams {
  photoId: PhotoId;
  flag: PhotoFlag;
}
export interface CatalogCollectionsParams {}
export interface CatalogCollectionsResult {
  collections: CatalogCollection[];
}
/**
 * Create (name without collectionId), rename (both), add/remove members, or delete a collection.
 */
export interface CatalogCollectionSetParams {
  collectionId?: number;
  name?: string;
  add?: PhotoId[];
  remove?: PhotoId[];
  delete?: boolean;
}
/**
 * Sends an LTHM binary frame (JPEG, target = photoId) before the result. Cached on disk by the engine; generated from the embedded preview when the raw has one, else from a fast half-size decode. A photoId above 4294967295 does not fit the frame's u32 target and is refused with -32602.
 */
export interface CatalogThumbnailParams {
  photoId: PhotoId;
  /**
   * Long edge in px. Default 256.
   */
  size?: number;
}
export interface CatalogThumbnailResult {
  photoId: PhotoId;
  width: number;
  height: number;
}
/**
 * Batch form of catalog.thumbnail: one LTHM binary frame per photo that has one, all sent before the result. A filmstrip asks for the page it is about to draw in one call instead of one call per cell. An id above 4294967295 does not fit the frame's u32 target: the whole call is refused with -32602 rather than listed in `missing`, because it is a malformed request and not a photo that failed to render.
 */
export interface CatalogThumbnailsParams {
  photoIds: PhotoId[];
  /**
   * Long edge in px, the same for every photo in the batch. Default 256.
   */
  size?: number;
}
/**
 * Sent after the frames. A photo that produced no thumbnail — unknown id, unreadable file, decode failure — is listed in `missing` and has no frame; the call itself does not fail.
 */
export interface CatalogThumbnailsResult {
  /**
   * photoIds after de-duplication.
   */
  requested: number;
  /**
   * Frames sent before this result.
   */
  sent: number;
  missing: PhotoId[];
}
/**
 * Removes catalog rows: the database entries, their thumbnails and their collection memberships. Files on disk and their .latent sidecars are never touched — re-importing the same path brings the photo back (with a new photoId). Ids that are not in the catalog are ignored.
 */
export interface CatalogRemoveParams {
  photoIds: PhotoId[];
}
export interface CatalogRemoveResult {
  /**
   * Rows actually deleted.
   */
  removed: number;
}
/**
 * Asks a running job to stop at its next safe point. Work already done stands: a cancelled import keeps the photos it registered.
 */
export interface JobCancelParams {
  jobId: JobId;
}
export interface JobCancelResult {
  /**
   * True when a running job was asked to stop; false when the job is unknown or already finished. The job's last job.progress then has `finished: true` and `state: "cancelled"`.
   */
  cancelled: boolean;
}
/**
 * Notification: catalog rows changed. Clients re-list what they show.
 */
export interface CatalogChangedParams {
  photoIds: PhotoId[];
  reason: "import" | "rating" | "flag" | "collection" | "edit" | "remove";
}
/**
 * Notification for long-running engine work (import, thumbnails, later export).
 */
export interface JobProgressParams {
  jobId: JobId;
  /**
   * The job that queued this one — set on the thumbnail job an import spawns, absent on a job nobody spawned. A progress UI nests the child under its parent instead of showing two unrelated bars.
   */
  parentJobId?: number;
  kind: "import" | "thumbnails" | "export";
  done: number;
  total: number;
  finished: boolean;
  /**
   * How the job stands. `running` while `finished` is false; one of the other three on the last notification. Absent means `running` until finished, then `done` — so a client written before this field keeps working.
   */
  state?: "running" | "done" | "cancelled" | "error";
  message?: string;
  error?: string;
}
