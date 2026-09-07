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

const { app, BrowserWindow, Tray, Menu, session, ipcMain, powerSaveBlocker, nativeImage, shell } = require("electron");
const path = require("path");
const { shouldShowOffline } = require("./load-failure");
const { telUrlToNumber, telFromArgv } = require("./tel-url");

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

// =============================================================================
// tel: HANDLING — clicking a number anywhere on the machine dials it in Bipli.
//
// 🔑 IT PRE-FILLS, IT DOES NOT DIAL. The number lands in the dialler, focused,
// one tap from calling. An OS-wide handler that places a call the instant
// something emits a tel: URL would put an accidental click straight through to a
// customer.
//
// It terminates at /dial?to=, the click-to-call route the web app already has
// (Finding #39, built for Zoho): it parses leniently, falls back to the raw
// string so a bad number is visible rather than silently dropped, and stashes
// itself through a logged-out landing. Reusing it means the desktop handler and
// the CRM hand-off cannot drift apart.
//
// ⚠️ REGISTRATION IS A REQUEST, NOT A FACT — see registerTelHandler().
// =============================================================================
let pendingTel = null;

/** Send a number to the dialler, or hold it until the window exists. */
function openInDialler(number) {
  if (!number) return;
  log(`tel: → dialler ${number}`);
  if (!win) {
    // Cold start: the URL arrives before the window does.
    pendingTel = number;
    return;
  }
  const url = `${BIPLI_URL.replace(/\/$/, "")}/dial?to=${encodeURIComponent(number)}`;
  win.loadURL(url).catch((e) => log(`tel: navigation failed: ${e && e.message}`));
  if (!win.isVisible()) win.show();
  win.focus();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows/Linux: a tel: click on an already-running app arrives as a second
  // instance whose argv carries the URL.
  app.on("second-instance", (_e, argv) => {
    const n = telFromArgv(argv);
    if (n) openInDialler(n);
    if (win) {
      win.show();
      win.focus();
    }
  });
}

// macOS delivers it as an event instead, and can do so BEFORE the app is ready.
app.on("open-url", (event, url) => {
  event.preventDefault();
  const n = telUrlToNumber(url);
  log(`open-url ${url} → ${n ?? "(not a tel: URL)"}`);
  if (n) openInDialler(n);
});

// =============================================================================
// LOGGING TO A FILE THE CUSTOMER CAN SEND
//
// 🔴 console.log IS INVISIBLE IN A PACKAGED APP. Every diagnostic this shell
// prints — the bridge check, load failures, device probes — went to a terminal
// nobody has. Jordan's first install opened a blank window and there was nothing
// to ask him for. Everything now also lands in userData/bipli.log, and "Show
// log" in the tray opens it.
//
// ⚠️ NO SECRETS ARE LOGGED, and nothing here may start doing so. The shell never
// sees a password or a token: it loads a URL and relays call events. Keep it
// that way — this file is meant to be emailed to us by a customer.
// =============================================================================
const fs = require("fs");
const LOG_MAX_BYTES = 512 * 1024;
let logPath = null;
let logWarned = false;

function logFilePath() {
  if (logPath) return logPath;
  try {
    logPath = path.join(app.getPath("userData"), "bipli.log");
  } catch {
    // getPath throws before app is ready; the caller falls back to console.
    return null;
  }
  return logPath;
}

function log(...args) {
  const line = `[bipli ${new Date().toISOString()}] ${args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")}`;
  console.log(line);
  const p = logFilePath();
  if (!p) return;
  try {
    // Rotate rather than grow without limit: one previous file is enough to
    // cover "it broke, I restarted it, then it broke again".
    try {
      if (fs.statSync(p).size > LOG_MAX_BYTES) fs.renameSync(p, `${p}.1`);
    } catch { /* no file yet */ }
    fs.appendFileSync(p, line + "\n");
  } catch (e) {
    // A logger that crashes the app it is diagnosing is worse than no logger.
    if (!logWarned) {
      logWarned = true;
      console.log(`[bipli] could not write ${p}: ${e && e.message}`);
    }
  }
}

// =============================================================================
// REGISTERING AS A tel: HANDLER
//
// 🔴 setAsDefaultProtocolClient RETURNS true WHEN NOTHING CHANGED. Neither OS
// lets an app take a protocol default on its own:
//
//   Windows — the call writes HKCU\Software\Classes, which makes Bipli a
//     CANDIDATE. The user still has to pick it in the "How do you want to open
//     this?" chooser, or in Settings → Apps → Default apps → Choose defaults by
//     link type → TEL. The installer writes the Capabilities/RegisteredApplications
//     entries (build/installer.nsh) so Bipli APPEARS in that list at all.
//   macOS — the real registration is CFBundleURLTypes in the bundle, which comes
//     from the `protocols` block in package.json; the runtime call only asks
//     LaunchServices to prefer us. macOS defaults tel: to FaceTime and prompts
//     once.
//
// So the return value is worth nothing and the STATE is worth everything: log
// what we asked for and what the OS says afterwards. Without that, "clicking a
// number does nothing" is unanswerable — which is the same hole the blank window
// left us in.
// =============================================================================
function registerTelHandler() {
  try {
    const asked = app.setAsDefaultProtocolClient("tel");
    const isDefault = app.isDefaultProtocolClient("tel");
    log(`tel: handler — setAsDefaultProtocolClient=${asked} isDefaultProtocolClient=${isDefault}`);
    if (!isDefault) {
      log(
        "tel: Bipli is registered as a CANDIDATE but is not the default handler. " +
          "The user must choose it once: Windows → Settings, Apps, Default apps, " +
          "Choose defaults by link type, TEL. macOS → the prompt on the first tel: click.",
      );
    }
  } catch (e) {
    log(`tel: registration threw: ${e && e.message}`);
  }
}

