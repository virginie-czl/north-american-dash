import { composeHtmlBody } from "./email-signature.ts";

const cases = [
  [
    "no signature — body still becomes HTML",
    "Hi,\nHope you're doing well!",
    null,
    "Hi,<br>\nHope you're doing well!",
  ],
  [
    "signature appended after two line breaks",
    "Hi,\nThanks!",
    "<div>Shayma Ndiaye<br>Naboo</div>",
    "Hi,<br>\nThanks!<br><br>\n<div>Shayma Ndiaye<br>Naboo</div>",
  ],
  [
    "body is escaped, signature is not",
    "Terms: A < B & C > D",
    "<b>Naboo</b> & co",
    "Terms: A &lt; B &amp; C &gt; D<br><br>\n<b>Naboo</b> & co",
  ],
  ["blank signature is treated as none", "Hi,\nThanks!", "   ", "Hi,<br>\nThanks!"],
  ["empty signature string is treated as none", "Hi,\nThanks!", "", "Hi,<br>\nThanks!"],
];

let pass = 0,
  fail = 0;
for (const [name, body, sig, expected] of cases) {
  const got = composeHtmlBody(body, sig);
  if (got === expected) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ expected:", JSON.stringify(expected), "got:", JSON.stringify(got));
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
