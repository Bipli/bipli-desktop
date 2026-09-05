# Bipli Desktop — spike shell + audit

**Status: AUDIT, NOT PRODUCT.** Nothing here ships. It exists to answer one
question before a product is built on the answer: *does the web softphone keep
its Twilio registration when the window is hidden?*

---

## 🔴 Read this first: I could not run the spike

This repo was written on WSL2 with no audio devices (`/dev/snd` contains only
`timer`) and no Windows or Mac target. **I cannot place a call, receive a call,
enumerate audio devices, or produce a signed build.** Every claim below is from
reading Bipli's own client code and vendor documentation. The verdicts marked
**MUST VERIFY** are the ones only you can settle, on your own machines.

That is not a hedge, it is the sequencing you asked for: audit, report, then
build. This is the report, plus the shell to run it with.

    cd bipli-desktop && npm install && npm run spike

Terminal prints the probe. `BIPLI_URL=https://staging.bipli.com npm run spike`
targets staging.

---

## What the spike is shaped to avoid

Per the spike doctrine in the main repo: *a spike that buys its way around an
integration constraint validates the wrong shape.* The receptionist spike bought
a native Twilio number, so the SIP-URI `to` format went unproven and hung up
every real call. So this shell deliberately:

- loads **production bipli.com with the real login** — no fixture page, no
  injected token, no harness standing in for the app;
- runs **the configuration we intend to ship**, not a permissive dev config that
  would paper over a permission or autoplay failure;
- **hides to the tray during the test**, because a shell proven only with a
  visible window proves nothing about the failure this product exists to remove.

If a step needs a flag we would not ship, the spike has **failed** — that is a
finding, not something to work around.

---

## Findings

### 1. 🔴 Electron throttles hidden windows exactly like a background tab

This is the whole thesis, and the default is wrong. `webPreferences.
backgroundThrottling` defaults to **true**; Chromium then throttles timers in a
hidden or occluded window the same way it does in a background tab. An app that
hides to the tray *is* a hidden window. Ship the default and Bipli Desktop
reproduces the browser bug with a nicer icon.

Presence is a ~30s heartbeat plus a 60s watchdog — both `setInterval`. The shell
sets `backgroundThrottling: false` plus `disable-renderer-backgrounding`,
`disable-background-timer-throttling` and `disable-backgrounding-occluded-windows`,
and holds a `powerSaveBlocker` at `prevent-app-suspension`.

**MUST VERIFY.** The probe measures it: it runs a 30s interval — deliberately the
softphone's own period — and prints actual-vs-expected drift with the window
hidden. `🔴 THROTTLED` on any tick while hidden means the premise is dead and we
stop. Nothing else in this document matters if this one fails.

### 2. ⚠️ Answer/Decline notification actions are the highest product risk

`voip/client/lib/notifications.ts` shows OS notifications through a **service
worker** (`showNotification` with `actions`, posting the click back to the page).
That is the only way a browser can put buttons on a notification.

Under Electron this routes to the OS, and the two platforms differ:

- **macOS** renders notification action buttons.
- **Windows** toast actions require a valid `AppUserModelID` **and an installed
  Start Menu shortcut**. An unpackaged `npm run spike` typically has neither.

**MUST VERIFY, AND TEST THE PACKAGED BUILD ON WINDOWS.** Testing this unpackaged
would be exactly the wrong-shape spike: it would "fail" for a reason that does
not apply to the shipped app, or worse, pass on Mac and be assumed for Windows.
If web-surfaced actions do not work, the fallback is a **main-process**
`Notification` driven over IPC — which does support actions — but that is real
scope, so find out before promising Answer/Decline.

### 3. Device selectors: labels are the tell

`useTwilioDevice.tsx` calls `enumerateDevices()` and filters `audioinput` /
`audiooutput`; `AudioSettings.tsx` routes output with `setSinkId`. Chromium
returns **empty labels** unless media permission is genuinely granted — and
empty labels means blank pickers even when audio itself works.

The shell installs both `setPermissionRequestHandler` and
`setPermissionCheckHandler`, scoped to the bipli.com origin only. The check
handler matters: without it the grant can be second-guessed and labels come back
empty. **MUST VERIFY** — the probe prints `devices=N labelled=M` and flags
`LABELS EMPTY`.

