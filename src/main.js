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

  win.loadURL(BIPLI_URL);
  win.webContents.on("did-fail-load", (_e, code, desc) => log(`LOAD FAILED ${code} ${desc}`));
  win.webContents.on("did-finish-load", () => log(`loaded ${BIPLI_URL}`));
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
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  if (RAISE_ON_RING === "raise") {
    win.focus();
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

function createTray() {
  tray = new Tray(trayIcon("tray-idle"));
  tray.setToolTip("Bipli");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Bipli", click: () => { win.show(); win.focus(); } },
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
  tray.on("click", () => (win.isVisible() ? win.hide() : win.show()));
}

// The probe's readings, printed in the terminal. This is the spike's actual
// instrument: it turns "does presence survive being hidden" into a measured
// number instead of a feeling.
// The preload reports what the PAGE decided to alert about — see preload.js for
// why it hooks showNotification rather than inventing its own ring detection.
ipcMain.on("spike:ring", (_e, p) => {
  log(`RING detected via ${p.via}: ${p.title ?? ""} ${p.body ?? ""}`);
  surfaceForRing(p.title || null);
});
ipcMain.on("spike:ring-ended", (_e, p) => {
  log(`ring ended via ${p.via}`);
  setCallState(p.answered ? "in-call" : "idle");
});
ipcMain.on("spike:call-ended", () => setCallState("idle"));

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
  log(`spike up — target ${BIPLI_URL}`);
});

app.on("window-all-closed", (e) => {
  // Never quit on last window: the window is hidden, not gone.
  e.preventDefault?.();
});
app.on("before-quit", () => (quitting = true));
