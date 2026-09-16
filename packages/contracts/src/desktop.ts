/**
 * The Electron preload bridge, as the renderer sees it. It carries only what a sandboxed
 * page cannot do itself — the engine endpoint and the native dialogs; everything else goes
 * over the engine socket. Declared here so plugins see the same shape the app does.
 */
export interface LatentDesktopBridge {
  platform: string;
  engineEndpoint(): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  pickDirectory(): Promise<string | null>;
}

declare global {
  interface Window {
    /** Absent when the editor runs in a plain browser tab (dev without Electron). */
    latentDesktop?: LatentDesktopBridge;
  }
}
