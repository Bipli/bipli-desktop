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

// =============================================================================
// (b) DEVICE LABELS AND THE MISSING "default" SINK — round 2's other blocker.
//
// Reported: labels empty even though `permission media → GRANT`, and
// `speakerDevices.set failed: Devices not found: default`.
//
// 🔑 THE APP ALREADY DIAGNOSED THIS, IN A BROWSER. useTwilioDevice.tsx:620:
//   "Mic permission must be granted before constructing the Device. Without it,
//    Chrome's enumerateDevices() hides the synthetic 'default' deviceId, and the
//    SDK's AudioHelper fails to bind an output sink."
// That is the reported symptom exactly — empty labels AND a missing "default".
// So this is not an Electron mystery: it is the known no-grant-yet state. The
// app guards it by calling getUserMedia inside ensureDevice, but its device
// ENUMERATION runs on its own schedule, and under Electron the handler-granted
// permission does not appear to carry the same weight as a browser's persisted
// user grant.
//
// ⚠️ SO THE SHELL WARMS THE GRANT, AND THAT IS A LEGITIMATE SHELL JOB — "the
// shell guarantees the page stays alive and audible". One getUserMedia at load,
// released immediately, before the app enumerates.
//
// ⚠️ AND IT MEASURES BEFORE AND AFTER, because if warming does NOT populate the
// labels then the cause is something else entirely and we must not go on
// believing we fixed it. The two inventories are the evidence either way.
// =============================================================================
async function inventory(when) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audio = devices.filter((d) => d.kind === "audioinput" || d.kind === "audiooutput");
    const labelled = audio.filter((d) => d.label).length;
    const outputs = audio.filter((d) => d.kind === "audiooutput");
    const hasDefaultSink = outputs.some((d) => d.deviceId === "default");
    ipcRenderer.send("spike:devices", {
      when,
      summary:
        `${audio.length} audio (${outputs.length} out), labelled=${labelled}` +
        `, "default" sink ${hasDefaultSink ? "PRESENT" : "🔴 ABSENT — speakerDevices.set(\"default\") will throw"}`,
      list: audio.map((d) => `${d.kind} id=${d.deviceId.slice(0, 24)} label=${d.label || "<EMPTY>"}`),
    });
    return { labelled, hasDefaultSink, outputs };
  } catch (e) {
    ipcRenderer.send("spike:devices", { when, summary: `enumerate failed: ${e && e.message}`, list: [] });
    return null;
  }
}

window.addEventListener("load", async () => {
  const before = await inventory("before mic grant");
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    console.log("[spike-probe] getUserMedia OK — grant warmed");
  } catch (e) {
    console.log(`[spike-probe] 🔴 getUserMedia FAILED: ${e && e.name}: ${e && e.message}`);
  } finally {
    // Release immediately. The SDK opens its own stream inside connect();
    // holding this one would pin the mic and light the OS in-use indicator for
    // the whole session.
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }
  const after = await inventory("after mic grant");

  // Prove which sink id actually binds, rather than assuming "default" does.
  const el = document.createElement("audio");
  if (typeof el.setSinkId === "function" && after) {
    for (const id of ["default", ...(after.outputs[0] ? [after.outputs[0].deviceId] : [])]) {
      try {
        await el.setSinkId(id);
        console.log(`[spike-probe] setSinkId("${id.slice(0, 20)}") OK`);
      } catch (e) {
        console.log(`[spike-probe] setSinkId("${id.slice(0, 20)}") FAILED: ${e && e.message}`);
      }
    }
  } else {
    console.log("[spike-probe] setSinkId unsupported");
  }
  console.log(`[spike-probe] Notification.permission=${Notification.permission} (popup path does not need it)`);
});

function reportRing(via, title, options) {
  try {
    // The app tags its incoming-call notification with the callSid (data.callSid,
    // falling back to the tag). Carrying it through means the popup's Answer
    // names the SAME call the app is ringing about, rather than "whatever is
    // ringing" — which matters the moment a second call arrives.
    const d = (options && options.data) || {};
    ipcRenderer.send("spike:ring", {
      via,
      title,
      body: options && options.body,
      callSid: d.callSid || (options && options.tag) || null,
    });
  } catch {}
}

// (a) Service-worker notifications — the path the app actually uses, and the
//     only one that can carry Answer/Decline actions.
if (typeof ServiceWorkerRegistration !== "undefined" && ServiceWorkerRegistration.prototype.showNotification) {
  const orig = ServiceWorkerRegistration.prototype.showNotification;
  ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
    reportRing("sw.showNotification", title, options);
    return orig.apply(this, arguments);
  };
}

// (b) Page-level `new Notification(...)`, in case any path still uses it. Both
//     are hooked because a missed ring is worse than a duplicate log line, and
//     the main process de-duplicates by state anyway.
if (typeof window.Notification === "function") {
  const OrigNotification = window.Notification;
  const Wrapped = function (title, options) {
    reportRing("new Notification", title, options);
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

// =============================================================================
// POPUP → APP. Answer / Decline from our own window, delivered on the contract
// the app ALREADY has.
//
// 🔑 notifications.ts exports onNotificationAction(), which listens for
// `{ type: "notification-action", callSid, action }` posted on the service-worker
// message channel — the path a toast's action buttons take. Replaying that exact
// message means the popup answers a call through the app's own wired handler,
// not through a second mechanism that could drift from it. Nothing in the main
// repo changes.
//
// ⚠️ SAME SPIKE-GRADE CAVEAT AS THE RING HOOK, and for the same reason: this
// depends on a message shape it does not own, and its failure mode is a button
// that silently does nothing. The durable version is an explicit bridge the web
// app exposes. Ship that before this ships.
// =============================================================================
ipcRenderer.on("bipli:notification-action", (_e, { action, callSid }) => {
  const msg = { type: "notification-action", callSid: callSid || "", action };
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: msg }));
      console.log(`[spike-probe] delivered ${action} for ${callSid || "<no sid>"}`);
    } else {
      console.log("[spike-probe] 🔴 no serviceWorker container — cannot deliver popup action");
    }
  } catch (e) {
    console.log(`[spike-probe] 🔴 popup action delivery failed: ${e && e.message}`);
  }
});
