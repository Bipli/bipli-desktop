// Bridge for the incoming-call popup. Deliberately tiny: the popup is a local
// page with no network access and no knowledge of Bipli beyond what main sends.
const { ipcRenderer, contextBridge } = require("electron");

contextBridge.exposeInMainWorld("ring", {
  onCall: (cb) => ipcRenderer.on("ring:call", (_e, d) => cb(d)),
  respond: (action) => ipcRenderer.send("ring:respond", { action }),
});
