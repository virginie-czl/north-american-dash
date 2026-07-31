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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
