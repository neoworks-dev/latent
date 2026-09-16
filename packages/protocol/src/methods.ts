// Typed method table over the generated schema types. Adding a method to the schema
// without adding it here is a typecheck error, which is the point.
import type * as G from "./generated";

export interface MethodMap {
  "engine.hello": { params: G.EngineHelloParams; result: G.EngineHelloResult };
  "ops.describe": { params: G.OpsDescribeParams; result: G.OpsDescribeResult };
  "photo.open": { params: G.PhotoOpenParams; result: G.PhotoOpenResult };
  "photo.close": { params: G.PhotoCloseParams; result: G.PhotoCloseResult };
  "stack.get": { params: G.StackGetParams; result: G.StackGetResult };
  // The schema declares these results/params as `$ref` aliases of StackGet*; the
  // generator dedupes identical types, so the canonical names are used here.
  "stack.set": { params: G.StackSetParams; result: G.StackGetResult };
  "op.add": { params: G.OpAddParams; result: G.StackGetResult };
  "op.update": { params: G.OpUpdateParams; result: G.StackGetResult };
  "op.remove": { params: G.OpRemoveParams; result: G.StackGetResult };
  "history.undo": { params: G.StackGetParams; result: G.StackGetResult };
  "history.redo": { params: G.StackGetParams; result: G.StackGetResult };
  "view.open": { params: G.ViewOpenParams; result: G.ViewOpenResult };
  "view.close": { params: G.ViewCloseParams; result: G.ViewCloseResult };
  "view.render": { params: G.ViewRenderParams; result: G.ViewRenderResult };
  "python.run": { params: G.PythonRunParams; result: G.PythonRunResult };
}

export interface NotificationMap {
  "stack.changed": G.StackChangedParams;
  "engine.log": G.EngineLogParams;
}

export type MethodName = keyof MethodMap;

/** Runtime list, kept in sync with the schema's MethodName enum by the protocol test. */
export const methods: readonly MethodName[] = [
  "engine.hello",
  "ops.describe",
  "photo.open",
  "photo.close",
  "stack.get",
  "stack.set",
  "op.add",
  "op.update",
  "op.remove",
  "history.undo",
  "history.redo",
  "view.open",
  "view.close",
  "view.render",
  "python.run",
];
