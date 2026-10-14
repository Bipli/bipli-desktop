// =============================================================================
// bipli:// URL → the in-app path to open (2026-10-14).
//
// Its own file with no electron import so it can be tested in plain node
// (scripts/check-deep-link.js), like tel-url.js. The OS hands us:
//
//   bipli://call/<voip_calls.id>                  → /calls?call=<id>
//   bipli://thread/<conversationKey, %-encoded>   → /messages?conversationKey=<key>
//   BIPLI://CALL/…                                (schemes are case-insensitive)
//
// Anything else (an unknown kind, an empty id, a tel: URL) is null: the tel:
// parser owns those, and an unknown bipli:// link must not navigate anywhere.
// The id is re-encoded for the query string, so a key with a '|' survives.
// =============================================================================

/**
 * @param {string} raw a bipli:// URL, or anything else
 * @returns {{kind: "call"|"thread", id: string, path: string}|null}
 */
function deepLinkFromUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const m = /^bipli:\/\/([a-z]+)\/(.+)$/i.exec(trimmed);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  let id = m[2].replace(/[?#].*$/, "").replace(/\/+$/, "");
  try {
    id = decodeURIComponent(id);
  } catch {
    // keep the raw text; the web view will say "not found" rather than us dropping the click
  }
  if (!id) return null;
  if (kind === "call") return { kind: "call", id, path: `/calls?call=${encodeURIComponent(id)}` };
  if (kind === "thread") return { kind: "thread", id, path: `/messages?conversationKey=${encodeURIComponent(id)}` };
  return null;
}

/** Pick the first bipli:// URL out of a process argv (Windows delivers it there). */
function deepLinkFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv) {
    const d = deepLinkFromUrl(a);
    if (d) return d;
  }
  return null;
}

module.exports = { deepLinkFromUrl, deepLinkFromArgv };
