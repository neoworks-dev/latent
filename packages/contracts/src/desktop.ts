/**
 * The Electron preload bridge, as the renderer sees it. It carries only what a sandboxed
 * page cannot do itself — the engine and harness endpoints and the native dialogs;
 * everything else goes over those sockets. Declared here so plugins see the same shape the
 * app does.
 */
export interface LatentDesktopBridge {
  platform: string;
  engineEndpoint(): Promise<string | null>;
  /**
   * The agent harness sidecar (`neoworks-harness serve`) and the token it wants; null when
   * it failed to start or `@neoworks/harness` is not installed.
   */
  harnessEndpoint(): Promise<{ url: string; token: string } | null>;
  pickFiles(): Promise<string[]>;
  pickDirectory(): Promise<string | null>;
}

declare global {
  interface Window {
    /** Absent when the editor runs in a plain browser tab (dev without Electron). */
    latentDesktop?: LatentDesktopBridge;
  }
}
