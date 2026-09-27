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
} from "@neoworks/harness/client";
import {
  applyUpdate,
  asksFirst,
  buildPrompt,
  loadSettings,
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

/**
 * The selection chat. The agent runs in a harness sidecar and acts on the photo through
 * the engine's MCP server, so its edits reach the stack like any other writer's and this
 * holds no edit state — only the conversation.
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

  private client: HarnessClient | null = null;
  private session: HarnessSession | null = null;
  private run: PromptRun | null = null;
  private mcpUrl: string | null = null;
  private disposed = false;

  constructor(
    private readonly engine: EngineClient,
    private readonly viewer: ViewerService,
    private readonly storage: Pick<Storage, "getItem" | "setItem">,
  ) {
    this.settings = $state(loadSettings(storage));
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

  /** Close the chat. The layer the agent made stays; the conversation goes. */
  async closeChat(): Promise<void> {
    await this.stop();
    await this.endSession();
    this.target = null;
    this.references = [];
    this.items = [];
    this.costUsd = null;
    this.error = null;
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
    const client = this.client;
    const photoId = this.viewer.photoId;
    const target = this.target;
    if (!client || photoId === null || !target || this.running || !instruction.trim()) return;
    const references = this.references;
    this.error = null;
    this.running = true;
    this.references = [];
    this.items = [
      ...this.items,
      {
        kind: "user",
        text: instruction.trim(),
        images: references.map((reference) => reference.url),
      },
    ];
    try {
      this.session ??= await this.startSession(client);
      this.run = this.session.prompt([
        { type: "text", text: buildPrompt(instruction, photoId, target, references.length) },
        ...references.map((reference) => ({
          type: "image" as const,
          data: reference.data,
          mimeType: reference.mimeType,
        })),
      ]);
      for await (const event of this.run) {
        if (event.type === "update") this.items = applyUpdate(this.items, event.update);
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
    }
  }

  async stop(): Promise<void> {
    this.pending?.decide(false);
    if (this.session && this.running) await this.session.cancel();
  }

  dispose(): void {
    this.disposed = true;
    void this.closeChat().then(() => this.client?.close());
  }

  private async startSession(client: HarnessClient): Promise<HarnessSession> {
    const { harness, model, effort } = this.settings;
    return client.createSession({
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
    if (!this.session) return;
    await this.stop();
    await this.endSession();
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

  private async endSession(): Promise<void> {
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