### 4. Autoplay ceremony can go — inside the shell only

The web app primes an AudioContext behind a user gesture and re-arms it after
`getUserMedia`, because browsers revoke the grant. The shell sets
`autoplay-policy=no-user-gesture-required`, so a ring needs no click.

⚠️ **Do not delete that code from the web app.** It is load-bearing in browsers,
and iOS especially (the documented `AudioContext` → `'interrupted'` behaviour).
The shell removes the *need*, not the code.

### 5. Presence semantics already work in our favour — verify, do not assume

Hiding an Electron window does **not** fire `pagehide`, so the offline beacon
does not fire and the `user_voip_devices` row is not deleted. `visibilitychange`
does fire, and the web app's wake handler only acts on `visible`, so hiding is a
no-op. On **quit**, `pagehide` fires and the row is correctly removed.

That is the behaviour we want, and it is inference from the code rather than
observation. **MUST VERIFY** by watching the row (below).

### 6. Two registrations are fine, and that is deliberate

Identities are per-tab (`crypto.randomUUID` per load), so running the desktop app
and a browser tab registers two devices and rings both. Expected under the
existing fan-out model, not a defect — but worth knowing before it surprises
someone during the test.

### 7. ⚠️ "It never dies" also means "it never restarts"

Confirmed architecture: the shell loads **live bipli.com**, no offline bundle.
App updates ride Republish, shell updates ride electron-updater. That is the
right split — but it creates a failure mode the browser never had.

A browser tab gets reloaded constantly: people close laptops, restart, open new
tabs. A tray app that survives the user **does not navigate for weeks**. So:

- **A Republish does not reach a running desktop client.** `loadURL` happens
  once at launch. A user who never quits can hold a months-old bundle while
  every browser user is current — and the desktop cohort is precisely the one we
  have promised will never be closed. Every fix in this session's presence work
  would sit unapplied on the machines that need it most.
- **The service worker compounds it.** The app already registers one; its cached
  assets outlive the page.
- **There is no rollback path.** A breaking web change hits every desktop client
  at once, and electron-updater cannot help — it ships the shell, not the page.

Neither is a reason to bundle the app offline; that trade is worse. It is a
reason to decide, before shipping, **how a running shell learns the page moved
on** — a version check that prompts or reloads on idle, or a reload when the
window has been hidden past some threshold. Cheap now, and awkward once there
are installs in the field.

Flagging, not building: it is downstream of finding 1 like everything else.

---

## Round 1 results (Windows, Node 24 / Electron 44) — and what is still blank

Reported: login OK · outbound two-way audio ✓ · inbound rings the window and
answers with audio ✓ · no toast, `Notification.permission=denied`.

🔴 **TWO RESULTS CAME BACK AS UNFILLED PLACEHOLDERS, AND ONE OF THEM IS THE
STOP-THE-LINE CRITERION.**

- **Hidden-window ticks — `[paste: throttled or not]`.** This is finding 1, the
  premise the entire product rests on. Everything built since is on the
  assumption it read `ok`. It costs ten minutes: run the spike, close the
  window, watch the probe.
- **Device labels — `[empty/populated after mic grant]`.** Decides whether the
  input/output selectors work at all. The probe prints it on load.

⚠️ **`Notification.permission=denied` IS NOT WHAT WAS PREDICTED, and letting
"as predicted" stand would have sent us packaging a build to test the wrong
thing.** The prediction was that Windows would not render Answer/Decline
BUTTONS unpackaged. A flat denial is a different failure and the likeliest cause
was this shell's own permission check, which compared `requestingOrigin` to our
origin and returned false for anything else — including an empty string — with
nothing logged to say why. The app raises notifications from a **service
worker**, where `webContents` can be null and the origin does not arrive the way
it does for a page.

Both handlers now resolve the origin from three sources and **log every decision
with the raw value**. Still origin-scoped — a shell that says yes to any origin
is a browser with the address bar removed — but the next run reports the cause
instead of us theorising a second time. Watch for `permission CHECK
notifications origin=… → ALLOW/DENY` in the terminal.

---

## Round 2 — what is in the repo now

