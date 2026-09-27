import type { EngineClient } from "@latent/contracts";
import type { HistoryStep } from "@latent/protocol";
import { capturePreset, readPresets, type Preset } from "./presets";
import type { Op } from "@latent/protocol";

/** Where the user's own presets are kept. Not the photo's business, so not the sidecar's. */
const PRESET_KEY = "latent.presets.v1";

/**
 * The left column's own state: the open photo's undo stack as the engine describes it, and
 * the presets this machine has saved. Neither is edit state — the history is a mirror of
 * what the engine holds and a preset is a set of values waiting to be written.
 */
export class DevelopState {
  /** `history.list`'s entries, oldest first, and where the cursor sits in them. */
  steps = $state<HistoryStep[]>([]);
  index = $state(0);
  presets = $state<Preset[]>([]);

  constructor(
    private readonly engine: EngineClient,
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = null,
  ) {
    this.presets = readPresets(this.storage?.getItem(PRESET_KEY) ?? null);
  }

  /** Re-reads the undo stack. Called when the photo or the history cursor changes. */
  async refresh(photoId: number | null): Promise<void> {
    if (photoId === null) {
      this.steps = [];
      this.index = 0;
      return;
    }
    const listed = await this.engine.call("history.list", { photoId });
    this.steps = listed.entries;
    this.index = listed.index;
  }

  /** Clicking a row: the engine moves its cursor and broadcasts, as undo does. */
  async jump(photoId: number, index: number): Promise<void> {
    await this.engine.call("history.jump", { photoId, index });
  }

  /**
   * One op of one step, back to what it was before that step — the rest of the step stays.
   * The engine holds the snapshots, so it does the work; this is an edit like any other and
   * lands as a step of its own.
   */
  async revertOp(photoId: number, index: number, opId: string): Promise<void> {
    await this.engine.call("history.revertOp", { photoId, index, opId });
  }

  /**
   * Another branch joined into the step on screen. The engine does the three-way merge and
   * commits it as a step with both parents; where both branches set one value, the branch
   * merged in wins.
   */
  async merge(photoId: number, index: number): Promise<void> {
    await this.engine.call("history.merge", { photoId, index });
  }

  save(label: string, stack: Op[]): void {
    const name = label.trim();
    if (!name) return;
    this.presets = [...this.presets, capturePreset(name, stack, `user:${Date.now()}`)];
    this.store();
  }

  remove(id: string): void {
    this.presets = this.presets.filter((preset) => preset.id !== id);
    this.store();
  }

  private store(): void {
    this.storage?.setItem(PRESET_KEY, JSON.stringify(this.presets));
  }
}
