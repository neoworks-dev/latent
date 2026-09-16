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
  | "stack.changed"
  | "engine.log"
  | "catalog.changed"
  | "job.progress";
/**
 * Engine → UI messages without an id. Calling one as a method is a -32601 error.
 */
export type NotificationName = "stack.changed" | "engine.log" | "catalog.changed" | "job.progress";
/**
 * Stable catalog id (SQLite rowid). photo.open returns the same id for the same file; a file not yet in the catalog is added on open.
 */
export type PhotoId = number;
export type ViewId = number;
export type OpId = string;
export type Stack = Op[];
/**
 * Notification: the stack of a photo changed by any writer (UI, script, MCP). Carries the new state so the UI never re-fetches.
 */
export type StackChangedParams = StackGetResult & {
  photoId: PhotoId;
  /**
   * `ui` = the receiving client made this change itself; `external` = another socket did; `python`/`mcp` = a script or agent; `history` = undo/redo; `load` = sidecar restore on open.
   */
  source: "ui" | "external" | "python" | "mcp" | "history" | "load";
};
export type PhotoFlag = "none" | "pick" | "reject";
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
  StackChangedParams?: StackChangedParams;
  EngineLogParams?: EngineLogParams;
  PhotoFlag?: PhotoFlag;
  CatalogPhoto?: CatalogPhoto;
  CatalogCollection?: CatalogCollection;
  JobId?: JobId;
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
}
export interface OpDefinition {
  name: string;
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
   * Stable catalog id (SQLite rowid). photo.open returns the same id for the same file; a file not yet in the catalog is added on open.
   */
  photoId?: number;
}
export interface PythonRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /**
   * repr() of the script's last expression, if any.
   */
  value?: string;
}
export interface EngineLogParams {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  /**
   * Stable catalog id (SQLite rowid). photo.open returns the same id for the same file; a file not yet in the catalog is added on open.
   */
  photoId?: number;
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
  iso?: number;
  /**
   * e.g. "1/250"
   */
  shutter?: string;
  aperture?: number;
  focalLength?: number;
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
   * Descend into subdirectories. Default true.
   */
  recursive?: boolean;
}
export interface CatalogImportResult {
  jobId: JobId;
}
export interface CatalogListParams {
  /**
   * Exact folder match; omit for every photo.
   */
  folder?: string;
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
 * Sends an LTHM binary frame (JPEG, target = photoId) before the result. Cached on disk by the engine; generated from the embedded preview when the raw has one, else from a fast half-size decode.
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
  kind: "import" | "thumbnails" | "export";
  done: number;
  total: number;
  finished: boolean;
  message?: string;
  error?: string;
}