**(1) Packaged Windows build.** `npm run pack:win` → NSIS installer in `dist/`.
`appId` is `com.bipli.desktop` and `app.setAppUserModelId` matches it — a
mismatch and toasts vanish with no error. `createStartMenuShortcut: true` is the
point of the whole config: Windows routes a toast to an application identity,
and without an installed shortcut carrying that ID the toast is dropped
silently. That is why `npm run spike` could never settle this and why a
per-machine install, not a portable exe, is the honest test.

Unsigned, so SmartScreen will warn. Expected, dev-only, not the thing under test.

**(2) Main-process Notification over IPC — deliberately NOT built.** You scoped
it as conditional on the packaged build still denying. Building it now would
mean building the fallback before knowing whether the primary works, and if the
permission fix above is the real cause we would have written it for nothing.
The hook it would need already exists (see below), so it is a small step when
the packaged result is in.

**(3) A ring is never silent, whatever notifications do.** Independent of any
toast: the window returns and the taskbar flashes, and the tray shows
idle / ringing / on-a-call.

The shell learns about a ring by hooking the app's **own** alert
(`showNotification`) rather than inventing a second idea of "ringing" that could
drift from the app's — same moment, same caller and dialled-line payload, and no
change to the main repo. It fires even when the OS refuses the notification,
which is exactly the case that failed round 1.

⚠️ **That hook is spike-grade and must not ship as-is.** It is a monkey-patch on
a browser API: it breaks the day `notifications.ts` changes shape, silently, and
the symptom is "the phone stopped surfacing calls" — the worst possible failure
to hang on a patch. The durable version is one explicit line from the web app.
Ship that before this ships.

Tray colours are activity states, so they stay clear of the presence
vocabulary's red (deliberately off) and amber (broken): green idle, white
ringing, blue on-a-call. Icons are generated PNGs in `assets/`.

✅ **RULED: ring = popup only.** The main window is no longer restored, shown or
focused on a ring — a phone ringing should not rearrange your desktop. Bringing
the window forward is now Answer's job, where the user has asked for it, and the
Windows foreground workaround moved there with it. `BIPLI_RING_BEHAVIOUR` is
gone; it selected between two behaviours that no longer exist.

**Full electron-builder config beyond Windows/Mac targets — not yet.** Updater,
signing, publish config and the download page all wait on the blank above.

---

## Round 2 results — the premise HOLDS

**Finding 1: PASS.** Ticks ±15ms across 25+ minutes of both minimise and
close-hide. Presence survives a hidden window. That was the stop-the-line
criterion and everything below is now worth building.

Inbound while close-hidden rang and surfaced the window ✓.

Three gaps came back, and the popup ruling collapses two of them into one.

## Round 3 — what changed

### (a) Minimised rang but did not surface

The order was wrong. It asked `isVisible()` first — and on Windows a minimised
window can still report visible, so `show()` was skipped, and `focus()` on a
minimised window does nothing. Now `restore()` runs first, unconditionally, then
`show()`; both are no-ops when they do not apply and neither is worth guarding
on a ringing phone.

⚠️ Also added the foreground workaround: **Windows blocks a background process
from stealing foreground**, so a bare `focus()` is quietly ignored — the window
returns but sits behind whatever the user is in. Briefly asserting always-on-top
forces it, and it is dropped again immediately so the window does not hover over
everything for the rest of the call.

### (c) → the popup retires the toast question rather than solving it

No `permission CHECK notifications` lines appeared because **the web app never
asks** — the denial is the default, and there was never a grant to win. Chasing
`requestPermission` through a service worker under Electron's permission model
would be work spent to arrive back at a notification whose appearance, actions
and lifetime we do not control.

**Built the incoming-call popup instead.** Frameless, always-on-top at
`"screen-saver"` level (outranks ordinary top-most windows and most full-screen
apps), top-right of the work area, visible on all workspaces. Caller, dialled
line, Answer / Decline, with Enter and Escape bound — a ringing phone should be
answerable without aiming a mouse at a window that just appeared under the
cursor. It appears with `showInactive()`, so it does not steal the caret.

🔴 **It loads a local file, never bipli.com.** A second `BrowserWindow` pointed
at the app would boot a second copy of the softphone and register a **second
Twilio Device for the same user** — a phantom leg on every inbound call. The
popup knows nothing but the caller string main hands it.

