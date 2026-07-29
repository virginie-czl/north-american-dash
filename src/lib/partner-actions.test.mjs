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
t("owes, bank in hand → Payout TBD", a6.code === "ours_pay" && a6.label === "Payout TBD" && a6.payableBy === "bank", JSON.stringify([a6.label, a6.payableBy]));

const a7 = decidePartnerAction(S({ outstanding: 5000, cardEverAccepted: true, taxRaw: registered }));
t("owes, card accepted before → payout by card", a7.code === "ours_pay" && a7.payableBy === "card", JSON.stringify([a7.label, a7.payableBy]));

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

// --- Slack approval as a card source ---
{
  let p = 0, f = 0;
  const t = (n, c, g = "") => { if (c) { p++; console.log("  ✓", n); } else { f++; console.log("  ✗", n, g); } };
  const S2 = (o = {}) => ({
    outstanding: 0, hasPo: true, country: "CA", taxRaw: null, taxIdentifier: null,
    bankDetails: "not_asked", taxAsked: false, contacted: false, replied: false,
    cardOnThisEvent: "unknown", cardEverAccepted: false, ...o,
  });
  const reg = "TPS 819512187RT0001 TVQ 1222113845TQ0001";

  const slackApproved = decidePartnerAction(S2({
    outstanding: 5000, taxRaw: reg, cardApprovedInSlack: true,
  }));
  t("Slack approval → payable by card, never ask IBAN",
    slackApproved.code === "card_to_debit" && slackApproved.payableBy === "card", JSON.stringify([slackApproved.label, slackApproved.payableBy]));
  t("label is Card created, service provider to debit",
    slackApproved.label === "Card created, service provider to debit", slackApproved.label);
  t("owner is the provider, not us", slackApproved.owner === "partner", slackApproved.owner);
  t("detail cites the Slack channel",
    slackApproved.detail.includes("finance-paiement-by-card"), slackApproved.detail);

  const noSlackNoEmail = decidePartnerAction(S2({ outstanding: 5000, taxRaw: reg }));
  t("without either source → ask for bank",
    noSlackNoEmail.code === "ask_bank", noSlackNoEmail.code);

  const slackNoTax = decidePartnerAction(S2({ outstanding: 5000, cardApprovedInSlack: true }));
  t("Slack approval but no tax → ask tax only",
    slackNoTax.code === "ask_tax", slackNoTax.code);
  t("and it does not ask for bank details",
    !slackNoTax.detail.toLowerCase().includes("bancaire"), slackNoTax.detail);

  console.log(`\n[slack card] ${p} passed, ${f} failed`);
  if (f) process.exitCode = 1;
}

// --- Payout TBD covers "not paid" and "partially paid" alike ---
{
  let p = 0, f = 0;
  const t = (n, c, g = "") => { if (c) { p++; console.log("  ✓", n); } else { f++; console.log("  ✗", n, g); } };
  const reg = "TPS 819512187RT0001 TVQ 1222113845TQ0001";
  const base = {
    hasPo: true, country: "CA", taxRaw: reg, taxIdentifier: null,
    taxAsked: false, contacted: false, replied: false,
    cardOnThisEvent: "unknown", cardEverAccepted: false,
  };

  // Nothing paid yet, bank details in hand
  const notPaid = decidePartnerAction({ ...base, outstanding: 5000, bankDetails: "received" });
  t("nothing paid + bank → Payout TBD", notPaid.label === "Payout TBD", notPaid.label);

  // Partially paid — still outstanding, so still ours
  const partial = decidePartnerAction({ ...base, outstanding: 1200, bankDetails: "received" });
  t("partially paid + bank → Payout TBD", partial.label === "Payout TBD", partial.label);

  // Card approved (issued) in Slack instead of bank — provider debits it themselves
  const byCard = decidePartnerAction({ ...base, outstanding: 5000, cardApprovedInSlack: true });
  t("card approved in Slack → Card created, service provider to debit",
    byCard.label === "Card created, service provider to debit" && byCard.payableBy === "card", byCard.label);

  // Card merely accepted before (no Pliant card actually issued) — still ours to action
  const cardKnownNotIssued = decidePartnerAction({ ...base, outstanding: 5000, cardEverAccepted: true });
  t("card known but not issued in Slack → still Payout TBD",
    cardKnownNotIssued.label === "Payout TBD" && cardKnownNotIssued.payableBy === "card", cardKnownNotIssued.label);

  // Fully paid → nothing to do, not a payout
  const settled = decidePartnerAction({ ...base, outstanding: 0, bankDetails: "received" });
  t("fully paid → settled, not Payout TBD", settled.code === "settled", settled.code);

  // Owed but no means to pay → still a chase, not a payout
  const noMeans = decidePartnerAction({ ...base, outstanding: 5000 });
  t("owed without bank or card → not Payout TBD", noMeans.label !== "Payout TBD", noMeans.label);

  console.log(`\n[payout] ${p} passed, ${f} failed`);
  if (f) process.exitCode = 1;
}
