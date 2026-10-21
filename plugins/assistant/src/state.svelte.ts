import type { EngineClient, ViewerService } from "@latent/contracts";
import type { JobProgressParams } from "@latent/protocol";
import {
  assetUrl,
  connect,
  type Client,
  type DaemonAddress,
  type Unsubscribe,
} from "@neoworks-dev/neo-sdk";
import {
  agentJobLabel,
  applyEvent,
  buildPrompt,
  jobOutcome,
  jobsFinishedPrompt,
  loadConversation,
  loadPlacement,
  PLACEMENT_KEY,
  saveConversation,
  type ConfigOption,
  type HarnessSettings,
  type PermissionRequest,
  type SessionEvent,
  type Target,
  type TranscriptItem,
} from "./assistant";
import { MAX_REFERENCES, readReference, type Reference } from "./references";

/** Where the daemon is, asked again on every reconnect; null when there is none to reach. */
export type DaemonAddressSource = () => Promise<DaemonAddress | null>;

/** A question the daemon asks before an agent's call, answered with one of its options. */
export interface PendingApproval {
  id: string;
  title: string;
  options: PermissionRequest["options"];
}

/** Typed into the chat, it starts a new conversation instead of being sent. */
export const CLEAR_COMMAND = "/clear";

/** Latent's name in the daemon; the agent reaches its tools through the engine's MCP server. */
const APP = "latent";

/**
 * The selection chat. The agent runs in the neo suite daemon, one session per photo, and acts on
 * the photo through the engine's MCP server, so its edits reach the stack like any other writer's
 * and this holds no edit state: only which session is the photo's, and the transcript built from
 * its events, kept across closing the chat and across restarts in localStorage.
 */
export class AssistantState {
  status = $state<"connecting" | "ready" | "unavailable">("connecting");
  /** Why the assistant is unavailable, or why the last turn failed. */
  error = $state<string | null>(null);
  /** What the photo's session can run on, with the current choices; empty until it has one. */
  harnesses = $state<HarnessSettings[]>([]);
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

  private client: Client | null = null;
  /** The latest address, for the URLs of images the agent's tools returned. */
  private address: DaemonAddress | null = null;
  private disposed = false;
  /** Plain fields: `showPhoto` runs from an effect and must not read state it writes. */
  private conversationPhoto: number | null = null;
  private photoFile: { path: string; filename: string } | null = null;
  private sessionId: string | null = null;
  /** The session being started: opening the chat and sending right away must not start two. */
  private starting: Promise<string> | null = null;
  /** The last event of the session the transcript has folded in. */
  private seq = 0;
  private unsubscribeSession: Unsubscribe | null = null;
  /** The last undo step a tool's changes were read up to. */
  private historyIndex = 0;
  /** Where the history stood when this chat's turn started; null for a turn from elsewhere. */
  private turnStart: number | null = null;
  /** The agent's jobs still running, by jobId, and how the finished ones went. */
  private activeJobs: number[] = [];
  private jobOutcomes: string[] = [];
  private readonly unsubscribeJobs: () => void;

  constructor(
    private readonly engine: EngineClient,
    private readonly viewer: ViewerService,
    private readonly storage: Pick<Storage, "getItem" | "setItem">,
  ) {
    this.placement = loadPlacement(storage);
    this.unsubscribeJobs = engine.on("job.progress", (params) => this.onJob(params));
  }

  /** A drag dropped the chat here; null puts it back next to the selection. */
  place(position: { left: number; top: number } | null): void {
    this.placement = position;
    this.storage.setItem(PLACEMENT_KEY, JSON.stringify(position));
  }

  /** The harness the session runs on now. */
  get harness(): HarnessSettings | undefined {
    return this.harnesses.find((harness) => harness.current);
  }

  /** One of the settings the session's harness offers: its models, efforts or modes. */
  option(category: ConfigOption["category"]): ConfigOption | undefined {
    return this.harness?.options.find((option) => option.category === category);
  }