**Answer/Decline travels back on the app's OWN contract.** `notifications.ts`
already exports `onNotificationAction()`, listening for
`{ type: "notification-action", callSid, action }` on the service-worker message
channel — the path a toast's buttons take. The popup replays exactly that, so it
answers through the handler the app already has rather than a second mechanism
that could drift. The callSid is carried from the notification's `data.callSid`,
so Answer names the *same* call the app is ringing about — which matters the
moment a second call arrives.

⚠️ Same spike-grade caveat as the ring hook, same reason: it depends on a
message shape it does not own, and its failure mode is a button that silently
does nothing. The durable version is an explicit bridge from the web app.

### (b) Empty labels and the missing "default" sink — the app already diagnosed this

Not an Electron mystery. `useTwilioDevice.tsx:620`, written for browsers:

> Mic permission must be granted before constructing the Device. Without it,
> Chrome's `enumerateDevices()` hides the synthetic "default" deviceId, and the
> SDK's AudioHelper fails to bind an output sink.

That is the reported symptom exactly — empty labels **and** a missing `default`,
which is precisely why `speakerDevices.set("default")` threw. The app guards it
by calling `getUserMedia` inside `ensureDevice`, but its device *enumeration*
runs on its own schedule, and under Electron a handler-granted permission does
not appear to carry the same weight as a browser's persisted user grant.

So the shell **warms the grant**: one `getUserMedia` at load, released
immediately (holding it would pin the mic and light the OS in-use indicator all
session). That is a legitimate shell job — "the shell guarantees the page stays
alive and audible".

⚠️ **And it measures before AND after**, because if warming does not populate the
labels then the cause is something else and we must not go on believing it is
fixed. The probe prints both inventories, flags `"default" sink ABSENT`
explicitly, and then tries `setSinkId` against both `"default"` and the first
real output id — so the next run says which one actually binds instead of us
assuming.

If `default` is still absent after the grant, the durable fix is a small
fallback in the web app (use the first `audiooutput` when the synthetic default
is missing) — which would help any browser that hides it too. Not shipped on a
theory; the inventory decides.

---

## Round 3 verification

- Every IPC channel cross-checked main ↔ both preloads ↔ popup: no orphans in
  either direction. (A typo'd channel is a silent no-op, which is the failure
  mode this whole surface is prone to.)
- `node --check` clean on all three scripts.
- 🔴 **Not booted.** Electron will not start here — WSL2 is missing `libnspr4`
  and friends. Installing them needs sudo on a machine where it still would not
  exercise Windows foreground or always-on-top semantics, which is the whole
  point of these changes. Runtime remains yours.

Next: `npm run pack:win` for the packaged build.

---

## The test — run exactly this

Your success criterion, made falsifiable. Have `psql` open on prod alongside.

1. `npm install && npm run spike`. Log in as a **real user on a real tenant**.
2. Confirm the probe's first lines: `audio devices=… labelled=…`,
   `setSinkId supported=true`, `Notification.permission=granted`.
3. **Place an outbound call.** Two-way audio.
4. **Switch input and output devices** mid-call from the app's own selectors.
   Audio follows. (This is the one most likely to fail quietly.)
5. **Close the window** (it hides — the terminal logs `window HIDDEN`).
6. **Wait 10 minutes.** Watch the probe. Every tick must read `ok`. Any
   `🔴 THROTTLED` while hidden is a stop-the-line result.
7. In parallel, watch the device row survive:

   ```sql
   SELECT NOW()::time(0), tab_id, last_seen_at::time(0),
          EXTRACT(EPOCH FROM (NOW() - last_seen_at))::int AS beat_age_s
     FROM user_voip_devices WHERE user_id = '<your user id>'
    ORDER BY last_seen_at DESC LIMIT 1;
   ```

   `beat_age_s` must stay under ~35s for the full ten minutes. If the row
   **disappears**, the offline beacon fired and finding 5 is wrong.
8. **Ring the line.** Native notification with caller and dialled line. Answer.
   Two-way audio. Window comes to front.
9. **Quit from the tray.** Row disappears; you drop out of the picker.

