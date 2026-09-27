import type { EngineClient, ViewerService } from "@latent/contracts";
import {
  HarnessClient,
  type Effort,
  type HarnessId,
  type HarnessInfo,
  type HarnessSession,
  type ModelInfo,
  type PromptRun,
  type RequestPermissionRequest,
  type SessionInit,
  type SessionUpdate,
} from "@neoworks/harness/client";
import type { JobProgressParams } from "@latent/protocol";
import {
  agentJobLabel,
  applyUpdate,
  asksFirst,
  buildPrompt,
  jobOutcome,
  jobsFinishedPrompt,
  loadConversation,
  loadPlacement,
  loadSettings,
  PLACEMENT_KEY,
  saveConversation,
  saveSettings,
  SYSTEM_PROMPT,
  type AssistantSettings,
  type Target,
  type TranscriptItem,
} from "./assistant";
import { MAX_REFERENCES, readReference, type Reference } from "./references";

export interface HarnessEndpoint {
  url: string;
  token: string;
}

/** A tool call waiting for the user; `decide` answers the harness. */
export interface PendingApproval {
  title: string;
  decide(allowed: boolean): void;
}

/** Typed into the chat, it starts a new conversation instead of being sent. */
export const CLEAR_COMMAND = "/clear";

/**
 * The selection chat. The agent runs in a harness sidecar and acts on the photo through
 * the engine's MCP server, so its edits reach the stack like any other writer's and this
 * holds no edit state — only the conversation, one per photo, kept across closing the chat
 * and across restarts: the harness resumes the session, localStorage keeps the transcript.
 */
export class AssistantState {
  status = $state<"connecting" | "ready" | "unavailable">("connecting");
  /** Why the assistant is unavailable, or why the last turn failed. */
  error = $state<string | null>(null);
  harnesses = $state<HarnessInfo[]>([]);
  /** Models per harness, fetched when that harness is picked; asking starts it once. */
  models = $state<Partial<Record<HarnessId, ModelInfo[]>>>({});
  settings: AssistantSettings;
  /** The selected region in image space, or the whole photo; the chat is open while there is one. */
  target = $state<Target | null>(null);
  /** Reference images for the next message. */
  references = $state<Reference[]>([]);
  items = $state<TranscriptItem[]>([]);
  running = $state(false);
  pending = $state<PendingApproval | null>(null);
  /** Cost of the conversation so far, when the harness reports one. */
  costUsd = $state<number | null>(null);
  /**
   * Where the user dropped the chat, in the viewer's CSS pixels; null follows the
   * selection. View state, remembered like a floating card's place.
   */
  placement = $state<{ left: number; top: number } | null>(null);
  /** The agent ended its turn on jobs it started, and is woken when they are all done. */
  waiting = $state(false);

  private client: HarnessClient | null = null;
  private session: HarnessSession | null = null;
  private run: PromptRun | null = null;
  private mcpUrl: string | null = null;
  private disposed = false;
  /** Plain fields: `showPhoto` runs from an effect and must not read state it writes. */
  private conversationPhoto: number | null = null;
  /** The stored session the next message resumes, until one is open. */
  private resumeId: string | null = null;
  /** The last undo step a tool's changes were read up to. */
  private historyIndex = 0;
  /** The agent's jobs still running, by jobId, and how the finished ones went. */
  private activeJobs: number[] = [];
  private jobOutcomes: string[] = [];
  private readonly unsubscribeJobs: () => void;

  constructor(
    private readonly engine: EngineClient,
    private readonly viewer: ViewerService,
    private readonly storage: Pick<Storage, "getItem" | "setItem">,
  ) {
    this.settings = $state(loadSettings(storage));
    this.placement = loadPlacement(storage);
    this.unsubscribeJobs = engine.on("job.progress", (params) => this.onJob(params));
  }

