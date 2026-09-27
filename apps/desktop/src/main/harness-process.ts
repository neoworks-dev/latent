// Owns the agent harness sidecar (`neoworks-harness serve` from `@neoworks/harness`): the
// process that runs Claude Code, Codex or pi for the Assistant. Same shape as EngineProcess —
// it announces `listening on ws://127.0.0.1:<port>` on stdout — plus a random token, since
// any page in any browser can open a socket to localhost. The renderer gets both through
// the preload bridge; the token never shows up in `ps`, it travels in the environment.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const listenPattern = /listening on (ws:\/\/127\.0\.0\.1:\d+)/;

export interface HarnessEndpoint {
  url: string;
  token: string;
}

/** The sidecar's CLI: `LATENT_HARNESS`, else the built `@neoworks/harness` beside this app. */
export function resolveHarnessCli(): string | null {
  if (process.env.LATENT_HARNESS) return process.env.LATENT_HARNESS;
  try {
    const manifest = createRequire(import.meta.url).resolve("@neoworks/harness/package.json");
    const cli = join(dirname(manifest), "dist", "cli", "index.js");
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

export class HarnessProcess {
  private child: ChildProcess | null = null;
  private current: HarnessEndpoint | null = null;
  private readonly token = randomBytes(24).toString("base64url");

  constructor(private readonly cli: string) {}

  endpoint(): HarnessEndpoint | null {
    return this.current;
  }

  start(): Promise<HarnessEndpoint> {
    return new Promise((resolve, reject) => {
      // Electron's own binary is the Node that runs it; the sidecar starts the harness
      // adapters the same way.
      const child = spawn(process.execPath, [this.cli, "serve"], {
        cwd: homedir(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NEOWORKS_HARNESS_TOKEN: this.token },
        stdio: ["ignore", "pipe", "inherit"],
      });
      this.child = child;
      const decoder = new StringDecoder("utf8");
      let buffered = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buffered += decoder.write(chunk);
        const match = listenPattern.exec(buffered);
        if (match?.[1] && !this.current) {
          this.current = { url: match[1], token: this.token };
          resolve(this.current);
        }
        process.stdout.write(`[harness] ${chunk.toString()}`);
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        this.child = null;
        if (!this.current)
          reject(
            new Error(`harness sidecar exited before listening (code ${code}, signal ${signal})`),
          );
        this.current = null;
      });
    });
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2000).unref();
  }
}
