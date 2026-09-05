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

// ⚠️ contextBridge IS NOT OPTIONAL HERE, and leaving it out cost three features
// silently. `contextBridge.exposeInMainWorld` sat at module top level with the
// name undefined, so the preload threw a ReferenceError partway through and
// everything below it — the bridge, the Answer/Decline listener, the version
// poll — never evaluated. The file passes `node --check` because the syntax is
// perfectly valid; only the reference is wrong. Syntax checking cannot catch
// this class, which is why main.js now VERIFIES the bridge attached at runtime.
const { contextBridge, ipcRenderer } = require("electron");

// Injected by main.js via additionalArguments so the bridge can report the
// shell's own version without reading package.json from the renderer.
const SHELL_VERSION =
  (process.argv.find((a) => a.startsWith("--bipli-shell-version=")) || "").split("=")[1] || "0.0.0";

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

// =============================================================================
// THE DESKTOP BRIDGE — window.bipliDesktop, which the web app calls on purpose.
//
// 🔴 THIS REPLACES A MONKEY-PATCH, and the patch is DELETED rather than kept as
// a fallback. The shell used to learn about a ring by overwriting
// ServiceWorkerRegistration.prototype.showNotification and watching what went
// past. It worked — and it was a dependency on a shape this repo does not own,
// whose failure mode was a silently un-ringing phone. The web repo's
// client/src/lib/desktop-bridge.ts now calls these directly.
//
// ⚠️ KEEPING BOTH WOULD HAVE BEEN WORSE THAN EITHER: two ring sources means
// double popups when both fire, and an unfalsifiable question about which one
// is live when neither does.
// =============================================================================
const actionHandlers = new Set();

try {
contextBridge.exposeInMainWorld("bipliDesktop", {
  /** An incoming call is ringing. Told, not inferred. */
  ring: (r) => {
    try {
      ipcRenderer.send("spike:ring", {
        via: "bridge",
        title: r && r.who,
        body: r && r.line,
        callSid: (r && r.callSid) || null,
      });
    } catch {}
  },
  callAnswered: () => {
    try {
      ipcRenderer.send("spike:ring-ended", { via: "bridge", answered: true });
    } catch {}
  },
  callEnded: () => {
    try {
      ipcRenderer.send("spike:call-ended", {});
    } catch {}
  },
  /** Answer / Decline pressed in the shell's popup. */
  onAction: (cb) => {
    if (typeof cb === "function") actionHandlers.add(cb);
  },
  /** Version string, so the page can say what it is running inside. */
  version: SHELL_VERSION,
});
  ipcRenderer.send("shell:bridge-attached", { version: SHELL_VERSION });
} catch (e) {
  // 🔴 A BRIDGE THAT FAILS TO ATTACH MUST NOT BE SILENT. It takes the ring
  // popup, Answer/Decline and the reload watch with it, and every one of those
  // fails as "nothing happened".
  console.log(`[spike-probe] 🔴 BRIDGE FAILED TO ATTACH: ${e && e.message}`);
  try {
    ipcRenderer.send("shell:bridge-failed", { message: String((e && e.message) || e) });
  } catch {}
}

ipcRenderer.on("bipli:notification-action", (_e, { action, callSid }) => {
  // Hand it to the web app's own handler. No synthetic MessageEvent, no
  // pretending to be the service worker — the app registered for this.
  if (actionHandlers.size === 0) {
    console.log(
      "[spike-probe] 🔴 popup action with NO handler registered — the web app's bridge did not attach",
    );
    return;
  }
  for (const cb of actionHandlers) {
    try {
      cb({ action, callSid: callSid || null });
    } catch (e) {
      console.log(`[spike-probe] popup action handler threw: ${e && e.message}`);
    }
  }
});

// =============================================================================
// RELOAD WATCH — a shell that never quits also never reloads.
//
// loadURL happens once at launch, so a Republish does not reach a running
// client: it can hold a months-old bundle while every browser user is current,
// and that cohort is exactly the one promised the app will never be closed.
//
// ⚠️ THE MAIN PROCESS DECIDES WHETHER TO ACT, not this side. It owns the call
// state, and a renderer cannot be trusted to judge whether it is safe to destroy
// itself. All this does is report what the server said.
// =============================================================================
const VERSION_POLL_MS = 5 * 60 * 1000;
let knownBuild = null;

async function checkVersion() {
  try {
    const res = await fetch("/api/version", { cache: "no-store", credentials: "include" });
    if (!res.ok) return;
    const { commit } = await res.json();
    // "unknown" means the server could not read its own bundle hash. Treating
    // that as a new build would reload on every poll.
    if (!commit || commit === "unknown") return;
    if (knownBuild === null) {
      knownBuild = commit;
      console.log(`[spike-probe] build ${commit}`);
      return;
    }
    if (commit !== knownBuild) {
      console.log(`[spike-probe] new build ${commit} (was ${knownBuild})`);
      knownBuild = commit;
      ipcRenderer.send("shell:build-changed", { commit });
    }
  } catch {
    /* offline or mid-deploy; the next tick asks again */
  }
}
window.addEventListener("load", () => {
  void checkVersion();
  setInterval(() => void checkVersion(), VERSION_POLL_MS);
});
