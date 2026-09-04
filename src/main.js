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
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    const requesting = (() => {
      try {
        return new URL(wc.getURL()).origin;
      } catch {
        return null;
      }
    })();
    const allowed = ["media", "notifications", "clipboard-sanitized-write"];
    const ok = requesting === ORIGIN && allowed.includes(permission);
    log(`permission ${permission} from ${requesting} → ${ok ? "GRANT" : "DENY"}`);
    cb(ok);
  });
  // Same rule for the synchronous check the media stack uses; without this the
  // grant above can still be second-guessed and device labels come back empty.
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return requestingOrigin === ORIGIN && ["media", "notifications"].includes(permission);
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

function createTray() {
  // A 1x1 transparent image keeps the spike dependency-free; the real app ships
  // proper idle/ringing/in-call icons. Tray presence is what is being proven
  // here, not its artwork.
  const img = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVQ4jWNgGAWjYBSMglEwCkbBKBgFo4CBAAAI8AAB/N6vLwAAAABJRU5ErkJggg==",
  );
  tray = new Tray(img);
  tray.setToolTip("Bipli (spike)");
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