// =============================================================================
// LOADING THE APP, AND FAILING VISIBLY WHEN IT WILL NOT LOAD
//
// 🔴 JORDAN'S FIRST INSTALL OPENED A BLANK WHITE WINDOW. did-fail-load was
// handled by logging to a console nobody could see, and the window was left
// showing whatever it had — nothing. A shell that cannot reach its own site has
// exactly one job: say so, and offer to try again.
//
// ⚠️ THE WATCHDOG EXISTS BECAUSE did-fail-load IS NOT THE ONLY WAY TO FAIL. A
// captive portal that accepts the connection and never answers, or DNS that
// hangs, produces no event at all — the window just sits there. Silence is the
// failure mode a blank window is made of, so it is timed.
// =============================================================================
const TRAY_IDLE_TOOLTIP = "Bipli — right-click for Reload and Show log";
const LOAD_TIMEOUT_MS = 20000;
let loadWatchdog = null;
let showingOffline = false;

function clearLoadWatchdog() {
  if (loadWatchdog) {
    clearTimeout(loadWatchdog);
    loadWatchdog = null;
  }
}

function loadApp() {
  showingOffline = false;
  clearLoadWatchdog();
  log(`loading ${BIPLI_URL}`);
  loadWatchdog = setTimeout(() => {
    // Reached only if neither did-finish-load nor did-fail-load ever fired.
    log(`LOAD TIMEOUT after ${LOAD_TIMEOUT_MS}ms — no response from ${BIPLI_URL}`);
    showOffline(`no response after ${LOAD_TIMEOUT_MS / 1000}s`);
  }, LOAD_TIMEOUT_MS);
  win.loadURL(BIPLI_URL).catch((e) => log(`loadURL rejected: ${e && e.message}`));
}