  async connect(addressOf: DaemonAddressSource): Promise<void> {
    try {
      await this.engine.whenOpen();
      const hello = await this.engine.call("engine.hello", { client: "assistant" });
      if (!hello.mcpUrl) {
        this.fail("The engine runs without its MCP server (--no-mcp), so an agent cannot edit.");
        return;
      }
      const first = await addressOf();
      if (!first) {
        this.fail("No neo daemon: install neo so `suite` is on PATH, or set LATENT_SUITE.");
        return;
      }
      this.address = first;
      const client = await connect({
        client: APP,
        address: async () => {
          const next = await addressOf();
          if (!next) throw new Error("the neo daemon is gone");
          this.address = next;
          return next;
        },
        presence: {
          app: APP,
          kind: "app",
          title: "Latent",
          description: "Latent, a raw photo editor: edits are an op-stack per photo, with undo.",
          open: true,
          mcp: { url: hello.mcpUrl },
        },
      });
      if (this.disposed) {
        await client.close();
        return;
      }
      this.client = client;
      this.status = "ready";
      // A photo opened while connecting: its session can be followed now.
      if (this.photoFile) await client.setContext({ photo: this.photoFile.path });
      if (this.sessionId) this.follow(this.sessionId);
    } catch (error) {
      this.fail(`The neo daemon is unreachable: ${String(error)}`);
    }
  }

  /** The chat follows the open photo: each photo has its own session. */
  async showPhoto(photoId: number | null): Promise<void> {
    if (photoId === this.conversationPhoto) return;
    await this.stop();
    this.leaveSession();
    this.conversationPhoto = photoId;
    this.photoFile = null;
    const stored = photoId === null ? null : loadConversation(this.storage, photoId);
    this.items = stored?.items ?? [];
    this.costUsd = stored?.costUsd ?? null;
    this.sessionId = stored?.sessionId ?? null;
    this.seq = stored?.seq ?? 0;
    this.harnesses = [];
    this.target = null;
    this.references = [];
    this.error = null;
    if (photoId === null) return;
    try {
      const photo = await this.engine.call("catalog.get", { photoId });
      if (photoId !== this.conversationPhoto) return;
      this.photoFile = { path: photo.path, filename: photo.filename };
      await this.client?.setContext({ photo: photo.path });
    } catch {
      // A photo the catalog doesn't know gets a session without a title or folder.
    }
    if (this.sessionId) this.follow(this.sessionId);
  }

