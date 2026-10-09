import { closeSync, openSync, readSync } from "node:fs";
import { contextBridge, ipcRenderer } from "electron";

// The engine's frame slots and nothing else (protocol/frames.md, format 3): the page asks
// for a path the engine named, and this is the only file the preload will open for it.
const sharedFramePath = /^\/dev\/shm\/latent-\d+-view-\d+-[01]$/;

function readSharedFrame(path: string, byteLength: number): Uint8Array {
  if (!sharedFramePath.test(path)) throw new Error(`not an engine frame slot: ${path}`);
  const pixels = new Uint8Array(byteLength);
  const descriptor = openSync(path, "r");
  try {
    let read = 0;
    while (read < byteLength) {
      const chunk = readSync(descriptor, pixels, read, byteLength - read, read);
      if (chunk === 0) throw new Error(`frame slot ${path} ends at ${read} of ${byteLength} bytes`);
      read += chunk;
    }
  } finally {
    closeSync(descriptor);
  }
  return pixels;
}

// The renderer talks to the engine and the harness sidecar directly over their WebSockets;
// the bridge carries what the page cannot do itself: learn the endpoints, open native
// dialogs, and read frame pixels the engine put in shared memory instead of on the socket.
contextBridge.exposeInMainWorld("latentDesktop", {
  platform: process.platform,
  engineEndpoint: (): Promise<string | null> => ipcRenderer.invoke("engine:endpoint"),
  harnessEndpoint: (): Promise<{ url: string; token: string } | null> =>
    ipcRenderer.invoke("harness:endpoint"),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke("dialog:pickFiles"),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickDirectory"),
  readSharedFrame,
});
