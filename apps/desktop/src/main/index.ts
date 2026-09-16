// Electron main. Does two things and nothing else: spawns latentd and opens the one
// window. State, pixels, scripting, MCP all live in the engine (PROMPT.md §4.1).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { EngineProcess } from "./engine-process";

const developmentUrl = process.env.LATENT_EDITOR_URL;
const editorBuildDir = join(import.meta.dirname, "../../../editor/dist");

function resolveEngineExecutable(): string {
  if (process.env.LATENT_ENGINE) return process.env.LATENT_ENGINE;
  const candidates = [
    join(import.meta.dirname, "../../../../engine/build/dev/latentd"),
    join(process.resourcesPath ?? "", "latentd"),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(`latentd not found; set LATENT_ENGINE. Tried: ${candidates.join(", ")}`);
}

// LATENT_ENGINE_URL attaches to an engine that is already running — a `latentd` in a
// terminal, or `bun run mock-engine` — instead of spawning one. LATENT_ENGINE picks a
// different `latentd` binary to spawn.
const externalEngineUrl = process.env.LATENT_ENGINE_URL;
const engine = externalEngineUrl ? null : new EngineProcess(resolveEngineExecutable());

ipcMain.handle("engine:endpoint", () => {
  if (externalEngineUrl) return externalEngineUrl;
  return engine?.endpoint();
});
ipcMain.handle("dialog:pickFiles", async (event): Promise<string[]> => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    title: "Open photos",
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Raw photos",
        extensions: ["raf", "nef", "arw", "cr2", "cr3", "dng", "orf", "rw2", "pef"],
      },
    ],
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return [];
  return result.filePaths;
});

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#141416",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  if (developmentUrl) void window.loadURL(developmentUrl);
  else void window.loadFile(join(editorBuildDir, "index.html"));
}

void app.whenReady().then(async () => {
  await engine?.start();
  createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => engine?.stop());