  /** Point the chat at a box or the whole photo. The conversation carries on. */
  select(target: Target): void {
    // The chat is about the open photo: without one there is nothing to send to.
    if (this.viewer.photoId === null) return;
    this.target = target;
    // Opening the chat starts the photo's session, so the pickers have something to show.
    this.ensureSession().catch((error: unknown) => {
      this.error = String(error);
    });
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

  /** `/clear`: the next message starts a new session, and the stored conversation is forgotten. */
  async clear(): Promise<void> {
    await this.stop();
    this.leaveSession();
    this.sessionId = null;
    this.seq = 0;
    this.items = [];
    this.costUsd = null;
    this.error = null;
    this.harnesses = [];
    if (this.conversationPhoto !== null)
      saveConversation(this.storage, this.conversationPhoto, null);
  }

  /** Switches the session's harness; the daemon keeps the choice as the default for new ones. */
  async setHarness(name: string): Promise<void> {
    await this.command(`/harness ${name}`);
  }

  async setModel(value: string): Promise<void> {
    const harness = this.harness;
    if (harness) await this.command(`/model ${harness.name} ${value}`);
  }

  async setEffort(value: string): Promise<void> {
    const harness = this.harness;
    if (harness) await this.command(`/effort ${harness.name} ${value}`);
  }

  /** Answers the question on screen with one of its options. */
  async decide(option: string): Promise<void> {
    const client = this.client;
    const session = this.sessionId;
    const pending = this.pending;
    this.pending = null;
    if (!client || !session || !pending) return;
    try {
      await client.action(session, pending.id, "suite.permit", { id: pending.id, option });
    } catch (error) {
      this.error = `Could not answer: ${String(error)}`;
    }
  }

  async send(instruction: string): Promise<void> {
    if (instruction.trim() === CLEAR_COMMAND) {
      await this.clear();
      return;
    }
    const photoId = this.viewer.photoId;
    const target = this.target;
    if (!this.client || photoId === null || !target || this.running || !instruction.trim()) return;
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
    await this.turn(
      photoId,
      buildPrompt(instruction, photoId, target, references.length),
      references,
    );
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
    const photoId = this.conversationPhoto;
    if (!this.waiting || this.running || this.activeJobs.length > 0) return;
    this.waiting = false;
    const outcomes = this.jobOutcomes;
    this.jobOutcomes = [];
    if (photoId === null || photoId !== this.viewer.photoId) return;
    this.note(`${outcomes.join(", ")} — continuing.`);
    await this.turn(photoId, jobsFinishedPrompt(outcomes), []);
  }

  /** Sends one message; the turn ends with the session's `turn_ended` (see `onEvent`). */
  private async turn(photoId: number, text: string, references: Reference[]): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.error = null;
    this.running = true;
    this.waiting = false;
    this.jobOutcomes = [];
    try {
      const session = await this.ensureSession();
      this.historyIndex = (await this.engine.call("history.list", { photoId })).index;
      this.turnStart = this.historyIndex;
      // The daemon takes images as files: its asset store keeps them.
      const stored = await Promise.all(
        references.map((reference, at) =>
          client.putAsset({
            data: reference.data,
            mime: reference.mimeType,
            name: `reference-${at + 1}`,
          }),
        ),
      );
      await client.input(session, text, { app: APP, images: stored.map((asset) => asset.path) });
    } catch (error) {
      this.error = String(error);
      this.running = false;
      this.turnStart = null;
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
    // Stopping also means not being woken by a job the stopped turn started.
    this.waiting = false;
    this.activeJobs = [];
    this.jobOutcomes = [];
    if (this.client && this.sessionId && this.running) await this.client.cancel(this.sessionId);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeJobs();
    void this.stop().then(() => {
      this.leaveSession();
      return this.client?.close();
    });
  }

  /** The photo's session, started when it has none: named after the photo, in its folder. */
  private ensureSession(): Promise<string> {
    if (this.sessionId) return Promise.resolve(this.sessionId);
    this.starting ??= this.startSession().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startSession(): Promise<string> {
    const client = this.client;
    if (!client) throw new Error("not connected to the neo daemon");
    const file = this.photoFile;
    const params: { title?: string; cwd?: string } = {};
    if (file) {
      params.title = file.filename;
      params.cwd = file.path.slice(0, file.path.lastIndexOf("/")) || "/";
    }
    const session = await client.createSession(params);
    this.sessionId = session.id;
    this.seq = 0;
    this.follow(session.id);
    return session.id;
  }

  /** Folds the session's events in from the last one seen, then follows it live. */
  private follow(session: string): void {
    const client = this.client;
    if (!client || this.unsubscribeSession) return;
    this.unsubscribeSession = client.subscribe(session, {
      fromSeq: this.seq + 1,
      onEvent: (event, record) => {
        this.seq = record.seq;
        this.onEvent(event);
      },
      onLive: () => void this.loadSettings(),
      onError: () => {
        // The daemon no longer has it (another data dir): the next message starts a new one.
        this.leaveSession();
        this.sessionId = null;
        this.seq = 0;
        this.note("The earlier conversation is gone: the next message starts a new one.");
      },
    });
  }

  private leaveSession(): void {
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.pending = null;
    this.running = false;
    this.turnStart = null;
  }

  private onEvent(event: SessionEvent): void {
    const photoId = this.conversationPhoto;
    if (event.type === "user_message") {
      // This chat shows its own messages as typed; one from another pane starts a turn here too.
      if (event.app === APP) return;
      this.running = true;
      this.items = [...this.items, { kind: "user", text: event.shown ?? event.text }];
      return;
    }
    if (event.type === "permission_request") {
      this.pending = { id: event.id, title: event.title, options: event.options };
      return;
    }
    if (event.type === "permission_resolved") {
      // Answered here, in another pane, or dropped by a cancel.
      if (this.pending?.id === event.id) this.pending = null;
      return;
    }
    if (event.type === "usage") {
      if (event.agent === undefined && event.cost !== undefined) this.costUsd = event.cost;
      return;
    }
    if (event.type === "setting_changed") {
      void this.loadSettings();
      return;
    }
    if (event.type === "notice") {
      this.note(event.text, event.tone === "danger" ? "error" : "muted");
      return;
    }
    if (event.type === "turn_ended") {
      if (photoId !== null) void this.endTurn(photoId, event);
      return;
    }
    const address = this.address;
    this.items = applyEvent(this.items, event, (src) =>
      address && src.startsWith("asset://") ? (assetUrl(address, src) ?? undefined) : undefined,
    );
    if (event.type !== "tool_call_update" || photoId === null) return;
    if (event.status === "completed" || event.status === "failed")
      void this.attachSteps(photoId, event.toolCallId);
  }

  private async endTurn(
    photoId: number,
    event: Extract<SessionEvent, { type: "turn_ended" }>,
  ): Promise<void> {
    this.running = false;
    this.pending = null;
    if (event.stopReason === "cancelled") this.note("Stopped.");
    if (event.error) this.error = event.error;
    const turnStart = this.turnStart;
    this.turnStart = null;
    if (turnStart !== null) await this.summarize(photoId, turnStart);
    this.persist(photoId);
    // The agent ended its turn on a job it started: it is woken when the job is done —
    // or at once, if the job finished while it was still talking.
    if (this.activeJobs.length > 0 || this.jobOutcomes.length > 0) {
      this.waiting = true;
      void this.wake();
    }
  }

  /** A finished tool call gets the undo steps it made. */
  private async attachSteps(photoId: number, toolCallId: string): Promise<void> {
    const listed = await this.engine.call("history.list", { photoId });
    const steps = listed.entries.filter(
      (step) => step.index > this.historyIndex && step.index <= listed.index,
    );
    this.historyIndex = listed.index;
    if (steps.length === 0) return;
    this.items = this.items.map((item) => {
      if (item.kind !== "tool" || item.id !== toolCallId) return item;
      return { ...item, steps };
    });
  }

  private persist(photoId: number): void {
    const session = this.sessionId;
    if (!session || photoId !== this.conversationPhoto) return;
    saveConversation(this.storage, photoId, {
      sessionId: session,
      seq: this.seq,
      items: this.items,
      costUsd: this.costUsd,
    });
  }

  /** A `/harness`, `/model` or `/effort` for the photo's session; the daemon logs the change. */
  private async command(text: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const session = await this.ensureSession();
      await client.input(session, text, { app: APP });
    } catch (error) {
      this.error = String(error);
    }
  }

  private async loadSettings(): Promise<void> {
    const client = this.client;
    const session = this.sessionId;
    if (!client || !session) return;
    try {
      // `known`: never start a guest's adapter just to fill the pickers.
      const settings = await client.sessionSettings(session, true);
      if (session === this.sessionId) this.harnesses = settings.harnesses;
    } catch {
      // No list is fine: the harness's defaults still work.
    }
  }

  private note(text: string, tone: "muted" | "error" = "muted"): void {
    this.items = [...this.items, { kind: "note", text, tone }];
  }

  private fail(message: string): void {
    this.status = "unavailable";
    this.error = message;
  }
}
