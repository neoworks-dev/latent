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
  | "stack.changed"
  | "engine.log";
export type PhotoId = number;
export type ViewId = number;
export type OpId = string;
export type Stack = Op[];
/**
 * Notification: the stack of a photo changed by any writer (UI, script, MCP). Carries the new state so the UI never re-fetches.
 */
export type StackChangedParams = StackGetResult & {
  photoId: PhotoId;
  source: "ui" | "python" | "mcp" | "history" | "load";
};

/**
 * JSON-RPC 2.0 methods between the Latent engine and its UI. Each method has <Method>Params and <Method>Result. Phase 0 surface only.
 */
export interface LatentProtocol {
  Envelope?: Envelope;
  RpcError?: RpcError;
  MethodName?: MethodName;
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
  params: {
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
  renderMs: number;
  readbackMs: number;
}
export interface PythonRunParams {
  code: string;
  /**
   * Bound to `latent.photo` for the run.
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
}
