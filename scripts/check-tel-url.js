const { telUrlToNumber, telFromArgv } = require("../src/tel-url");
const cases = [
  ["tel:+61400000000",                    "+61400000000"],
  ["TEL:+61400000000",                    "+61400000000"],
  ["tel:0400%20000%20000",                "0400000000"],
  ["tel:+61400000000;phone-context=+61",  "+61400000000"],
  ["tel:(04)%2000-000-000",               "0400000000"],
  ["tel:+61 400 000 000",                 "+61400000000"],
  ["tel:*61#",                            "*61#"],
  ["tel:",                                null],
  ["tel:%%%",                             null],
  ["https://bipli.com",                   null],
  ["",                                    null],
  [null,                                  null],
];
let bad = 0;
for (const [input, want] of cases) {
  const got = telUrlToNumber(input);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? "✅" : "🔴"} ${JSON.stringify(input).padEnd(36)} → ${JSON.stringify(got)}${ok ? "" : `  (want ${JSON.stringify(want)})`}`);
}
const argv = ["C:\\Program Files\\Bipli\\Bipli.exe", "--allow-file-access", "tel:+61399624443"];
const fromArgv = telFromArgv(argv);
const argvOk = fromArgv === "+61399624443";
if (!argvOk) bad++;
console.log(`  ${argvOk ? "✅" : "🔴"} argv scan → ${JSON.stringify(fromArgv)}`);
console.log(bad ? `🔴 ${bad} wrong` : "✅ tel: parsing correct");
process.exit(bad ? 1 : 0);
