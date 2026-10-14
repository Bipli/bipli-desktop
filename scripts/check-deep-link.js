const { deepLinkFromUrl, deepLinkFromArgv } = require("../src/deep-link");
const cases = [
  ["bipli://call/a45b174b-c807-44c4-bde9-db8ad4d442f1", "/calls?call=a45b174b-c807-44c4-bde9-db8ad4d442f1"],
  ["BIPLI://CALL/abc", "/calls?call=abc"],
  ["bipli://thread/%2B61420135834%7C%2B61437161857", "/messages?conversationKey=%2B61420135834%7C%2B61437161857"],
  ["bipli://thread/+61420135834|+61437161857", "/messages?conversationKey=%2B61420135834%7C%2B61437161857"],
  ["bipli://call/abc/", "/calls?call=abc"],
  ["bipli://call/abc?x=1", "/calls?call=abc"],
  ["bipli://call/", null],
  ["bipli://settings/billing", null],
  ["tel:+61400000000", null],
  ["https://bipli.com/calls?call=abc", null],
  ["", null],
  [null, null],
];
let bad = 0;
for (const [input, want] of cases) {
  const got = deepLinkFromUrl(input);
  const path = got ? got.path : null;
  const ok = path === want;
  if (!ok) bad++;
  console.log(`  ${ok ? "✅" : "🔴"} ${JSON.stringify(input).padEnd(60)} → ${JSON.stringify(path)}${ok ? "" : `  (want ${JSON.stringify(want)})`}`);
}
const argv = ["C:\\Program Files\\Bipli\\Bipli.exe", "--allow-file-access", "bipli://call/xyz"];
const fromArgv = deepLinkFromArgv(argv);
const argvOk = !!fromArgv && fromArgv.path === "/calls?call=xyz";
if (!argvOk) bad++;
console.log(`  ${argvOk ? "✅" : "🔴"} argv scan → ${JSON.stringify(fromArgv && fromArgv.path)}`);
console.log(bad ? `🔴 ${bad} wrong` : "✅ bipli:// parsing correct");
process.exit(bad ? 1 : 0);
