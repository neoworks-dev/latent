/**
 * The Electron preload bridge, as the renderer sees it. It carries only what the page cannot
 * do itself — where the engine and the suite daemon are, the native dialogs and the shared-memory
 * frame slots; everything else goes over those sockets. Declared here so plugins see the same shape the
 * app does.
 */
export interface LatentDesktopBridge {
  platform: string;
  engineEndpoint(): Promise<string | null>;
  /**
   * The neo suite daemon the Assistant's agent runs in: its loopback URL and token, started
   * with `suite up` when it wasn't running. Null when there is no `suite` to start it with.
   */
  daemonAddress(): Promise<{ url: string; token: string } | null>;
  pickFiles(): Promise<string[]>;
  pickDirectory(): Promise<string | null>;
  /**
   * The first `byteLength` bytes of a view's frame slot, a path from `view.open`'s
   * `sharedMemory` (protocol/frames.md, format 3). Throws for any other path.
   */
  readSharedFrame: (path: string, byteLength: number) => Uint8Array;
}

declare global {
  interface Window {
    /** Absent when the editor runs in a plain browser tab (dev without Electron). */
    latentDesktop?: LatentDesktopBridge;
  }
}