Steps 6 and 8 are the product. Steps 1–5 are prerequisites.

---

## Windows signing — answer before you buy

**Azure Artifact Signing (formerly Trusted Signing), Basic tier, $9.99/month.**
Cheapest reputable option by a wide margin, and it is cloud-signed, so there is
no hardware token to own or ship. Everything else reputable needs an OV cert
plus either a USB token or a separate cloud-signing subscription, landing at
roughly $200–600/year all-in.

🔴 **One catch, and it decides how you sign up.** Microsoft's own eligibility
note, as of 2026-08-11:

> Public Trust certificates are available to organizations in the United States,
> Canada, the European Union, the United Kingdom, **Australia**, New Zealand,
> Japan, South Korea, Singapore, Switzerland, Norway, and Israel. **Individual
> developers must be located in the United States or Canada.**

So Australia qualifies **as an organization and not as an individual**. Sign up
as the Bipli legal entity — company name, company website, business identifier
(ABN), registered business address — not as yourself. An individual application
from Australia will be rejected, and per the docs a wrong identity validation
cannot be edited: you must start a new request, which affects certificates
already issued.

Budget **1–20 business days** for identity validation, longer if they ask for
documents. Start it before it is on the critical path. Note also that no
Australian Azure region hosts the signing resource; the account will live in a
US/EU/Asia region. That is build artefacts, not customer data, so it does not
touch the data-residency position — worth recording, not worth blocking on.

**macOS**: Developer ID + notarisation on the existing Apple account. No new
spend.

---

## Not done, deliberately

No `electron-builder` config, no updater, no tray artwork, no download page, no
in-app "get the desktop app" prompt. All of it is downstream of finding 1, and
building it first would mean building on an unverified premise — which is the
mistake this sequencing exists to prevent.

This repo has **not** been pushed to GitHub. Creating the remote is yours.

---

## Round 3 results (packaged Windows) and round 4

**Install OK, launches to tray, session shared.**

**Toasts are dead, even packaged with a Start Menu shortcut and a matching
AppUserModelID.** So the popup is not a fallback, it is the design — settled, and
no more work goes into OS notifications.

### 🔴 The popup did not appear when the main window was minimised

⚠️ **It was never a child window.** The reported diagnosis was `parent:
mainWindow`; there is no `parent` option anywhere in main.js and never has been,
so children-minimise-with-parents cannot be the cause.

What the code DID do was create the `BrowserWindow` at ring time and wait for
`ready-to-show` before calling `showInactive`. That event is a **first paint**,
and Chromium deprioritises painting for a process that is not in the foreground —
so with the app minimised the window could be created and never reach the state
that triggered its own show. Same code, different scheduling, invisible popup.

**The popup is now built at startup, hidden.** On a ring it only calls `show()`:
no construction, no page load, no waiting for a paint the compositor may never
schedule. `setAlwaysOnTop(true, "screen-saver")` is re-asserted on every ring,
because another app can claim that level and a window hidden while occluded does
not always return on top. It is hidden and reused rather than closed, so the
second call of a session is as fast as the first.

📋 **And it now logs enough to be conclusive.** Every show prints
`visible=… alwaysOnTop=… bounds=… mainMinimised=… mainVisible=…`, plus a loud
line if the page fails to load. Round 3 could not distinguish "popup never
created" from "created and not visible" — which is why the diagnosis had to be a
guess. Round 4 will not have that problem.

### Round 4 test

1. Ring with the main window **visible** — regression check.
2. Ring with the main window **minimised** — the reported failure.
3. Ring with the window **hidden to tray** (closed, not minimised).
4. Ring while a **full-screen app** is foreground.

In each: does the popup appear, and what does the `ring popup shown:` line say?
`visible=true` with no popup on screen is a completely different bug from
`visible=false`, and the log now tells them apart.

⚠️ **Two things in the brief came through unfilled and are still unanswered:**
"Answer connects? [Sam confirms]" — whether the popup's Answer actually connects
the call is the single most important open question, because it exercises the
notification-action contract replay, which is the spike-grade monkey-patch this
build depends on. And "round 4 as briefed" refers to a brief that has not been
given; the four cases above are my proposal, not a restatement of it.