function showOffline(reason) {
  clearLoadWatchdog();
  if (showingOffline) return; // one failure, one screen
  showingOffline = true;
  log(`showing offline screen (${reason})`);
  // The reason rides in the hash so the page needs no preload and no IPC to
  // render it — one less thing that can be broken at the moment it is needed.
  win.loadFile(path.join(__dirname, "offline.html"), { hash: encodeURIComponent(reason) })
    .catch((e) => log(`could not show offline screen: ${e && e.message}`));
  if (!win.isVisible()) win.show();
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

  loadApp();
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    log(`LOAD FAILED ${code} ${desc} url=${url} mainFrame=${isMainFrame}`);
    // ⚠️ MAIN FRAME ONLY, AND NEVER ON -3. A failed image or an analytics
    // beacon fires this too, and replacing the whole app because a favicon 404d
    // would be a worse bug than the one being fixed. -3 is ERR_ABORTED, which
    // is what a NORMAL navigation looks like when the page navigates away
    // mid-load — treating it as an error would throw people out of the app
    // while they use it.
    if (!shouldShowOffline(code, isMainFrame)) return;
    showOffline(`${code} ${desc}`);
  });
  win.webContents.on("did-finish-load", () => {
    clearLoadWatchdog();
    log(`loaded ${win.webContents.getURL()}`);
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

// 🎨 PLATFORM SPLIT, AND IT IS NOT COSMETIC.
//
//   Windows tray sits on a dark taskbar   → WHITE Bipli mark.
//   macOS menu bar takes a TEMPLATE image → BLACK on transparent; the OS
//                                           inverts it for light/dark.
//
// 🔴 A TEMPLATE IMAGE IS RENDERED AS A MASK, SO COLOUR IN IT IS DISCARDED. A
// coloured state dot inside a macOS template comes out as an indistinguishable
// blob — the one thing the dot exists to convey. So on macOS only IDLE is a
// template; ringing and on-call ship as ordinary coloured images and give up
// automatic light/dark inversion. That is the right way round: those states are
// transient and the colour IS the information, while idle is what sits in the
// bar all day and has to look native.
const IS_MAC = process.platform === "darwin";
const TRAY_FILE = {
  idle: IS_MAC ? "trayTemplate" : "tray-idle",
  ringing: IS_MAC ? "tray-ringing-mac" : "tray-ringing",
  "in-call": IS_MAC ? "tray-incall-mac" : "tray-incall",
};

function trayIcon(state) {
  const name = TRAY_FILE[state] ?? TRAY_FILE.idle;
  if (!ICONS[name]) {
    const img = nativeImage.createFromPath(path.join(__dirname, "..", "assets", `${name}.png`));
    if (img.isEmpty()) {
      // A missing icon makes the tray silently blank — which reads as the app
      // having crashed. Say so.
      log(`🔴 tray icon missing or unreadable: assets/${name}.png`);
    }
    // Only the idle mark is a template; see the note above.
    if (IS_MAC) img.setTemplateImage(name === "trayTemplate");
    ICONS[name] = img;
  }
  return ICONS[name];
}

let callState = "idle";
function setCallState(next, detail) {
  if (callState === next) return;
  callState = next;
  // ⚠️ IDLE KEEPS THE DISCOVERY HINT. This runs on every call-state change and
  // used to reset the tooltip to a bare "Bipli", quietly undoing the hint set at
  // tray creation — so the help would disappear after the user's first call and
  // never come back. During a call the state is the more useful thing to say.
  const label =
    next === "ringing"
      ? `Bipli. Incoming call${detail ? `: ${detail}` : ""}`
      : next === "in-call"
        ? "Bipli. On a call"
        : TRAY_IDLE_TOOLTIP;
  try {
    tray.setImage(trayIcon(next));
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

// =============================================================================
// 🔑 RING = POPUP ONLY. RULED. The main window is not restored, shown or
// focused when a call comes in.
//
// It used to be: restore, show, and force foreground via an always-on-top
// juggle. That was written when the popup was unreliable and the main window
// was the fallback — and it is the wrong behaviour now that the popup works. A
// phone ringing should not rearrange your desktop. If you are mid-sentence in
// another app, a small window appearing in the corner is an interruption you
// can ignore; a whole browser-sized window shoving itself in front of you is
// not.
//
// ⚠️ ONE THING SURVIVES, AND IT IS A JUDGEMENT CALL — the taskbar flash. It
// touches no window state (no restore, no show, no focus), and it is the only
// cue for a popup that has opened on a monitor you are not looking at. Say the
// word and it goes; "popup only" could reasonably be read to exclude it.
//
// Bringing the main window forward is now ANSWER's job, where the user has
// asked for it — see the ring:respond handler.
// =============================================================================
function markRinging(detail) {
  if (win && !win.isDestroyed()) {
    try {
      win.flashFrame(true);
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
    // 🔑 THE RAISE LIVES HERE NOW — the one moment the user has actually asked
    // for the window. Restore FIRST and unconditionally: on Windows a minimised
    // window can still report visible, so an isVisible() check skips show(),
    // and focus() on a minimised window does nothing.
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      // ⚠️ WINDOWS BLOCKS A BACKGROUND PROCESS FROM STEALING FOREGROUND, so a
      // bare focus() is quietly ignored and the window returns behind whatever
      // you were in. Briefly asserting always-on-top forces it; dropped again
      // at once so it does not hover for the rest of the call.
      win.setAlwaysOnTop(true);
      win.focus();
      win.setAlwaysOnTop(false);
      try {
        win.flashFrame(false);
      } catch {}
    }
    setCallState("in-call");
  } else {
    if (win && !win.isDestroyed()) {
      try {
        win.flashFrame(false);
      } catch {}
    }
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

ipcMain.on("shell:retry-load", () => {
  log("retry requested from the offline screen");
  loadApp();
});

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
      {
        // 🔑 THE ONLY WAY A CUSTOMER CAN HAND US EVIDENCE. Opens the log in
        // whatever the OS uses for .log files. Deliberately not "Copy
        // diagnostics" or an upload: opening a file is a thing people already
        // know how to do, and it shows them exactly what they are sending us.
        label: "Show log",
        click: async () => {
          const p = logFilePath();
          if (!p) return;
          try {
            // Ensure the file exists — nothing is more confusing than a menu
            // item that appears to do nothing on a fresh install.
            if (!fs.existsSync(p)) fs.writeFileSync(p, "");
            // showItemInFolder, not openPath: a .log has no default handler on
            // many Windows machines, and openPath would silently do nothing.
            shell.showItemInFolder(p);
          } catch (e) {
            log(`could not reveal log: ${e && e.message}`);
          }
        },
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
  tray = new Tray(trayIcon("idle"));
  // ⚠️ THE TOOLTIP IS THE DISCOVERY PATH WHEN THE WINDOW IS BLANK. If the app
  // failed to load, the tray icon is the only Bipli affordance on screen and its
  // menu is not obvious — say what it is for, in the one place the OS will show
  // without a click.
  tray.setToolTip(TRAY_IDLE_TOOLTIP);
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
  markRinging(p.title || null);
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
  registerTelHandler();
  // Cold start on Windows: the URL that launched us is in our own argv.
  const cold = telFromArgv(process.argv);
  if (cold) openInDialler(cold);
  else if (pendingTel) { const n = pendingTel; pendingTel = null; openInDialler(n); }

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
