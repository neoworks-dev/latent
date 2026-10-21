// Finds the neo suite daemon (neoworks-dev/harness) the Assistant's agent runs in, and starts it
// with `suite up` when it isn't running. The renderer connects to it itself; main only hands over
// the address, because a page can't read the daemon's daemon.json.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type DaemonAddress, daemonJsonAddress } from "@neoworks-dev/neo-sdk";

const run = promisify(execFile);

// The renderer asks again on every reconnect: one `suite up` at a time.
let starting: Promise<DaemonAddress | null> | null = null;

export async function daemonAddress(): Promise<DaemonAddress | null> {
  try {
    return await daemonJsonAddress();
  } catch {
    starting ??= startDaemon().finally(() => {
      starting = null;
    });
    return starting;
  }
}

/** `LATENT_SUITE` names the `suite` binary; else it is looked up on PATH. */
async function startDaemon(): Promise<DaemonAddress | null> {
  try {
    await run(process.env.LATENT_SUITE ?? "suite", ["up"], { timeout: 30_000 });
    return await daemonJsonAddress();
  } catch (error) {
    process.stderr.write(`[suite] no daemon: ${String(error)}\n`);
    return null;
  }
}