  /** A drag dropped the chat here; null puts it back next to the selection. */
  place(position: { left: number; top: number } | null): void {
    this.placement = position;
    this.storage.setItem(PLACEMENT_KEY, JSON.stringify(position));
  }

  async connect(endpoint: HarnessEndpoint | null): Promise<void> {
    if (!endpoint) {
      this.fail("No harness sidecar: run inside Latent's desktop app.");
      return;
    }
    try {
      await this.engine.whenOpen();
      const hello = await this.engine.call("engine.hello", { client: "assistant" });
      if (!hello.mcpUrl) {
        this.fail("The engine runs without its MCP server (--no-mcp), so an agent cannot edit.");
        return;
      }
      this.mcpUrl = hello.mcpUrl;
      const client = await HarnessClient.connect(endpoint);
      if (this.disposed) {
        await client.close();
        return;
      }
      this.client = client;
      this.harnesses = (await client.listHarnesses()).filter((harness) => harness.available);
      this.status = "ready";
      void this.loadModels(this.settings.harness);
    } catch (error) {
      this.fail(`Harness sidecar unreachable: ${String(error)}`);
    }
  }

  /** The chat follows the open photo: each photo has its own conversation. */
  async showPhoto(photoId: number | null): Promise<void> {
    if (photoId === this.conversationPhoto) return;
    await this.stop();
    await this.closeSession();
    this.conversationPhoto = photoId;
    const stored = photoId === null ? null : loadConversation(this.storage, photoId);
    this.items = stored?.items ?? [];
    this.costUsd = stored?.costUsd ?? null;
    this.resumeId = stored?.harness === this.settings.harness ? stored.sessionId : null;
    this.target = null;
    this.references = [];
    this.error = null;
  }

  /** Point the chat at a box or the whole photo. The conversation carries on. */
  select(target: Target): void {
    this.target = target;
  }

