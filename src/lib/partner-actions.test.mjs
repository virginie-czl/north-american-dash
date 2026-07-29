import { parseTaxRegistration, taxComplete, decidePartnerAction } from "./partner-actions.ts";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra); }
};

// --- Parsing real values seen in owners.vat_number ---
const a = parseTaxRegistration("121107726RT0001");
check("clean GST", a.gst === "121107726RT0001" && a.qst === null && a.usable);

const b = parseTaxRegistration("TPS/GST : 819512187RT0001 - TVQ/PST : 1222113845TQ0001");
check("labelled GST + QST", b.gst === "819512187RT0001" && b.qst === "1222113845TQ0001");

const c = parseTaxRegistration("7886 41132");
check("malformed → unparsed", !c.usable && c.unparsed === "7886 41132");

const d = parseTaxRegistration("");
check("empty string → nothing recorded", !d.usable && d.unparsed === null);

const e = parseTaxRegistration(null, "FR76300060001");
check("EU VAT from tax_identifier", e.vat === "FR76300060001" && e.usable);

check("CA needs both halves", taxComplete(b, "CA") === true);
check("CA with GST only is incomplete", taxComplete(a, "CA") === false);
check("non-CA with one id is complete", taxComplete(a, "GB") === true);

// --- Action decisions ---
const S = (o = {}) => ({
  outstanding: 0, hasPo: true, country: "CA", taxRaw: null, taxIdentifier: null,
  bankDetails: "not_asked", taxAsked: false, contacted: false, replied: false,
  cardOnThisEvent: "unknown", cardEverAccepted: false, ...o,
});

const paidRegistered = decidePartnerAction(S({
  taxRaw: "TPS 819512187RT0001 TVQ 1222113845TQ0001" }));
check("paid + registered → settled, no scan",
  paidRegistered.code === "settled" && !paidRegistered.scanUseful, JSON.stringify(paidRegistered.code));

const paidNoTaxNeverAsked = decidePartnerAction(S({}));
check("paid, tax never asked → ask tax, scan useful",
  paidNoTaxNeverAsked.code === "ask_tax" && paidNoTaxNeverAsked.scanUseful);

const paidTaxAsked = decidePartnerAction(S({ taxAsked: true }));
check("paid, tax already asked → ours to record, no scan",
  paidTaxAsked.code === "ours_record_tax" && !paidTaxAsked.scanUseful);

const paidTaxGarbage = decidePartnerAction(S({ taxRaw: "7886 41132" }));
check("paid, unreadable tax → ours to fix, no scan",
  paidTaxGarbage.code === "ours_record_tax" && !paidTaxGarbage.scanUseful);

const owesBankReceived = decidePartnerAction(S({
  outstanding: 5000, bankDetails: "received",
  taxRaw: "TPS 819512187RT0001 TVQ 1222113845TQ0001" }));
check("owes, bank in hand, registered → ours to pay, no scan",
  owesBankReceived.code === "ours_pay" && !owesBankReceived.scanUseful);

const owesCardEver = decidePartnerAction(S({
  outstanding: 5000, cardEverAccepted: true,
  taxRaw: "TPS 819512187RT0001 TVQ 1222113845TQ0001" }));
check("owes, took card before → pay by card, never ask IBAN",
  owesCardEver.code === "ours_pay" && owesCardEver.label.includes("carte"));

const owesNothingKnown = decidePartnerAction(S({ outstanding: 5000 }));
check("owes, nothing known → ask bank + tax, scan useful",
  owesNothingKnown.code === "ask_bank_and_tax" && owesNothingKnown.scanUseful);

const owesCardHistoryNoBank = decidePartnerAction(S({
  outstanding: 5000, cardEverAccepted: true }));
check("card history wins over asking for bank",
  owesCardHistoryNoBank.code !== "ask_bank" && owesCardHistoryNoBank.code !== "ask_bank_and_tax");

