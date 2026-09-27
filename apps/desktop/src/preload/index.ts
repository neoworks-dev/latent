import { contextBridge, ipcRenderer } from "electron";

// The renderer talks to the engine and the harness sidecar directly over their WebSockets;
// the bridge only carries what a sandboxed page cannot do itself: learn the endpoints and
// open native dialogs.
contextBridge.exposeInMainWorld("latentDesktop", {
  platform: process.platform,
  engineEndpoint: (): Promise<string | null> => ipcRenderer.invoke("engine:endpoint"),
  harnessEndpoint: (): Promise<{ url: string; token: string } | null> =>
    ipcRenderer.invoke("harness:endpoint"),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke("dialog:pickFiles"),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickDirectory"),
});
