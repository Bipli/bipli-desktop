// The did-fail-load rule, exercised. Both directions of getting it wrong are
// worse than the bug: eager throws people out mid-call, shy leaves a blank window.
const { shouldShowOffline } = require("../src/load-failure");
const cases = [
  ["main frame, DNS failure (-105)",        -105, true,  true],
  ["main frame, connection refused (-102)", -102, true,  true],
  ["main frame, internet disconnected (-106)", -106, true, true],
  ["main frame, ABORTED (-3) — normal nav",   -3,  true,  false],
  ["subframe, DNS failure",                 -105, false, false],
  ["subframe, ABORTED",                       -3, false, false],
];
let bad = 0;
for (const [name, code, main, want] of cases) {
  const got = shouldShowOffline(code, main);
  if (got !== want) bad++;
  console.log(`  ${got === want ? "✅" : "🔴"} ${name.padEnd(42)} → ${got ? "offline screen" : "ignored"}`);
}
console.log(bad ? `🔴 ${bad} wrong` : "✅ load-failure rule correct");
process.exit(bad ? 1 : 0);
