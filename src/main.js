// =============================================================================
// Bipli Desktop — SPIKE SHELL.
//
// This is not the product. It is the smallest shell that can honestly answer
// "does the web softphone still work when the window is hidden", and it is
// deliberately shaped so that a PASS here means the real thing will work.
//
// 🔴 SPIKE DOCTRINE (docs in the main repo): a spike that buys its way around
// an integration constraint validates the WRONG SHAPE. The receptionist spike
// bought a native Twilio number, so the SIP-URI `to` format went unproven and
// hung up every real call. So this shell:
//
//   · loads PRODUCTION bipli.com and the REAL login — no fixture page, no
//     injected token, no test harness standing in for the app
//   · runs the permission/autoplay/throttling configuration we INTEND TO SHIP,
//     not a permissive dev configuration that would hide a failure
//   · hides to the tray, because a shell tested only with a visible window
//     proves nothing about the one failure this product exists to remove
//
// If any step needs a flag we would not ship, the spike has failed, and that
// is a finding rather than something to work around.
// =============================================================================

const { app, BrowserWindow, Tray, Menu, session, ipcMain, powerSaveBlocker, nativeImage } = require("electron");
const path = require("path");

const BIPLI_URL = process.env.BIPLI_URL || "https://bipli.com";
const SHELL_VERSION = require("../package.json").version;
const ORIGIN = new URL(BIPLI_URL).origin;

let win = null;
let tray = null;
let quitting = false;
let powerBlockerId = null;

// 🔴 THE SINGLE MOST IMPORTANT LINE IN THE SPIKE, and it is a command-line
// switch rather than a window option, so it must be set before app ready.
//
// Chromium throttles timers in a hidden or occluded window EXACTLY as it does
// in a background tab — the failure this whole product exists to remove. An
// Electron app that hides to the tray is a hidden window. Without this, Bipli
// Desktop reproduces the browser bug with a nicer icon.
//
// backgroundThrottling:false on webPreferences covers the renderer; these two
// switches cover the cases where the compositor decides the window is not
// visible at all (minimised, fully occluded by another window).
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// The web app primes an AudioContext behind a user gesture because browsers
// revoke the autoplay grant. In our own shell that ceremony is not needed —
// and MUST be removed rather than tolerated, because a ringtone that needs a
// click is a phone that does not ring.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// One instance. A second launch surfaces the existing window instead of
// registering a second Twilio Device for the same user.
// ⚠️ WINDOWS TOASTS NEED THIS, AND NEED A START MENU SHORTCUT TOO. Windows
// routes a notification to an application identity; without a matching AppUser
// ModelID and an installed shortcut, a toast is silently dropped. Setting it
// here is necessary and NOT sufficient — the shortcut only exists in a packaged
// (NSIS) install, which is exactly why the toast question cannot be settled by
// `npm run spike`. Must match electron-builder's appId.
app.setAppUserModelId("com.bipli.desktop");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
}

