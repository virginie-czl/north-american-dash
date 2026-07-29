import {
  parseTaxRegistration,
  taxComplete,
  missingQstForCanada,
  decidePartnerAction,
} from "./partner-actions.ts";

let pass = 0;
let fail = 0;
const t = (name, cond, got = "") => {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, got);
  }
};

// ─── Parsing ───────────────────────────────────────────────────────────────
console.log("\n[parsing]");

const cleanGst = parseTaxRegistration("121107726RT0001");
t("clean 9-digit GST", cleanGst.gst === "121107726RT0001" && cleanGst.usable);

const both = parseTaxRegistration("TPS/GST : 819512187RT0001 - TVQ/PST : 1222113845TQ0001");
t("labelled GST + QST", both.gst === "819512187RT0001" && both.qst === "1222113845TQ0001");

// Eventure (F-B694): 8-digit BN, 5-digit suffix — real value from owners.vat_number
const eventure = parseTaxRegistration("84861700RT00017 / 1217376285TQ00017");
t("8-digit GST accepted", eventure.gst?.startsWith("84861700RT") === true, JSON.stringify(eventure));
t("QST alongside it", eventure.qst?.startsWith("1217376285TQ") === true, JSON.stringify(eventure));

const euSpaces = parseTaxRegistration("FR32 904 443 462");
t("EU VAT with spaces", euSpaces.usable && euSpaces.vat === "FR32904443462");

const esLetter = parseTaxRegistration("ESB97894372");
t("Spanish VAT with letter", esLetter.vat === "ESB97894372");

// ─── Presence rule: digits mean we hold a number ───────────────────────────
console.log("\n[presence rule]");

for (const v of ["7886 41132", "13%", "00260390828", "00609737", "641950233"]) {
  const r = parseTaxRegistration(v);
  t(`digits → on file: ${JSON.stringify(v)}`, r.usable, JSON.stringify(r));
}

for (const v of ["0", "00", "000", "0000", "00000", "0000000000000000000"]) {
  const r = parseTaxRegistration(v);
  t(`all zeros → not on file: ${JSON.stringify(v)}`, !r.usable, JSON.stringify(r));
}

for (const v of ["//", "-", "/", "x", "X", "--", "  ", "N/A", "néant", '"non applicable"', ""]) {
  const r = parseTaxRegistration(v);
  t(`placeholder → not on file: ${JSON.stringify(v)}`, !r.usable, JSON.stringify(r));
}

// ─── Completeness ──────────────────────────────────────────────────────────
console.log("\n[completeness]");

t("CA with both halves is complete", taxComplete(both, "CA") === true);
t("CA with GST only also counts", taxComplete(cleanGst, "CA") === true);
t("missingQstForCanada flags the gap", missingQstForCanada(cleanGst, "CA") === true);
t("no QST flag outside CA", missingQstForCanada(cleanGst, "GB") === false);
t("no QST flag when both present", missingQstForCanada(both, "CA") === false);
t("nothing on file is not complete", taxComplete(parseTaxRegistration("//"), "CA") === false);

// ─── Action decisions ──────────────────────────────────────────────────────
console.log("\n[actions]");

const S = (o = {}) => ({
  outstanding: 0,
  hasPo: true,
  country: "CA",
  taxRaw: null,
  taxIdentifier: null,
  bankDetails: "not_asked",
  taxAsked: false,
  contacted: false,
  replied: false,
  cardOnThisEvent: "unknown",
  cardEverAccepted: false,
  ...o,
});

const registered = "TPS 819512187RT0001 TVQ 1222113845TQ0001";

const a1 = decidePartnerAction(S({ taxRaw: registered }));
t("paid + registered → settled, no scan", a1.code === "settled" && !a1.scanUseful, a1.code);

const a2 = decidePartnerAction(S({}));
t("paid, nothing on file → ask tax", a2.code === "ask_tax" && a2.scanUseful, a2.code);

const a3 = decidePartnerAction(S({ taxAsked: true }));
t("paid, already asked → ours to record", a3.code === "ours_record_tax" && !a3.scanUseful, a3.code);

const a4 = decidePartnerAction(S({ taxRaw: "7886 41132" }));
t("paid, odd format with digits → settled", a4.code === "settled" && !a4.scanUseful, a4.code);

const a5 = decidePartnerAction(S({ taxRaw: "0000" }));
t("paid, zeros only → still ask tax", a5.code === "ask_tax", a5.code);

const a6 = decidePartnerAction(S({ outstanding: 5000, bankDetails: "received", taxRaw: registered }));
t("owes, bank in hand → ours to pay", a6.code === "ours_pay" && !a6.scanUseful, a6.code);

const a7 = decidePartnerAction(S({ outstanding: 5000, cardEverAccepted: true, taxRaw: registered }));
t("owes, card accepted before → pay by card", a7.code === "ours_pay" && a7.label.includes("carte"), a7.label);

const a8 = decidePartnerAction(S({ outstanding: 5000 }));
t("owes, nothing known → ask bank + tax", a8.code === "ask_bank_and_tax" && a8.scanUseful, a8.code);

const a9 = decidePartnerAction(S({ outstanding: 5000, cardEverAccepted: true }));
t("card history beats asking for IBAN", a9.code !== "ask_bank" && a9.code !== "ask_bank_and_tax", a9.code);

const a10 = decidePartnerAction(S({
  outstanding: 5000, bankDetails: "asked", contacted: true, taxRaw: registered,
}));
t("asked, no reply → waiting on partner", a10.code === "await_reply" && a10.owner === "partner", a10.code);

const a11 = decidePartnerAction(S({
  outstanding: 5000, bankDetails: "asked", contacted: true, replied: true, taxRaw: registered,
}));
t("asked and replied → ours to process", a11.code === "await_reply" && a11.owner === "us", a11.owner);

const a12 = decidePartnerAction(S({ outstanding: 5000, hasPo: false }));
t("no PO → blocked, no scan", a12.code === "blocked_no_po" && !a12.scanUseful, a12.code);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
