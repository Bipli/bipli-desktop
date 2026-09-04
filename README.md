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
