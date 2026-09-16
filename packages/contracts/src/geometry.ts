// The one thing a geometry tool needs from the viewer that a panel does not: which
// geometry the frames are rendered with. `view.render`'s `geometry: "full"` draws the
// uncropped image so the crop overlay can show what is being cut away, and the viewer is
// the only place that call is made from — one render in flight, coalesced with the rest.
import type { ViewRenderParams } from "@latent/protocol";

/** `stack` is the whole stack; `full` bypasses the crop op's rect and straighten. */
export type GeometryMode = NonNullable<ViewRenderParams["geometry"]>;

/**
 * Provided under `geometryView` by the viewer plugin, alongside `viewer` itself. Split
 * from `ViewerService` because it is the crop tool's contract and nothing else's: a panel
 * that writes ops has no business changing how the frame is rendered.
 */
export interface GeometryView {
  /**
   * What the next frames are rendered with. Plain state, not reactive: the tool that owns
   * it sets it from an `$effect` on mount, and a signal that effect also read would re-run
   * itself forever.
   */
  readonly geometry: GeometryMode;
  /** Sets it and asks for a frame; a no-op when it is already that. */
  setGeometry(mode: GeometryMode): void;
}
