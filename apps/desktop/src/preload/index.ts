import { contextBridge, ipcRenderer } from "electron";

// The renderer talks to the engine directly over its WebSocket; the bridge only carries
// what a sandboxed page cannot do itself: learn the endpoint and open native dialogs.
contextBridge.exposeInMainWorld("latentDesktop", {
  platform: process.platform,
  engineEndpoint: (): Promise<string | null> => ipcRenderer.invoke("engine:endpoint"),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke("dialog:pickFiles"),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickDirectory"),
});