  /** Attach images, past the limit ignored; anything that is not an image is skipped. */
  async attach(files: Iterable<File>): Promise<void> {
    const images = [...files]
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, MAX_REFERENCES - this.references.length);
    try {
      const read = await Promise.all(images.map((file) => readReference(file)));
      this.references = [...this.references, ...read].slice(0, MAX_REFERENCES);
    } catch (error) {
      this.error = `Could not read the image: ${String(error)}`;
    }
  }

  detach(index: number): void {
    this.references = this.references.filter((_, at) => at !== index);
  }

  /** Hide the chat. The conversation stays and the next selection picks it up again. */
  hide(): void {
    this.target = null;
    this.references = [];
    this.error = null;
  }

  /** `/clear`: a new session, and the stored conversation forgotten. */
  async clear(): Promise<void> {
    await this.stop();
    await this.closeSession();
    this.resumeId = null;
    this.items = [];
    this.costUsd = null;
    this.error = null;
    if (this.conversationPhoto !== null)
      saveConversation(this.storage, this.conversationPhoto, null);
  }

  async setHarness(harness: HarnessId): Promise<void> {
    await this.changeSettings({ harness, model: "", effort: "" });
    void this.loadModels(harness);
  }

  async setModel(model: string): Promise<void> {
    await this.changeSettings({ ...this.settings, model });
  }

  async setEffort(effort: Effort | ""): Promise<void> {
    await this.changeSettings({ ...this.settings, effort });
  }

  async send(instruction: string): Promise<void> {
    if (instruction.trim() === CLEAR_COMMAND) {
      await this.clear();
      return;
    }
    const client = this.client;
    const photoId = this.viewer.photoId;
    const target = this.target;
    if (!client || photoId === null || !target || this.running || !instruction.trim()) return;
    // The chat's effect moves the conversation with the photo; a send in between waits.
    if (photoId !== this.conversationPhoto) return;
    const references = this.references;
    this.references = [];
    this.items = [
      ...this.items,
      {
        kind: "user",
        text: instruction.trim(),
        images: references.map((reference) => reference.url),
      },
    ];
    await this.turn(client, photoId, [
      { type: "text", text: buildPrompt(instruction, photoId, target, references.length) },
      ...references.map((reference) => ({
        type: "image" as const,
        data: reference.data,
        mimeType: reference.mimeType,
      })),
    ]);
  }

  /**
   * A detection or a fill the agent started: tracked until it finishes, so the agent can end
   * its turn instead of polling, and be woken once every one of them is done.
   */
  private onJob(params: JobProgressParams): void {
    if (agentJobLabel(params.kind) === null) return;
    if (!params.finished) {
      // Only jobs that start during a turn are the agent's; the user's own are not.
      if (this.running && !this.activeJobs.includes(params.jobId))
        this.activeJobs.push(params.jobId);
      return;
    }
    if (!this.activeJobs.includes(params.jobId)) return;
    this.activeJobs = this.activeJobs.filter((jobId) => jobId !== params.jobId);
    this.jobOutcomes.push(jobOutcome(params));
    void this.wake();
  }

  /** Every job the agent waited on is done: tell it how they went and let it carry on. */
  private async wake(): Promise<void> {
    const client = this.client;
    const photoId = this.conversationPhoto;
    if (!this.waiting || this.running || this.activeJobs.length > 0) return;
    this.waiting = false;
    const outcomes = this.jobOutcomes;
    this.jobOutcomes = [];
    if (!client || photoId === null || photoId !== this.viewer.photoId) return;
    this.note(`${outcomes.join(", ")} — continuing.`);
    await this.turn(client, photoId, [{ type: "text", text: jobsFinishedPrompt(outcomes) }]);
  }

  private async turn(
    client: HarnessClient,
    photoId: number,
    content: Parameters<HarnessSession["prompt"]>[0],
  ): Promise<void> {
    this.error = null;
    this.running = true;
    this.waiting = false;
    this.jobOutcomes = [];
    let turnStart: number | null = null;
    try {
      this.session ??= await this.openSession(client);
      this.historyIndex = (await this.engine.call("history.list", { photoId })).index;
      turnStart = this.historyIndex;
      this.run = this.session.prompt(content);
      for await (const event of this.run) {
        if (event.type === "update") await this.fold(event.update, photoId);
        if (event.type !== "done") continue;
        if (event.usage?.costUsd !== undefined)
          this.costUsd = (this.costUsd ?? 0) + event.usage.costUsd;
        if (event.stopReason === "cancelled") this.note("Stopped.");
      }
    } catch (error) {
      this.error = String(error);
    } finally {
      this.run = null;
      this.running = false;
      if (turnStart !== null) await this.summarize(photoId, turnStart);
      this.persist(photoId);
      // The agent ended its turn on a job it started: it is woken when the job is done —
      // or at once, if the job finished while it was still talking.
      if (this.activeJobs.length > 0 || this.jobOutcomes.length > 0) {
        this.waiting = true;
        void this.wake();
      }
    }
  }

  /** The turn summary's Undo: the photo back to before the turn, stopped or not. */
  async undoTurn(index: number): Promise<void> {
    const photoId = this.conversationPhoto;
    if (photoId === null || this.running) return;
    try {
      await this.engine.call("history.jump", { photoId, index });
    } catch (error) {
      this.error = `Could not undo: ${String(error)}`;
      return;
    }
    this.items = this.items.map((item) => {
      if (item.kind !== "summary" || item.index !== index) return item;
      return { ...item, undone: true };
    });
  }

  /** What the turn left on the photo, stopped or finished, with the Undo that takes it back. */
  private async summarize(photoId: number, turnStart: number): Promise<void> {
    try {
      const listed = await this.engine.call("history.list", { photoId });
      const steps = listed.entries.filter(
        (step) => step.index > turnStart && step.index <= listed.index,
      );
      if (steps.length === 0) return;
      this.items = [...this.items, { kind: "summary", index: turnStart, steps, undone: false }];
    } catch {
      // No history, no summary: the History pane still has every step.
    }
  }

  async stop(): Promise<void> {
    this.pending?.decide(false);
    // Stopping also means not being woken by a job the stopped turn started.
    this.waiting = false;
    this.activeJobs = [];
    this.jobOutcomes = [];
    if (this.session && this.running) await this.session.cancel();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeJobs();
    void this.stop()
      .then(() => this.closeSession())
      .then(() => this.client?.close());
  }

  private sessionInit(): SessionInit {
    const { harness, model, effort } = this.settings;
    return {
      harness,
      mcpServers: [{ type: "http", name: "latent", url: this.mcpUrl ?? "", headers: [] }],
      options: {
        systemPrompt: { replace: SYSTEM_PROMPT },
        tools: "none",
        isolation: "full",
        disable: "all",
        // The harness asks for every tool call; `askUser` lets the undoable ones through.
        permissions: "ask",
        model: model || undefined,
        effort: effort || undefined,
      },
      onPermission: (request) => this.askUser(request),
    };
  }

  /** Resumes the photo's stored session when there is one, else starts a new one. */
  private async openSession(client: HarnessClient): Promise<HarnessSession> {
    const resumeId = this.resumeId;
    this.resumeId = null;
    if (!resumeId) return client.createSession(this.sessionInit());
    try {
      return await client.resumeSession(resumeId, this.sessionInit());
    } catch {
      this.note("The earlier conversation could not be resumed: this is a new one.");
      return client.createSession(this.sessionInit());
    }
  }

  /** One update into the transcript; a finished tool call gets the undo steps it made. */
  private async fold(update: SessionUpdate, photoId: number): Promise<void> {
    this.items = applyUpdate(this.items, update);
    if (update.sessionUpdate !== "tool_call_update") return;
    if (update.status !== "completed" && update.status !== "failed") return;
    const listed = await this.engine.call("history.list", { photoId });
    const steps = listed.entries.filter(
      (step) => step.index > this.historyIndex && step.index <= listed.index,
    );
    this.historyIndex = listed.index;
    if (steps.length === 0) return;
    this.items = this.items.map((item) => {
      if (item.kind !== "tool" || item.id !== update.toolCallId) return item;
      return { ...item, steps };
    });
  }

  private persist(photoId: number): void {
    const session = this.session;
    if (!session || photoId !== this.conversationPhoto) return;
    saveConversation(this.storage, photoId, {
      sessionId: session.id,
      harness: session.harness,
      items: this.items,
      costUsd: this.costUsd,
    });
  }

  private async askUser(request: RequestPermissionRequest): Promise<"once" | "reject"> {
    const title = request.toolCall.title ?? "a tool";
    if (!asksFirst(title)) return "once";
    return new Promise((resolve) => {
      this.pending = {
        title,
        decide: (allowed) => {
          this.pending = null;
          resolve(allowed ? "once" : "reject");
        },
      };
    });
  }

  /** Harness, model and effort are fixed per session: a change starts a new one. */
  private async changeSettings(settings: AssistantSettings): Promise<void> {
    this.settings = settings;
    saveSettings(this.storage, settings);
    if (!this.session && !this.resumeId) return;
    await this.stop();
    await this.closeSession();
    this.resumeId = null;
    this.note("Settings changed: the next message starts a new conversation.");
  }

  private async loadModels(harness: HarnessId): Promise<void> {
    if (!this.client || this.models[harness]) return;
    try {
      this.models = { ...this.models, [harness]: await this.client.listModels(harness) };
    } catch {
      // No list is fine: the harness's default model still works.
      this.models = { ...this.models, [harness]: [] };
    }
  }

  /** Stops routing this session here; the harness keeps it for a later resume. */
  private async closeSession(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.close().catch(() => {});
  }

  private note(text: string): void {
    this.items = [...this.items, { kind: "note", text, tone: "muted" }];
  }

  private fail(message: string): void {
    this.status = "unavailable";
    this.error = message;
  }
}
