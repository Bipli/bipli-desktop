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

// =============================================================================
// RING DETECTION — so an incoming call is never silent, even when every
// notification path fails.
//
// 🔑 IT HOOKS THE APP'S OWN ALERT, IT DOES NOT INVENT ONE. The softphone already
// decides when to alert a human and already assembles the caller and the dialled
// line for the toast (notifications.ts). Hooking showNotification means the
// shell reacts to exactly that decision — same moment, same payload — instead of
// growing a second, parallel idea of what "ringing" means that could drift from
// the app's. Nothing in the main repo changes, which is the point: this is a
// shell, and the scope says no UI rewrite.
//
// It works even when the notification itself is refused: the call is made, we
// see it, and the OS's answer to it is irrelevant to us bringing the window
// back and flashing the taskbar. That is precisely the Windows case that failed
// the first spike run.
//
// ⚠️ THIS IS A SPIKE-GRADE SIGNAL AND SHOULD NOT SURVIVE INTO THE PRODUCT AS-IS.
// It is a monkey-patch on a browser API: it breaks the day notifications.ts
// changes shape, silently, with the failure being "the phone stopped surfacing"
// — the worst possible failure mode to have depend on a patch. The durable
// version is one explicit line from the web app (postMessage, or a
// window.bipliDesktop call the shell exposes). Ship that before this ships.
// =============================================================================

function reportRing(via, title, body) {
  try {
    ipcRenderer.send("spike:ring", { via, title, body });
  } catch {}
}

// (a) Service-worker notifications — the path the app actually uses, and the
//     only one that can carry Answer/Decline actions.
if (typeof ServiceWorkerRegistration !== "undefined" && ServiceWorkerRegistration.prototype.showNotification) {
  const orig = ServiceWorkerRegistration.prototype.showNotification;
  ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
    reportRing("sw.showNotification", title, options && options.body);
    return orig.apply(this, arguments);
  };
}

// (b) Page-level `new Notification(...)`, in case any path still uses it. Both
//     are hooked because a missed ring is worse than a duplicate log line, and
//     the main process de-duplicates by state anyway.
if (typeof window.Notification === "function") {
  const OrigNotification = window.Notification;
  const Wrapped = function (title, options) {
    reportRing("new Notification", title, options && options.body);
    return new OrigNotification(title, options);
  };
  Wrapped.prototype = OrigNotification.prototype;
  Object.defineProperty(Wrapped, "permission", { get: () => OrigNotification.permission });
  Wrapped.requestPermission = (...a) => OrigNotification.requestPermission(...a);
  window.Notification = Wrapped;
}

// Ring end / answered. The softphone puts the call state in the document title
// ("On a call", "Incoming call…"), which is a weak signal — hence spike-grade.
// Watching it is enough to prove the tray state machine works; the durable
// version gets an explicit event.
const titleEl = document.querySelector("title");
if (titleEl) {
  new MutationObserver(() => {
    const t = (document.title || "").toLowerCase();
    if (t.includes("on a call") || t.includes("in call")) {
      ipcRenderer.send("spike:ring-ended", { via: "title", answered: true });
    } else if (!t.includes("incoming")) {
      ipcRenderer.send("spike:call-ended", {});
    }
  }).observe(titleEl, { childList: true });
}
