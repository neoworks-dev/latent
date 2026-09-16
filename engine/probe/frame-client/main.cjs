// Bare Electron window for PROMPT.md section 8, step 3. Loads index.html, which
// connects to probe_frame, drives 100 slider ticks, draws every frame to a canvas and
// reports latency. This file only opens the window, forwards the report to stdout,
// captures a screenshot, and quits. Not part of the app.
const { app, BrowserWindow, ipcMain } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const screenshotPath = process.env.LATENT_PROBE_SCREENSHOT ?? "/tmp/latent-frame-probe.png";

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: "#141416",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  ipcMain.on("probe:report", async (_event, report) => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    const image = await window.webContents.capturePage();
    writeFileSync(screenshotPath, image.toPNG());
    process.stdout.write(`screenshot ${screenshotPath}\n`);
    app.exit(report.ok ? 0 : 1);
  });

  ipcMain.on("probe:log", (_event, line) => process.stdout.write(`${line}\n`));

  void window.loadFile(join(__dirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
