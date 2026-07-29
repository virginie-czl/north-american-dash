import { buildTargets, composeRequest, needsOf, describeNeeds } from "./partner-requests.ts";

let pass = 0;
let fail = 0;
const t = (name, cond, got = "") => {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, got); }
};

const tax = (usable, gst = null, qst = null) => ({
  gst, qst, vat: null, unparsed: null, usable,
});
const act = (code, taxReg) => ({
  code, owner: "partner", scanUseful: true, label: "", detail: "", tax: taxReg,
});

// ─── needsOf ───────────────────────────────────────────────────────────────
console.log("\n[needsOf]");

t("nothing missing → null",
  needsOf(act("ours_pay", tax(true, "1RT1", "1TQ1")), "CA") === null);

const nBank = needsOf(act("ask_bank", tax(true, "121107726RT0001")), "CA");
t("bank only", nBank?.bank === true && nBank?.tax === false, JSON.stringify(nBank));

const nBoth = needsOf(act("ask_bank_and_tax", tax(false)), "CA");
t("bank + tax", nBoth?.bank === true && nBoth?.tax === true, JSON.stringify(nBoth));

const nTaxOnly = needsOf(act("ours_pay", tax(false)), "CA");
t("tax only when payment is settled", nTaxOnly?.tax === true && nTaxOnly?.bank === false, JSON.stringify(nTaxOnly));

// Under the presence rule, a GST alone counts as on file
const nGstOnly = needsOf(act("ours_pay", tax(true, "121107726RT0001")), "CA");
t("CA with GST only no longer needs tax", nGstOnly === null, JSON.stringify(nGstOnly));

// ─── buildTargets ──────────────────────────────────────────────────────────
console.log("\n[buildTargets]");

const partners = [
  { eventRef: "F-B516", eventDate: "2026-05-01", name: "Casino de Montréal",
    email: "compta@casino.ca", country: "CA", currency: "CAD", amountDue: 6657.16,
    action: act("ask_bank_and_tax", tax(false)) },
  { eventRef: "F-B517", eventDate: "2026-06-10", name: "Casino de Montréal",
    email: "compta@casino.ca", country: "CA", currency: "CAD", amountDue: 6148.18,
    action: act("ask_bank_and_tax", tax(false)) },
];
const targets = buildTargets(partners);
t("one target per booking (not grouped)", targets.length === 2, String(targets.length));
t("carries event date", targets[0].eventDate === "2026-05-01");
t("normalises address", targets[0].address === "compta@casino.ca");

const skipped = buildTargets([
  { eventRef: "A", eventDate: null, name: "No email", email: null, country: "CA",
    currency: "CAD", amountDue: 10, action: act("ask_bank", tax(false)) },
  { eventRef: "B", eventDate: null, name: "Cancelled", email: "x@y.ca", country: "CA",
    currency: "CAD", amountDue: 10, action: act("ask_bank", tax(false)), isCancelled: true },
  { eventRef: "C", eventDate: null, name: "Nothing missing", email: "ok@y.ca", country: "CA",
    currency: "CAD", amountDue: 0, action: act("settled", tax(true, "1RT1", "1TQ1")) },
]);
t("skips no-address, cancelled and complete", skipped.length === 0, JSON.stringify(skipped));

// ─── composeRequest: Shayma's templates ────────────────────────────────────
console.log("\n[templates]");

const bankOnly = composeRequest({
  address: "a@b.ca", partnerName: "Eventure", country: "CA",
  eventRef: "F-B694", eventDate: "2026-07-21", currency: "CAD", amountDue: 1506.18,
  needs: { bank: true, tax: false },
});
t("bank subject", bankOnly.subject === "Your payment from Naboo – F-B694", bankOnly.subject);
t("bank body has card offer first", bankOnly.body.includes("easiest way for us to pay you is by credit card"));
t("bank body lists the six fields",
  ["Bank name", "Account holder name", "Address", "Institution number", "Transit number", "Account number"]
    .every((f) => bankOnly.body.includes(f)));
t("bank body has no tax ask", !bankOnly.body.includes("tax number"));
t("bank body has event date", bankOnly.body.includes("July 21, 2026"), bankOnly.body.slice(0, 300));

const taxOnly = composeRequest({
  address: "a@b.ca", partnerName: "Eventure", country: "CA",
  eventRef: "F-B694", eventDate: "2026-07-21", currency: "CAD", amountDue: 0,
  needs: { bank: false, tax: true },
});
t("tax subject", taxOnly.subject === "Tax number request – F-B694", taxOnly.subject);
t("tax body asks GST/HST", taxOnly.body.includes("GST/HST and provincial if applicable"));
t("tax body has no bank fields", !taxOnly.body.includes("Institution number"));

const bothT = composeRequest({
  address: "a@b.ca", partnerName: "Eventure", country: "CA",
  eventRef: "F-B694", eventDate: "2026-07-21", currency: "CAD", amountDue: 1506.18,
  needs: { bank: true, tax: true },
});
t("combined subject uses payment wording", bothT.subject === "Your payment from Naboo – F-B694");
t("combined has bank fields", bothT.body.includes("Transit number"));
t("combined has tax ask", bothT.body.includes("GST/HST and provincial if applicable"));
t("combined has the Also connector", bothT.body.includes("Also, could you share your tax number"));

t("no signature in body (Gmail appends it)",
  !bothT.body.includes("Naboo — Finance") && bothT.body.trim().endsWith("Thanks so much!"),
  JSON.stringify(bothT.body.slice(-60)));

// ─── describeNeeds ─────────────────────────────────────────────────────────
console.log("\n[describeNeeds]");
t("both", describeNeeds({ bank: true, tax: true }) === "bank + tax");
t("bank", describeNeeds({ bank: true, tax: false }) === "bank details");
t("tax", describeNeeds({ bank: false, tax: true }) === "tax number");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
