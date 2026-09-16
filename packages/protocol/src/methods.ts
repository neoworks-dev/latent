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
  "catalog.import": { params: G.CatalogImportParams; result: G.CatalogImportResult };
  "catalog.list": { params: G.CatalogListParams; result: G.CatalogListResult };
  "catalog.get": { params: G.CatalogGetParams; result: G.CatalogPhoto };
  "catalog.folders": { params: G.CatalogFoldersParams; result: G.CatalogFoldersResult };
  "catalog.setRating": { params: G.CatalogSetRatingParams; result: G.CatalogPhoto };
  "catalog.setFlag": { params: G.CatalogSetFlagParams; result: G.CatalogPhoto };
  "catalog.collections": { params: G.CatalogCollectionsParams; result: G.CatalogCollectionsResult };
  "catalog.collectionSet": { params: G.CatalogCollectionSetParams; result: G.CatalogCollectionsResult };
  "catalog.thumbnail": { params: G.CatalogThumbnailParams; result: G.CatalogThumbnailResult };
  "catalog.thumbnails": { params: G.CatalogThumbnailsParams; result: G.CatalogThumbnailsResult };
  "catalog.remove": { params: G.CatalogRemoveParams; result: G.CatalogRemoveResult };
  "job.cancel": { params: G.JobCancelParams; result: G.JobCancelResult };
}

export interface NotificationMap {
  "stack.changed": G.StackChangedParams;
  "engine.log": G.EngineLogParams;
  "catalog.changed": G.CatalogChangedParams;
  "job.progress": G.JobProgressParams;
  "python.output": G.PythonOutputParams;
  "python.finished": G.PythonFinishedParams;
}

export type MethodName = keyof MethodMap;
export type NotificationName = keyof NotificationMap;

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
  "catalog.import",
  "catalog.list",
  "catalog.get",
  "catalog.folders",
  "catalog.setRating",
  "catalog.setFlag",
  "catalog.collections",
  "catalog.collectionSet",
  "catalog.thumbnail",
  "catalog.thumbnails",
  "catalog.remove",
  "job.cancel",
];

export const notifications: readonly NotificationName[] = [
  "stack.changed",
  "engine.log",
  "catalog.changed",
  "job.progress",
  "python.output",
  "python.finished",
];
