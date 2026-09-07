// =============================================================================
// tel: URL → a number the dialler can use.
//
// Its own file with no electron import so it can be tested in plain node. The
// input is whatever the OS hands us, which is more varied than "tel:+61...":
//
//   tel:+61400000000
//   tel:0400%20000%20000            (percent-encoded spaces)
//   tel:+61400000000;phone-context=+61   (RFC 3966 parameters)
//   tel:(04)%2000-000-000           (punctuation from a web page)
//   TEL:+61400000000                (schemes are case-insensitive)
//
// 🔑 IT DOES NOT VALIDATE. The web app already parses leniently
// (parseAndValidateE164, falling back to the raw string so a bad number is
// visible and fixable rather than silently dropped). Validating here as well
// would mean two places deciding what a number is, and the stricter one
// silently winning.
// =============================================================================

/**
 * @param {string} raw a tel: URL, or anything else
 * @returns {string|null} the dialable part, or null if this is not a tel: URL
 */
function telUrlToNumber(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^tel:/i.test(trimmed)) return null;
  let rest = trimmed.slice(4);
  // RFC 3966 parameters (;phone-context=, ;ext=) are metadata, not digits.
  const semi = rest.indexOf(";");
  if (semi >= 0) rest = rest.slice(0, semi);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // A malformed escape is not a reason to drop the call — keep the raw text
    // and let the dialler show it.
  }
  // Keep only what a phone number can contain. '+' is kept ONLY leading, so a
  // stray one mid-string cannot produce a nonsense E.164.
  const plus = rest.trimStart().startsWith("+");
  const digits = rest.replace(/[^0-9*#]/g, "");
  if (!digits) return null;
  return (plus ? "+" : "") + digits;
}

/** Pick the first tel: URL out of a process argv (Windows delivers it there). */
function telFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv) {
    const n = telUrlToNumber(a);
    if (n) return n;
  }
  return null;
}

module.exports = { telUrlToNumber, telFromArgv };
