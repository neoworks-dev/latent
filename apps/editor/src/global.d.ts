interface LatentDesktopBridge {
  platform: string;
  engineEndpoint(): Promise<string | null>;
  pickFiles(): Promise<string[]>;
}

declare global {
  interface Window {
    /** Absent when the editor runs in a plain browser tab (dev without Electron). */
    latentDesktop?: LatentDesktopBridge;
  }
}

export {};
