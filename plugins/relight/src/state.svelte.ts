// The Relight column's own state: whether the photo has a depth map, the job that is
// producing one, and which light the column is pointed at. Nothing here is edit state — a
// light is a `relight` op in the engine's stack and every slider write goes there
// (PROMPT.md 3.8) — and the depth map is not edit state either: it describes the scene, so
// it belongs to the photo and costs no undo step.
import type { EngineClient, PaneRegistry, ViewerService } from "@latent/contracts";
import type { Op } from "@latent/protocol";
import { lightsIn, RELIGHT_OP } from "./relight";

/** The rail mode this tool owns; `panes.setMode` is how it is entered and left. */
export const RELIGHT_MODE = "relight";

/** What a new light starts as: over the middle of the frame, on, and not yet dramatic. */
const NEW_LIGHT = {
  x: 0.5,
  y: 0.35,
  distance: 60,
  intensity: 45,
  radius: 40,
  kelvin: 4500,
  occlusion: 70,
  softness: 40,
  // Rays on from the start: shafts through whatever stands between the light and the camera
  // are the point of placing one, and a light that only lifts the surface it lands on reads
  // as a brightness slider with a handle on it.
  rays: 50,
};

export class RelightState {
  depthReady = $state(false);
  /** What produced the map — the model's store name, or the stub. */
  depthModel = $state("");
  /** The depth.estimate job, or null when nothing is running. */
  jobId = $state<number | null>(null);
  error = $state("");
  /** Whether the viewer draws the depth map over the photo. */
  showDepth = $state(false);
  /** The light the column edits; the newest one when nothing was picked. */
  selectedId = $state<string | null>(null);

  private readonly unsubscribe: (() => void)[] = [];

  constructor(
    private readonly engine: EngineClient,
    private readonly viewer: ViewerService,
    private readonly panes: PaneRegistry,
  ) {
    this.unsubscribe.push(
      engine.on("depth.changed", (params) => {
        if (params.photoId !== this.viewer.photoId) return;
        this.depthReady = params.ready;
        this.depthModel = params.model ?? "";
        // The map is not stack state, so no stack.changed follows it: every relight op on
        // the photo starts rendering now and the frame on screen is a frame without them.
        this.viewer.requestRender();
      }),
      engine.on("job.progress", (params) => {
        if (params.kind !== "depth" || params.jobId !== this.jobId) return;
        if (!params.finished) return;
        this.jobId = null;
        this.error = params.error ?? "";
      }),
    );
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
  }

  /** The tool is open exactly when the rail is on it; the rail is the one truth. */
  get active(): boolean {
    return this.panes.mode === RELIGHT_MODE;
  }

  get running(): boolean {
    return this.jobId !== null;
  }

  get lights(): Op[] {
    return lightsIn(this.viewer.stack);
  }

  /** The light the sliders and the overlay are aimed at. */
  get op(): Op | undefined {
    const lights = this.lights;
    const picked = lights.find((light) => light.id === this.selectedId);
    return picked ?? lights.at(-1);
  }

  enter(): void {
    this.panes.setMode(RELIGHT_MODE);
  }

  leave(): void {
    if (!this.active) return;
    this.panes.setMode("edit");
  }

  toggle(): void {
    if (this.active) this.leave();
    else this.enter();
  }

  /** Asked when the column opens and when the photo changes, never per frame. */
  async refresh(): Promise<void> {
    const photoId = this.viewer.photoId;
    if (photoId === null) {
      this.depthReady = false;
      this.depthModel = "";
      return;
    }
    try {
      const status = await this.engine.call("depth.status", { photoId });
      this.depthReady = status.ready;
      this.depthModel = status.model ?? "";
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** The only thing that runs the model. A map that exists is never re-estimated on its own. */
  async estimate(): Promise<void> {
    const photoId = this.viewer.photoId;
    if (photoId === null || this.running) return;
    this.error = "";
    try {
      const { jobId } = await this.engine.call("depth.estimate", { photoId });
      this.jobId = jobId;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** Adds a light at the frame's centre and selects it. */
  async addLight(): Promise<string | null> {
    const photoId = this.viewer.photoId;
    if (photoId === null) return null;
    this.error = "";
    try {
      const state = await this.engine.call("op.add", {
        photoId,
        op: RELIGHT_OP,
        params: { ...NEW_LIGHT },
      });
      const added = lightsIn(state.stack).at(-1);
      this.selectedId = added?.id ?? null;
      return added?.id ?? null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  async remove(opId: string): Promise<void> {
    if (this.selectedId === opId) this.selectedId = null;
    await this.viewer.removeOp(opId);
  }

  /** A slider or an overlay drag. `transient` while a pointer is down, as everywhere else. */
  async setParams(params: Record<string, unknown>, transient: boolean): Promise<void> {
    const op = this.op;
    if (!op) return;
    await this.viewer.setOpParams(op.id, params, transient);
  }
}
