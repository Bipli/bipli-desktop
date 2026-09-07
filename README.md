# Bipli Desktop

The Bipli phone as a desktop app. It sits in your tray, rings when a call comes
in even with every window shut, and answers from a small popup instead of taking
over your screen.

It is a thin Electron shell around **live bipli.com** — there is no offline
bundle. The app you use is the web app; this repo is the part that keeps it
running, audible, and reachable when no window is open. That split is
deliberate: app changes ship by republishing the site, shell changes ship as a
release here.

You need a Bipli account to sign in. <https://bipli.com>

---

## Install

**macOS** — download the latest `.dmg` from
[Releases](https://github.com/Bipli/bipli-desktop/releases/latest), open it, drag
Bipli to Applications, and open it. One universal download covers both Apple
Silicon and Intel Macs. It is signed with our Apple Developer ID and notarised by
Apple, so it opens without a warning.

**Windows** — not published yet. It builds on every release and is deliberately
withheld until code signing is in place: an unsigned installer triggers a
full-page SmartScreen warning that, on a first download, is indistinguishable
from malware. See [History → Windows signing](#windows-signing).

**Anything else** — the web app is the phone. It works in any modern browser with
nothing to install.

### Updating

The app updates itself in the background from GitHub Releases.

> ⚠️ **0.1.0 cannot auto-update.** electron-updater downloads a `.zip` and
> explicitly excludes `dmg`/`pkg`; 0.1.0 published DMGs only, so it has no update
> path at all. If you are on 0.1.0, download 0.1.1 once by hand. From 0.1.1
> onward updates are automatic.

### If it opens to a blank window

That means the shell started but could not reach bipli.com. From 0.1.1 you get an
explanatory screen with a Retry button instead of white. Either way:

- Right-click the Bipli icon near the clock → **Reload**.
- Right-click it → **Show log** to open `bipli.log`, and send us that file.
  It lives in `%APPDATA%\Bipli\` on Windows and
  `~/Library/Application Support/Bipli/` on macOS.

---

## Build

Node 20+ and npm. Building a macOS app requires macOS; building the Windows
installer requires Windows.

```bash
npm install
npm run spike        # run the shell against production, unpackaged
npm run pack:mac     # universal .dmg + .zip in dist/, no publish
npm run pack:win     # NSIS installer in dist/, no publish
```

`BIPLI_URL` points the shell somewhere other than `https://bipli.com`.

### Checks

Pure logic is extracted so it can be tested without booting Electron or owning a
Mac:

```bash
npm run check:tel            # tel: URL parsing, 13 cases
npm run check:load-failure   # which load failures replace the app with the offline screen
node scripts/make-tray-icons.mjs   # regenerate tray icons + build/icon.png
```

### Releasing

Releases are cut by CI, never locally. Push a `v*` tag and
`.github/workflows/release.yml` does the rest:

1. `draft` creates the GitHub release once, **before** any build starts;
2. both platform builds upload into that same draft;
3. `publish` flips it live — but **refuses** a macOS release with no `.zip` or no
   `latest-mac.yml`, because a DMG-only release installs fine and then never
   updates again.

> ⚠️ **Bump `package.json` before tagging.** electron-builder names every
> artifact and writes `latest-mac.yml` from `package.json`, *not* from the git
> tag. Tag `v0.1.2` while it still says `0.1.1` and you publish `0.1.1` files
> under a `0.1.2` release, with a manifest announcing the version everyone
> already has — so nobody ever updates again, silently.

Signing and notarisation need these repository secrets: `MAC_CERT_P12` (base64),
`MAC_CERT_PASSWORD`, `APPLE_API_KEY` (base64 `.p8`), `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`, `APPLE_TEAM_ID`. Windows publishing is additionally gated on
the repository variable `WINDOWS_SIGNED` being `true`.

### Layout

| path | |
|---|---|
| `src/main.js` | window, tray, permissions, ring popup, updater, `tel:` handling |
| `src/preload.js` | the `window.bipliDesktop` bridge |
| `src/ring-popup.html` · `ring-preload.js` | the incoming-call popup |
| `src/offline.html` | shown when bipli.com cannot be reached |
| `src/tel-url.js` · `load-failure.js` | pure logic, unit-tested |
| `build/` | icon, entitlements, NSIS install hooks |

---

# History

Why this shell is shaped the way it is. Each of these was a real failure or a
real measurement, kept because the reasoning outlives the fix.

## The premise: hidden windows get throttled

`webPreferences.backgroundThrottling` defaults to **true**, and Chromium then
throttles timers in a hidden window exactly as it does a background tab. An app
that hides to the tray *is* a hidden window — ship the default and the desktop app
reproduces the browser bug with a nicer icon. Presence is a ~30s heartbeat plus a
60s watchdog, both `setInterval`.

The shell sets `backgroundThrottling: false` plus
`disable-renderer-backgrounding`, `disable-background-timer-throttling` and
`disable-backgrounding-occluded-windows`, and holds a `powerSaveBlocker`.

**Measured: PASS.** Ticks ±15ms across 25+ minutes of both minimise and
close-hide. This was the stop-the-line criterion; everything else was built only
after it held.

## OS notifications are dead, so the popup is the design

Toasts never appeared on Windows — not unpackaged, and not packaged with a Start
Menu shortcut and a matching `AppUserModelID`. The web app raises notifications
from a **service worker**, and `Notification.permission` came back `denied`
because the app never asks: there was no grant to win.

Chasing `requestPermission` through a service worker under Electron's permission
model would have been work spent to arrive back at a notification whose
appearance, actions and lifetime we do not control. So the incoming call surfaces
as our own frameless popup: always-on-top at `"screen-saver"` level, top-right,
Answer/Decline with Enter and Escape bound, shown with `showInactive()` so it
never steals the caret.

🔴 **The popup loads a local file, never bipli.com.** A second `BrowserWindow`
pointed at the app would boot a second copy of the softphone and register a
**second Twilio Device for the same user** — a phantom leg on every inbound call.

✅ **Ruled: a ring shows the popup only.** The main window is not restored, shown
or focused — a phone ringing should not rearrange your desktop. Bringing the
window forward is Answer's job, where the user asked for it.

### The popup that was created and never painted

It failed to appear when the main window was minimised. The reported diagnosis
was `parent: mainWindow` — but there is no `parent` option anywhere in `main.js`
and never has been, so children-minimise-with-parents could not be the cause.

What the code actually did was create the window at ring time and wait for
`ready-to-show`. That event is a **first paint**, and Chromium deprioritises
painting for a process that is not in the foreground — so with the app minimised
the window could be created and never reach the state that triggered its own
show. Same code, different scheduling, invisible popup.

It is now built at startup, hidden, and a ring only calls `show()`. Every show
logs `visible=… alwaysOnTop=… bounds=… mainMinimised=…`, because "popup never
created" and "created but not visible" are completely different bugs and the
first round could not tell them apart.

### Windows will not let a background process take the foreground

A bare `focus()` is quietly ignored: the window returns but sits behind whatever
you were in. Briefly asserting always-on-top forces it, then it is dropped again
so the window does not hover for the rest of the call. Order matters too — a
minimised window on Windows can still report `isVisible() === true`, so
`restore()` runs first, unconditionally.

## Empty device labels were the app's own diagnosis

Blank input/output pickers, and `speakerDevices.set("default")` throwing. Not an
Electron mystery: `useTwilioDevice.tsx` already documents that mic permission
must be granted **before** constructing the Device, or Chrome hides the synthetic
`default` deviceId and the SDK fails to bind an output sink.

The shell warms the grant with one `getUserMedia` at load, released immediately —
holding it would pin the mic and light the OS in-use indicator all session. The
probe measures the inventory **before and after**, because if warming does not
populate the labels then the cause is something else and we must not go on
believing it is fixed.

## A shell that never dies also never restarts

The shell loads live bipli.com and `loadURL` happens once. A browser tab gets
reloaded constantly — people close laptops, restart, open new tabs. A tray app
that survives the user **does not navigate for weeks**, so a republish does not
reach a running client, and the desktop cohort is precisely the one promised it
will never be closed. Hence the build-id watch and the tray's Reload, disabled
mid-call rather than hidden: a control that vanishes reads as a broken app, one
that is greyed out explains itself.

## A blank window with nothing to send us

The first external install opened white. `did-fail-load` was handled by writing
to a console that does not exist in a packaged app, so the failure was both
invisible on screen and unrecoverable afterwards — there was nothing to ask the
customer for.

Now: an offline screen with Retry, and everything logged to
`userData/bipli.log`, rotated at 512KB, opened by **Show log** in the tray.

⚠️ **Main frame only, and never on `-3`.** A failed image or beacon raises
`did-fail-load` too, and `-3` (`ERR_ABORTED`) is what a *normal* navigation looks
like when a page navigates away mid-load. Replacing the app on either would throw
people out of a working session — a worse bug than the one being fixed. There is
also a 20s watchdog, because a captive portal that accepts the connection and
never answers fires no event at all: silence is what a blank window is made of.

## `tel:` handling registers, but cannot make itself the default

`setAsDefaultProtocolClient` **returns `true` when nothing changed**. Neither OS
lets an app take a protocol default on its own, so the shell logs both what it
asked for and what `isDefaultProtocolClient` reports afterwards — without that
pair of lines, "clicking a number does nothing" is unanswerable.

- **Windows** — the runtime call makes Bipli a *candidate*. It appears in
  Settings → Apps → Default apps → Choose defaults by link type → TEL only
  because the installer writes `Capabilities` and `RegisteredApplications`
  (`build/installer.nsh`), and removes them on uninstall: a stale association
  pointing at a deleted binary is how the problem survives the uninstall meant to
  fix it.
- **macOS** — the real registration is `CFBundleURLTypes` from the `protocols`
  block in `package.json`; the runtime call alone does nothing.

A number lands in the dialler **pre-filled and focused, never dialled**. An
OS-wide handler that placed a call the instant something emitted a `tel:` URL
would put an accidental click straight through to a customer.

## One release per tag

The first tagged release produced **two** drafts: both platform jobs ran
`--publish always` at the same moment, each looked for a release for the tag,
each found none, and each created one. Whichever lost the race uploaded into a
release nobody publishes. Creating the draft in a job the builds *depend on*
removes the race rather than narrowing it.

## The macOS ZIP is not optional

`electron-updater`'s `MacUpdater` asks for a `.zip` and explicitly excludes `dmg`
and `pkg`. 0.1.0 published DMGs only, so it installs perfectly and then never
updates again. The publish job now refuses a macOS release without one.

## Universal, not per-chip

0.1.0 shipped one DMG per architecture. 0.1.1 ships a single universal build so
nobody has to know which Mac they own. Both resolve correctly through the
updater: it prefers a filename containing `process.arch` and otherwise takes the
first match, so a lone universal artifact satisfies arm64 and x64 alike.

## Tray icons

Generated by `node scripts/make-tray-icons.mjs` — build output, not hand-drawn
assets.

🔴 **The source is a tile inside a tile.** `icon.png` is a 512px cream square
containing a 320px black rounded tile, inset 96px. Scaled straight to 16px the
tray showed a cream frame around the real icon, wasting a third of the pixels at
the size where pixels are scarcest.

⚠️ **The cream cannot be removed by colour: the B inside the tile is also cream.**
Knocking out cream pixels erases the letter and leaves a black lozenge. The cream
to remove is the cream *outside* the tile, and "outside" is topological rather
than chromatic — so it is found by flood-filling inward from the four corners.
Cream enclosed by black is never reached, and the tile's own corner radius
survives because it is preserved rather than re-cut.

Measured contrast:

| icon | vs light taskbar | vs dark taskbar |
|---|---|---|
| white silhouette | **0%** | high |
| cream-framed app icon | 42% | 67% |
| tight black tile (now) | **95%** | **13%** |

That 13% is not a fixable number, it is the shape of the problem: no single
opaque image is high-contrast against both a near-white and a near-black
background. The cream-framed version scored more evenly precisely *because* it
had both a light field and a dark tile — and it looked wrong. If dark taskbars
turn out to be a real problem, the fix is a per-theme icon pair, not a different
crop.

macOS uses a monochrome silhouette as a **template image**. Only idle is a
template: a template is rendered as a mask, so a coloured state dot inside one
would come out an indistinguishable blob. The state dot is green ringing, blue
on-a-call — deliberately clear of the presence vocabulary's red (off) and amber
(broken), because these are activity states and must not borrow a meaning that
belongs to something else.

## Windows signing

**Azure Artifact Signing**, Basic tier, ~$9.99/month — cloud-signed, so no
hardware token. Everything else reputable needs an OV certificate plus a token or
a separate cloud-signing subscription, landing at roughly $200–600/year.

🔴 **Australia qualifies as an organization, not as an individual.** Microsoft's
eligibility note limits individual developers to the US and Canada. Sign up as
the legal entity — company name, website, ABN, registered address. A wrong
identity validation cannot be edited; you start a new request, which affects
certificates already issued. Budget 1–20 business days.

No Australian Azure region hosts the signing resource, so the account lives
elsewhere. That is build artefacts rather than customer data, so it does not
touch the data-residency position — worth recording, not worth blocking on.

## Still unproven

Honest list, kept current: whether the popup's **Answer actually connects** on
every platform, and whether `tel:` registration survives a real install on
Windows. Both need a machine this repo has never been built on.
