import { readFileSync } from "node:fs";
import { emEmail, emContact, FINANCE_MAILBOX } from "./em-email.ts";

let pass = 0,
  fail = 0;
const t = (name, cond, got = "") => {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, got);
  }
};

console.log("\n[emEmail — the plain case]");
t("first and last", emEmail("Christian Bonadio") === "christian.bonadio@naboo.app");
t("case is irrelevant", emEmail("EMILY OSEI") === "emily.osei@naboo.app");
t("stray spacing is irrelevant", emEmail("  Emily   Osei  ") === "emily.osei@naboo.app");

console.log("\n[emEmail — compound surnames]");
t(
  "every word after the first, run together",
  emEmail("Astrid Isle de Beauchaine") === "astrid.isledebeauchaine@naboo.app",
  emEmail("Astrid Isle de Beauchaine"),
);
t("two-word surname", emEmail("Marie Du Pont") === "marie.dupont@naboo.app");

console.log("\n[emEmail — accents and hyphens]");
t("accents are dropped", emEmail("Eugénie Deschamps") === "eugenie.deschamps@naboo.app");
t("real NA name with an accent", emEmail("Léonie Roullier") === "leonie.roullier@naboo.app");
t("hyphens survive", emEmail("Anne-Marie Dupont") === "anne-marie.dupont@naboo.app");
t("hyphen in the surname survives", emEmail("Paul Martin-Roy") === "paul.martin-roy@naboo.app");
t("apostrophes go", emEmail("Sean O'Brien") === "sean.obrien@naboo.app");
t("cedillas and tildes", emEmail("François Núñez") === "francois.nunez@naboo.app");

console.log("\n[emEmail — shared mailboxes are named, not derived]");
t("Support Naboo", emEmail("Support Naboo") === "support@naboo.app");
t("case-insensitive", emEmail("support naboo") === "support@naboo.app");
t("a single-word team label still resolves", emEmail("Support") === "support@naboo.app");

console.log("\n[emEmail — not a usable pair]");
t("null", emEmail(null) === null);
t("empty", emEmail("   ") === null);
t("one word is not a pair", emEmail("Christian") === null);
t("a placeholder is not a name", emEmail("N/A") === null);
t("placeholder words are ignored, leaving no pair", emEmail("Christian -") === null);
t(
  "punctuation-only surname yields nothing",
  emEmail("Christian ...") === null,
  emEmail("Christian ..."),
);

console.log("\n[emContact]");
{
  const c = emContact("Christian Bonadio");
  t(
    "names the person",
    c.email === "christian.bonadio@naboo.app" && c.name === "Christian Bonadio",
  );
  t("marked as derived", c.derived === true);

  const shared = emContact("Support Naboo");
  t(
    "shared mailbox has no person to name",
    shared.email === "support@naboo.app" && shared.name === null,
  );

  const missing = emContact("Christian");
  t("falls back to finance", missing.email === FINANCE_MAILBOX && missing.derived === false);
  t("and names nobody", missing.name === null);

  const none = emContact(null);
  t("no manager at all falls back too", none.email === FINANCE_MAILBOX && none.derived === false);
}

// ── The copy on a recovery email ────────────────────────────────────────────
// The manager who owns the booking is copied on every recovery ask, derived exactly
// the way the client statement derives who to write to — with one difference, pinned
// below: a fallback to finance@ is right for a statement footnote and pointless as a
// copy, because finance is who sends these.
console.log("\n[the recovery copy]");
{
  const page = readFileSync(
    new URL("../routes/_authenticated/tracking-north-america.tsx", import.meta.url),
    "utf8",
  );
  t(
    "the page derives it from the manager",
    /const contact = emContact\(r\.em_referent\)/.test(page),
  );
  t("and only when it is a real mailbox", /contact\.derived \? contact\.email : null/.test(page));
  t("the partner ask carries it", /cc: ccFor\(plan\.row\)/.test(page));
  t("the client ask carries it too", /cc: ccFor\(r\)/.test(page));

  const gmail = readFileSync(new URL("./gmail.server.ts", import.meta.url), "utf8");
  // Cc, not Bcc: the counterparty should see who else is on the thread.
  t("the header is a visible copy", /\[`Cc: \$\{cc\}`\]/.test(gmail));
  t("and only when there is one", /\.\.\.\(cc \? \[`Cc: /.test(gmail));
  t(
    "both the draft and the send carry it",
    (gmail.match(/buildMime\(to, subject, composeHtmlBody\(body, signature\), cc\)/g) ?? [])
      .length === 2,
  );

  const fns = readFileSync(new URL("./gmail.functions.ts", import.meta.url), "utf8");
  t("a copy that is not an address is dropped", /rawCc\.includes\("@"\)/.test(fns));
  t("more than one is dropped", /!\/\[,;\]\/\.test\(rawCc\)/.test(fns));
  t(
    "and so is a copy of the recipient",
    /rawCc\.toLowerCase\(\) !== to\.toLowerCase\(\)/.test(fns),
  );
  // Only the server knows who is sending, so that is where a self-copy is dropped.
  t(
    "nobody is copied on their own email",
    /message\.cc\.toLowerCase\(\) !== session\.email\.toLowerCase\(\)/.test(fns),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
