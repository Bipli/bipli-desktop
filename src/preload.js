// =============================================================================
// SPIKE PROBE — measures the one thing that decides whether this product works.
//
// 🔑 THE QUESTION IS NOT "does Electron run the app". It is "do the softphone's
// TIMERS still run when the window is hidden". Presence in the web app is a
// ~30s heartbeat plus a 60s watchdog; both are setInterval. Chromium throttles
// background timers to ~1/minute and can freeze them entirely, which is how the
// browser version loses its registration. If Electron throttles a hidden window
// the same way, a tray app changes nothing and we should know that in an hour
// rather than after building a product on it.
//
// ⚠️ THE PROBE MEASURES, IT DOES NOT PARTICIPATE. It never posts a heartbeat and
// never touches the Device. A probe that kept presence alive by itself would
// hide the very failure it exists to detect — and would be the "we used X
// because Y was hard" tell the spike doctrine warns about.
// =============================================================================

const { ipcRenderer } = require("electron");

const INTERVAL_MS = 30_000; // deliberately the softphone's own heartbeat period
let last = Date.now();
let hiddenSince = null;

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") hiddenSince = Date.now();
  else hiddenSince = null;
  console.log(`[spike-probe] visibility → ${document.visibilityState}`);
});

setInterval(() => {
  const now = Date.now();
  ipcRenderer.send("spike:drift", {
    expectedMs: INTERVAL_MS,
    actualMs: now - last,
    visibility: document.visibilityState,
    hiddenForS: hiddenSince ? Math.round((now - hiddenSince) / 1000) : 0,
  });
  last = now;
}, INTERVAL_MS);

// Report what the media stack can actually see. Device LABELS are the tell: an
// empty label means permission was not really granted, which is what breaks the
// input/output selectors even when audio itself works.
window.addEventListener("load", async () => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audio = devices.filter((d) => d.kind === "audioinput" || d.kind === "audiooutput");
    const labelled = audio.filter((d) => d.label && d.label.length > 0).length;
    console.log(
      `[spike-probe] audio devices=${audio.length} labelled=${labelled}` +
        (labelled === 0 && audio.length > 0 ? "  🔴 LABELS EMPTY — selectors will be blank" : ""),
    );
    const el = document.createElement("audio");
    console.log(`[spike-probe] setSinkId supported=${typeof el.setSinkId === "function"}`);
    console.log(`[spike-probe] Notification.permission=${Notification.permission}`);
    console.log(`[spike-probe] serviceWorker supported=${"serviceWorker" in navigator}`);
  } catch (e) {
    console.log(`[spike-probe] enumerate failed: ${e && e.message}`);
  }
});