function log(...args) {
  console.log(`[spike ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true,
    title: "Bipli",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // Hands the preload its own version without letting a renderer read
      // package.json.
      additionalArguments: [`--bipli-shell-version=${SHELL_VERSION}`],
      // Renderer-side half of the anti-throttling story. Default is TRUE,
      // which is the browser behaviour we are trying to escape.
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // ⚠️ SCOPED TO OUR ORIGIN, NOT BLANKET-GRANTED. The shell auto-grants media
  // and notifications for bipli.com so the user is not asked every launch —
  // that is the product decision. Everything else, and every other origin, is
  // DENIED: this window can be navigated by a link, and a shell that says yes
  // to any origin is a browser with the address bar removed.
  //
  // 🔴 THE FIRST SPIKE RUN CAME BACK Notification.permission=denied ON WINDOWS,
  // and it is worth being precise about what that does and does not mean. The
  // PREDICTION was that Windows would not render Answer/Decline BUTTONS on an
  // unpackaged build. Permission denied outright is a different failure, and
  // the most likely culprit is this code rather than packaging.
  //
  // The app raises notifications from a SERVICE WORKER (notifications.ts —
  // showNotification with actions, the only way a browser can put buttons on a
  // toast). For a service-worker request Electron's `webContents` can be null
  // and the origin does not necessarily arrive the way it does for a page. The
  // old one-line check compared `requestingOrigin === ORIGIN` and returned
  // false for anything else — including an empty string — so a mismatch reads
  // as a flat denial with nothing in the log to say why.
  //
  // ⚠️ RESOLVED FROM THREE SOURCES, AND LOGGED EITHER WAY. Still origin-scoped:
  // this window can be navigated by a link, and a shell that says yes to any
  // origin is a browser with the address bar removed. But now a denial names
  // the value it denied, so the next run reports the cause instead of us
  // theorising about it a second time.
  const resolveOrigin = (wc, requestingOrigin, details) => {
    const tryOrigin = (u) => {
      try {
        return u ? new URL(u).origin : null;
      } catch {
        return null;
      }
    };
    return (
      tryOrigin(requestingOrigin) ||
      tryOrigin(details && (details.requestingUrl || details.securityOrigin)) ||
      tryOrigin(wc && !wc.isDestroyed?.() ? wc.getURL() : null)
    );
  };

  const ALLOWED = ["media", "notifications", "clipboard-sanitized-write"];

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const origin = resolveOrigin(wc, details && details.requestingUrl, details);
    const ok = origin === ORIGIN && ALLOWED.includes(permission);
    log(
      `permission REQUEST ${permission} origin=${origin ?? "<null>"} ` +
        `raw=${JSON.stringify(details ?? null).slice(0, 200)} → ${ok ? "GRANT" : "DENY"}`,
    );
    cb(ok);
  });

  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const origin = resolveOrigin(wc, requestingOrigin, details);
    const ok = origin === ORIGIN && ALLOWED.includes(permission);
    // Only log the interesting ones — media/notifications are checked often.
    if (ALLOWED.includes(permission)) {
      log(
        `permission CHECK ${permission} origin=${origin ?? "<null>"} ` +
          `requestingOrigin=${requestingOrigin ?? "<null>"} → ${ok ? "ALLOW" : "DENY"}`,
      );
    }
    return ok;
  });

  win.on("close", (e) => {
    // Close hides. Quit is the tray menu only — the whole point is an app that
    // survives the user tidying their desktop.
    if (!quitting) {
      e.preventDefault();
      win.hide();
      log("window HIDDEN (close intercepted) — presence must survive from here");
    }
  });
  win.on("hide", () => log("window hidden"));
  win.on("show", () => log("window shown"));
  win.on("minimize", () => log("window minimized"));

  // =========================================================================
  // 🔑 TWO INDEPENDENT SIGNALS THAT THIS IS THE SHELL, and the page hides its
  // "get the desktop app" prompt on EITHER.
  //
  // The prompt appeared inside the shell because it keyed on
  // window.bipliDesktop, and the bridge was not attaching — one missing import
  // in the preload took the bridge, Answer/Decline and the reload watch with it.
  // The bug is fixed, but the lesson is that ONE signal was a single point of
  // failure for "am I in the app", and it failed in the direction that shows a
  // user an advert for the thing they are already using.
  //
  // A UA suffix is set from the main process, where no renderer script has to
  // run for it to be true. If the bridge ever fails again, the prompt still
  // stays hidden.
  // =========================================================================
  win.webContents.setUserAgent(
    `${win.webContents.getUserAgent()} BipliDesktop/${SHELL_VERSION}`,
  );

  win.loadURL(BIPLI_URL);
  win.webContents.on("did-fail-load", (_e, code, desc) => log(`LOAD FAILED ${code} ${desc}`));
  win.webContents.on("did-finish-load", () => {
    log(`loaded ${BIPLI_URL}`);
    // 🔴 VERIFY THE BRIDGE, DO NOT ASSUME IT. Its absence is silent by nature —
    // no popup, no Answer, no reload watch, and no error anyone sees. This is
    // the check that would have caught the missing import on the first run
    // instead of after a packaged build and a bug report.
    setTimeout(() => {
      if (!bridgeAttached) {
        log(
          "🔴 BRIDGE NOT ATTACHED 5s after load — no ring popup, no Answer/Decline, " +
            "no reload watch. Check the preload for a top-level throw.",
        );
      }
    }, 5000);
  });
  // Surface renderer console lines in the terminal, so the softphone's own
  // logging ([voip] device registered, heartbeat_skipped_unregistered, …) is
  // visible during the hidden-window test without opening devtools.
  win.webContents.on("console-message", (_e, level, message) => {
    if (message.includes("[voip]") || message.includes("[spike-probe]")) log("renderer:", message);
  });
}

// =============================================================================
// TRAY STATE — idle / ringing / on a call.
//
// 🎨 COLOUR NOTE, because the house has a status vocabulary and this is not it.
// The presence-dot law fixes green=available, red=deliberately off,
// amber=broken, grey=neutral — "never share a colour". These three are ACTIVITY
// states, not presence states, so they deliberately stay clear of red and amber
// rather than borrowing a meaning that already belongs to something else:
//
//   idle      green   — registered and available, the one state that IS presence
//   ringing   white   — maximum contrast against both menu bars, plus a flashing
//                       taskbar; a ring must be the loudest thing on screen
//   on a call blue    — busy, distinct from both, and never confusable with the
//                       broken/off pair
// =============================================================================
const ICONS = {};
function trayIcon(name) {
  if (!ICONS[name]) {
    ICONS[name] = nativeImage.createFromPath(path.join(__dirname, "..", "assets", `${name}.png`));
    // macOS menu-bar icons must be marked as templates or they render wrong in
    // dark mode. Colour is lost there by design — the macOS state cue is the
    // tooltip and the dock/flash, not the hue.
    if (process.platform === "darwin") ICONS[name].setTemplateImage(false);
  }
  return ICONS[name];
}

let callState = "idle";
function setCallState(next, detail) {
  if (callState === next) return;
  callState = next;
  const label =
    next === "ringing"
      ? `Bipli. Incoming call${detail ? `: ${detail}` : ""}`
      : next === "in-call"
        ? "Bipli. On a call"
        : "Bipli";
  try {
    tray.setImage(trayIcon(next === "ringing" ? "tray-ringing" : next === "in-call" ? "tray-incall" : "tray-idle"));
    tray.setToolTip(label);
  } catch (e) {
    log("tray update failed", e && e.message);
  }
  log(`call state → ${next}${detail ? ` (${detail})` : ""}`);
  // Rebuild the menu so "Reload" enables/disables with the call, and take the
  // chance to apply anything that was waiting for idle.
  try {
    if (tray) buildTrayMenu();
  } catch {}
  if (next === "idle") applyReloadIfIdle("call ended");
}

// 🔑 AN INCOMING CALL MUST NEVER BE SILENT, EVEN IF EVERY NOTIFICATION PATH
// FAILS. This is the belt to the toast's braces: whatever Windows decides about
// permissions, the window comes back and the taskbar flashes.
//
// ⚠️ show() + focus() STEALS KEYBOARD FOCUS mid-typing, which is genuinely
// unpleasant and is a product decision rather than a technical one. Both
// behaviours are here; RAISE_ON_RING picks. Default is the assertive one you
// asked for — flip it to "flash" if it turns out to be obnoxious in practice.
const RAISE_ON_RING = process.env.BIPLI_RING_BEHAVIOUR || "raise"; // raise | flash
function surfaceForRing(detail) {
  if (!win) return;
  // 🔴 ROUND 2: THE MINIMISED CASE RANG BUT DID NOT SURFACE, while close-hidden
  // worked. The old order asked `isVisible()` first — and on Windows a
  // minimised window can still report visible, so `show()` was skipped and
  // `focus()` on a minimised window does nothing. Restore FIRST, unconditionally,
  // then show; both are no-ops when they do not apply, and neither is worth
  // guarding to save a microsecond on a ringing phone.
  if (win.isMinimized()) win.restore();
  win.show();
  if (RAISE_ON_RING === "raise") {
    // ⚠️ WINDOWS BLOCKS BACKGROUND PROCESSES FROM STEALING FOREGROUND, so a
    // bare focus() is quietly ignored — the window comes back but stays behind
    // whatever the user is in. Briefly asserting always-on-top is the standard
    // way to force it, and it is dropped again immediately so the window does
    // not sit over everything for the rest of the call.
    win.setAlwaysOnTop(true);
    win.focus();
    win.setAlwaysOnTop(false);
  } else {
    win.showInactive();
  }
  // Taskbar flash on Windows/Linux. Harmless no-op on macOS, where the dock
  // bounce is the equivalent and is driven by app.dock below.
  try {
    win.flashFrame(true);
  } catch {}
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.bounce("critical");
    } catch {}
  }
  setCallState("ringing", detail);
}

// =============================================================================
// THE INCOMING-CALL POPUP — ruled in round 2, and it retires the toast problem
// rather than solving it.
//
// Round 2 found no `permission CHECK notifications` lines at all: the web app
// never asks, so the denial is simply the default and there was never a grant
// to win. Chasing requestPermission through a service worker under Electron's
// permission model would be work spent to arrive back at a notification we do
// not control the appearance, actions, or lifetime of. A window we own has
// none of those constraints — and it surfaces regardless of what the MAIN
// window is doing, which is also the honest fix for the minimised case.
//
// 🔴 IT LOADS A LOCAL FILE, NEVER bipli.com. A second BrowserWindow pointed at
// the app would boot a second copy of the softphone and register a SECOND
// Twilio Device for the same user — a phantom leg on every inbound call. The
// popup knows nothing except the caller string main hands it.
// =============================================================================
let ringWin = null;
let ringCallSid = null;

// 🔴 THE POPUP IS BUILT AT STARTUP, NOT ON THE RING — and this is the fix for
// "appears when the main window is visible, does not when it is minimised".
//
// ⚠️ IT WAS NEVER A CHILD WINDOW. The reported diagnosis was `parent:
// mainWindow`; there is no `parent` option anywhere in this file and never was,
// so children-minimise-with-parents cannot be it. What the old code DID do was
// create the BrowserWindow at ring time and wait for `ready-to-show` before
// calling showInactive. That event is a FIRST PAINT, and Chromium deprioritises
// painting for a process that is not in the foreground — so with the app
// minimised the window could be created and simply never reach the state that
// triggered its own show. Same code, different scheduling, invisible popup.
//
// A ringing window also has no time to spare for constructing a BrowserWindow
// and loading a page. Building it once at boot and only calling show() on the
// ring removes creation, loading and first-paint from the ring path entirely.
function buildRingWindow() {
  if (ringWin && !ringWin.isDestroyed()) return ringWin;
  const { screen } = require("electron");
  const area = screen.getPrimaryDisplay().workArea;
  const W = 340;
  const H = 176;
  ringWin = new BrowserWindow({
    width: W,
    height: H,
    x: area.x + area.width - W - 24,
    y: area.y + 24,
    // ⚠️ NO `parent`. Independent top-level window, deliberately: it must
    // outlive, out-rank and out-live the visibility of the main window.
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "ring-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  ringWin.setAlwaysOnTop(true, "screen-saver");
  ringWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ringWin.loadFile(path.join(__dirname, "ring-popup.html"));
  ringWin.webContents.on("did-fail-load", (_e, code, desc) =>
    log(`🔴 ring popup FAILED TO LOAD ${code} ${desc} — no popup will appear`),
  );
  ringWin.webContents.once("did-finish-load", () => log("ring popup preloaded and ready"));
  // Never destroyed by a close; hidden and reused.
  ringWin.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      ringWin.hide();
    }
  });
  return ringWin;
}

function hideRingPopup() {
  if (ringWin && !ringWin.isDestroyed()) ringWin.hide();
  ringCallSid = null;
}

function showRingPopup({ who, line, callSid }) {
  ringCallSid = callSid ?? null;
  const w = buildRingWindow();
  try {
    w.webContents.send("ring:call", { who, line });
    // Re-assert on every ring: another app can take screen-saver level, and a
    // window that was hidden while occluded does not always come back on top.
    w.setAlwaysOnTop(true, "screen-saver");
    w.showInactive();
    w.moveTop();
    // 📋 THE LINE THAT MAKES THE NEXT TEST CONCLUSIVE. Without it we cannot tell
    // "popup never created" from "created and not visible" — which is exactly
    // the ambiguity that made this round's report a guess.
    log(
      `ring popup shown: visible=${w.isVisible()} alwaysOnTop=${w.isAlwaysOnTop()} ` +
        `bounds=${JSON.stringify(w.getBounds())} mainMinimised=${win ? win.isMinimized() : "?"} ` +
        `mainVisible=${win ? win.isVisible() : "?"}`,
    );
  } catch (e) {
    log(`🔴 ring popup show FAILED: ${e && e.message}`);
  }
}

// Answer / Decline travel back through THE APP'S OWN CONTRACT — the
// notification-action message its service-worker path already posts and
// onNotificationAction() already handles. Reusing the wired handler beats
// inventing a second way to answer a call that could drift from the first.
ipcMain.on("ring:respond", (_e, { action }) => {
  log(`popup → ${action}`);
  if (win && !win.isDestroyed()) {
    win.webContents.send("bipli:notification-action", { action, callSid: ringCallSid });
  }
  hideRingPopup();
  if (action === "answer") {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    setCallState("in-call");
  } else {
    setCallState("idle");
  }
});

// =============================================================================
// RELOAD RULE — apply a new build, never mid-call.
//
// The shell is designed never to be quit, so loadURL happens once and a
// Republish never reaches it. The preload polls /api/version and reports a
// changed build id; THIS side decides what to do about it, because it is the
// side that knows whether a call is up.
//
// 🔴 NEVER MID-CALL, AND "MID-CALL" INCLUDES RINGING. Reloading during a ring
// destroys the renderer holding the Twilio Device that is being offered the
// call — the caller hears it drop. So the pending reload is held and applied at
// the first moment the app is idle, which is almost always seconds later.
//
// ⚠️ AND IT IS HELD, NOT DISCARDED. A dropped update would leave exactly the
// stale client this exists to prevent, on the busiest user — the one whose calls
// keep deferring it.
// =============================================================================
let pendingReloadBuild = null;
let bridgeAttached = false;

ipcMain.on("shell:bridge-attached", (_e, { version }) => {
  bridgeAttached = true;
  log(`bridge attached (shell ${version})`);
});
ipcMain.on("shell:bridge-failed", (_e, { message }) => {
  log(`🔴 bridge FAILED to attach: ${message}`);
});

function applyReloadIfIdle(why) {
  if (!pendingReloadBuild) return;
  if (callState !== "idle") {
    log(`reload held (${callState}) — will apply when idle`);
    return;
  }
  if (!win || win.isDestroyed()) return;
  log(`reloading for build ${pendingReloadBuild} (${why})`);
  pendingReloadBuild = null;
  win.webContents.reloadIgnoringCache();
}

ipcMain.on("shell:build-changed", (_e, { commit }) => {
  pendingReloadBuild = commit || "new";
  log(`new build seen: ${pendingReloadBuild}`);
  applyReloadIfIdle("build change");
});

function reloadNow() {
  if (!win || win.isDestroyed()) return;
  pendingReloadBuild = null;
  log("manual reload from tray");
  win.webContents.reloadIgnoringCache();
}

// =============================================================================
// AUTO-UPDATE — the SHELL's own updates, which are a different thing from the
// page's. The page updates by reloading; the shell updates by replacing itself.
//
// ⚠️ Downloads silently, applies on next launch, and NEVER restarts by itself.
// quitAndInstall on a phone that is meant to be always-on would end a call to
// install a version of the thing that was carrying it.
// =============================================================================
function initUpdater() {
  // Unsigned dev builds have no update feed; failing loudly there is noise, not
  // information.
  if (!app.isPackaged) {
    log("updater: skipped (not packaged)");
    return;
  }
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-available", (i) => log(`update available: ${i && i.version}`));
    autoUpdater.on("update-downloaded", (i) =>
      log(`update ${i && i.version} downloaded — applies on next launch`),
    );
    autoUpdater.on("error", (e) => log(`updater error: ${e && e.message}`));
    void autoUpdater.checkForUpdates();
    setInterval(() => void autoUpdater.checkForUpdates(), 6 * 60 * 60 * 1000);
  } catch (e) {
    log(`updater unavailable: ${e && e.message}`);
  }
}

