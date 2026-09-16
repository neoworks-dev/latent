const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("probe", {
  report: (report) => ipcRenderer.send("probe:report", report),
  log: (line) => ipcRenderer.send("probe:log", line),
});
