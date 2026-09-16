// Owns the latentd child process. The engine announces its WebSocket endpoint on stdout
// as `listening on ws://127.0.0.1:<port>`; everything after that line is forwarded as
// log output. Stopping sends SIGTERM and gives it a moment before SIGKILL.
import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const listenPattern = /listening on (ws:\/\/127\.0\.0\.1:\d+)/;

export class EngineProcess {
  private child: ChildProcess | null = null;
  private endpointUrl: string | null = null;

  constructor(private readonly executable: string) {}

  endpoint(): string | null {
    return this.endpointUrl;
  }

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ["--port", "0"], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      this.child = child;
      const decoder = new StringDecoder("utf8");
      let buffered = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buffered += decoder.write(chunk);
        const match = listenPattern.exec(buffered);
        if (match && !this.endpointUrl) {
          this.endpointUrl = match[1] ?? null;
          resolve(this.endpointUrl ?? "");
        }
        process.stdout.write(`[latentd] ${chunk.toString()}`);
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        this.child = null;
        if (!this.endpointUrl)
          reject(new Error(`latentd exited before listening (code ${code}, signal ${signal})`));
        this.endpointUrl = null;
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
