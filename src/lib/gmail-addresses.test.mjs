import { sanitizeAddressList } from "./gmail.functions.ts";

let pass = 0,
  fail = 0;
const t = (name, cond, got = "") => {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, JSON.stringify(got));
  }
};

const cases = [
  ["a plain address survives", "emily.osei@naboo.app", "emily.osei@naboo.app"],
  ["surrounding space is trimmed", "  emily.osei@naboo.app  ", "emily.osei@naboo.app"],
  [
    "several addresses stay comma separated",
    "emily.osei@naboo.app,julia.ranc@naboo.app",
    "emily.osei@naboo.app, julia.ranc@naboo.app",
  ],
  ["a name without an address is dropped", "Emily Osei", ""],
  ["an empty value stays empty", "", ""],
  ["a domain with no dot is refused", "emily@localhost", ""],
  // The reason this function exists: the value ends up in a MIME header.
  ["a newline cannot smuggle a header", "a@naboo.app\r\nBcc: leak@evil.com", ""],
  ["a bare newline is refused too", "a@naboo.app\nBcc: leak@evil.com", ""],
  ["angle brackets are refused", "<a@naboo.app>", ""],
  [
    "a good address survives a bad neighbour",
    "Emily Osei,julia.ranc@naboo.app",
    "julia.ranc@naboo.app",
  ],
];

for (const [name, input, expected] of cases) {
  const got = sanitizeAddressList(input);
  t(name, got === expected, got);
}

const many = Array.from({ length: 9 }, (_, i) => `em${i}@naboo.app`).join(",");
t("the copy line is capped", sanitizeAddressList(many).split(",").length === 5);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
