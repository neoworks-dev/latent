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
  "op.add": { params: G.OpAddParams; result: G.OpAddResult };
  "op.update": { params: G.OpUpdateParams; result: G.StackGetResult };
  "op.remove": { params: G.OpRemoveParams; result: G.StackGetResult };
  "history.undo": { params: G.StackGetParams; result: G.StackGetResult };
  "history.redo": { params: G.StackGetParams; result: G.StackGetResult };
  "history.list": { params: G.StackGetParams; result: G.HistoryListResult };
  "history.jump": { params: G.HistoryJumpParams; result: G.StackGetResult };
  "history.revertOp": { params: G.HistoryRevertOpParams; result: G.StackGetResult };
  "history.merge": { params: G.HistoryMergeParams; result: G.StackGetResult };
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
  "mask.preview": { params: G.MaskPreviewParams; result: G.MaskPreviewResult };
  "mask.detect": { params: G.MaskDetectParams; result: G.MaskDetectResult };
  // Returns a jobId; the map lands while job.progress kind `depth` ticks, and
  // depth.changed says it is there. depth.preview sends one LDPT frame before its result.
  "depth.estimate": { params: G.DepthEstimateParams; result: G.DepthEstimateResult };
  "depth.status": { params: G.DepthStatusParams; result: G.DepthStatusResult };
  "depth.preview": { params: G.DepthPreviewParams; result: G.DepthPreviewResult };
  "generative.run": { params: G.GenerativeRunParams; result: G.GenerativeRunResult };
  "generative.status": { params: G.GenerativeStatusParams; result: G.GenerativeStatusResult };
  // MaskStrokeResult is a `$ref` alias of StackGetResult; the generator dedupes it.
  "mask.stroke": { params: G.MaskStrokeParams; result: G.StackGetResult };
  // Returns a jobId at once; the files land while job.progress kind `export` ticks.
  "export.run": { params: G.ExportRunParams; result: G.ExportRunResult };
  "catalog.thumbnails": { params: G.CatalogThumbnailsParams; result: G.CatalogThumbnailsResult };
  "catalog.remove": { params: G.CatalogRemoveParams; result: G.CatalogRemoveResult };
  "job.cancel": { params: G.JobCancelParams; result: G.JobCancelResult };
  // A hint, not a queue operation: the running preview job takes these photos next.
  "preview.prioritize": {
    params: G.PreviewPrioritizeParams;
    result: G.PreviewPrioritizeResult;
  };
  // All five answer `{ jobId }`; the merged photo's id arrives on the job's last
  // job.progress, in `result`, because the merge itself takes minutes.
  "merge.hdr": { params: G.MergeHdrParams; result: G.MergeHdrResult };
  "merge.panorama": { params: G.MergePanoramaParams; result: G.MergePanoramaResult };
  "merge.hdrPanorama": { params: G.MergeHdrPanoramaParams; result: G.MergeHdrPanoramaResult };
  "merge.starTrail": { params: G.MergeStarTrailParams; result: G.MergeStarTrailResult };
  "merge.preview": { params: G.MergePreviewParams; result: G.MergePreviewResult };
}

export interface NotificationMap {
  "stack.changed": G.StackChangedParams;
  "engine.log": G.EngineLogParams;
  "catalog.changed": G.CatalogChangedParams;
  "job.progress": G.JobProgressParams;
  "photo.resolution": G.PhotoResolutionParams;
  "python.output": G.PythonOutputParams;
  "python.finished": G.PythonFinishedParams;
  "depth.changed": G.DepthChangedParams;
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
  "history.list",
  "history.jump",
  "history.revertOp",
  "history.merge",
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
  "preview.prioritize",
  "merge.hdr",
  "merge.panorama",
  "merge.hdrPanorama",
  "merge.starTrail",
  "merge.preview",
  "mask.preview",
  "mask.detect",
  "depth.estimate",
  "depth.status",
  "depth.preview",
  "generative.run",
  "generative.status",
  "mask.stroke",
  "export.run",
];

export const notifications: readonly NotificationName[] = [
  "stack.changed",
  "engine.log",
  "catalog.changed",
  "job.progress",
  "photo.resolution",
  "python.output",
  "python.finished",
  "depth.changed",
];