// The tray menu is REBUILT on every call-state change, so "Reload" reflects
// whether it is currently safe. Electron menus are immutable once set — the only
// way to change an item is to build a new menu.
function buildTrayMenu() {
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Bipli", click: () => { win.show(); win.focus(); } },
      {
        label: pendingReloadBuild ? "Reload (update ready)" : "Reload",
        // ⚠️ Disabled during a call rather than hidden: a control that vanishes
        // reads as a broken app, one that is greyed out explains itself.
        enabled: callState === "idle",
        click: () => reloadNow(),
      },
      { type: "separator" },
      {
        label: "Quit Bipli",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  tray = new Tray(trayIcon("tray-idle"));
  tray.setToolTip("Bipli");
  buildTrayMenu();
  tray.on("click", () => (win.isVisible() ? win.hide() : win.show()));
}

// The probe's readings, printed in the terminal. This is the spike's actual
// instrument: it turns "does presence survive being hidden" into a measured
// number instead of a feeling.
// The preload reports what the PAGE decided to alert about — see preload.js for
// why it hooks showNotification rather than inventing its own ring detection.
ipcMain.on("spike:ring", (_e, p) => {
  log(`RING detected via ${p.via}: ${p.title ?? ""} ${p.body ?? ""}`);
  showRingPopup({ who: p.title || null, line: p.body || null, callSid: p.callSid || null });
  surfaceForRing(p.title || null);
});
ipcMain.on("spike:ring-ended", (_e, p) => {
  log(`ring ended via ${p.via}`);
  hideRingPopup();
  setCallState(p.answered ? "in-call" : "idle");
});
ipcMain.on("spike:call-ended", () => {
  hideRingPopup();
  setCallState("idle");
});
// Device inventory from the probe — the round-2 blocker (b).
ipcMain.on("spike:devices", (_e, p) => {
  log(`devices (${p.when}): ${p.summary}`);
  for (const d of p.list) log(`   ${d}`);
});

ipcMain.on("spike:drift", (_e, payload) => {
  const late = payload.actualMs - payload.expectedMs;
  const verdict = late > 5000 ? "🔴 THROTTLED" : late > 1500 ? "⚠️  late" : "ok";
  log(
    `timer tick ${verdict}  expected ${payload.expectedMs}ms  actual ${payload.actualMs}ms  ` +
      `(+${late}ms)  visibility=${payload.visibility}  hiddenFor=${payload.hiddenForS}s`,
  );
});

app.whenReady().then(() => {
  // Keep the machine's app-suspension away from the phone. Display sleep is
  // fine and deliberate — we are not holding the screen on, only preventing
  // the OS suspending the process that is meant to ring.
  powerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
  log(`powerSaveBlocker active=${powerSaveBlocker.isStarted(powerBlockerId)}`);
  createWindow();
  createTray();
  // Build the ring popup NOW, hidden. On the ring we only call show() — no
  // construction, no page load, no waiting for a first paint the compositor may
  // never schedule while the app is in the background.
  buildRingWindow();
  initUpdater();
  log(`spike up — target ${BIPLI_URL}`);
});

app.on("window-all-closed", (e) => {
  // Never quit on last window: the window is hidden, not gone.
  e.preventDefault?.();
});
app.on("before-quit", () => (quitting = true));