const owesAsked = decidePartnerAction(S({
  outstanding: 5000, bankDetails: "asked", contacted: true,
  taxRaw: "TPS 819512187RT0001 TVQ 1222113845TQ0001" }));
check("asked, no reply → waiting on partner, scan useful",
  owesAsked.code === "await_reply" && owesAsked.owner === "partner" && owesAsked.scanUseful);

const owesReplied = decidePartnerAction(S({
  outstanding: 5000, bankDetails: "asked", contacted: true, replied: true,
  taxRaw: "TPS 819512187RT0001 TVQ 1222113845TQ0001" }));
check("asked and replied → ours to process",
  owesReplied.code === "await_reply" && owesReplied.owner === "us");

const noPo = decidePartnerAction(S({ outstanding: 5000, hasPo: false }));
check("no PO → blocked, no scan",
  noPo.code === "blocked_no_po" && !noPo.scanUseful);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

// --- Regression: values actually present in owners.vat_number ---
// Eventure (F-B694): 8-digit BN + 5-digit suffix
const eventure = parseTaxRegistration("84861700RT00017 / 1217376285TQ00017");
t("8-digit GST with 5-digit suffix", eventure.gst === "84861700RT00017" && eventure.usable, JSON.stringify(eventure));
t("QST with 5-digit suffix", eventure.qst === "1217376285TQ00017", JSON.stringify(eventure));
t("CA complete with both", taxComplete(eventure, "CA"), JSON.stringify(eventure));

{
  let p2 = 0, f2 = 0;
  const t = (name, cond, got) => { if (cond) { p2++; console.log("  ✓", name); } else { f2++; console.log("  ✗", name, got); } };

  // Legitimate EU numbers written with spaces — previously flagged unreadable
  for (const v of ["FR32 904 443 462", "FR 93 602 036 444", "FR 28 331310748", "FR79 931224919"]) {
    const r = parseTaxRegistration(v);
    t(`EU VAT with spaces: ${v}`, r.usable && r.vat?.startsWith("FR"), JSON.stringify(r));
  }
  const es = parseTaxRegistration("ESB97894372");
  t("Spanish VAT with letter", es.usable && es.vat === "ESB97894372", JSON.stringify(es));

  // Placeholders mean "not filled in", not "invalid"
  for (const v of ["//", "-", "0", "/", "x", "X", "--", "  ", "N/A", "néant"]) {
    const r = parseTaxRegistration(v);
    t(`placeholder treated as empty: ${JSON.stringify(v)}`, !r.usable && r.unparsed === null, JSON.stringify(r));
  }

  // Genuinely wrong values must still be flagged
  for (const v of ["7886 41132", "13%"]) {
    const r = parseTaxRegistration(v);
    t(`still flagged unreadable: ${v}`, !r.usable && r.unparsed === v, JSON.stringify(r));
  }

  // Canadian formats keep working, with or without separators
  const ca = parseTaxRegistration("TPS/GST : 819512187RT0001 - TVQ/PST : 1222113845TQ0001");
  t("CA both halves", ca.gst === "819512187RT0001" && ca.qst === "1222113845TQ0001", JSON.stringify(ca));
  const caSp = parseTaxRegistration("1211 07726 RT 0001");
  t("CA GST with spaces", caSp.gst === "121107726RT0001", JSON.stringify(caSp));

  // Eventure (F-B694): 8-digit BN + 5-digit suffix — real format found in owners.vat_number
  const eventure = parseTaxRegistration("84861700RT00017 / 1217376285TQ00017");
  t("8-digit GST with 5-digit suffix", eventure.gst === "84861700RT00017" && eventure.usable, JSON.stringify(eventure));
  t("QST with 5-digit suffix", eventure.qst === "1217376285TQ00017", JSON.stringify(eventure));
  t("CA complete with both (Eventure)", taxComplete(eventure, "CA"), JSON.stringify(eventure));

  console.log(`\n[regression] ${p2} passed, ${f2} failed`);
  if (f2) process.exitCode = 1;
}
