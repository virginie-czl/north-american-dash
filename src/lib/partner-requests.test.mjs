import { buildTargets, composeRequest, needsOf, describeNeeds } from "./partner-requests.ts";

let pass = 0, fail = 0;
const t = (name, cond, got = "") => { if (cond) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name, got); } };

const tax = (usable, gst = null, qst = null) => ({ gst, qst, vat: null, unparsed: null, usable });
const act = (code, taxReg) => ({ code, owner: "partner", scanUseful: true, label: "", detail: "", tax: taxReg });

// needsOf
t("nothing missing → null",
  needsOf(act("ours_pay", tax(true, "1RT1", "1TQ1")), "CA") === null);
const nBank = needsOf(act("ask_bank", tax(true, "123456789RT0001", "1234567890TQ0001")), "CA");
t("bank only", nBank?.bank === true && nBank?.tax === false);
const nBoth = needsOf(act("ask_bank_and_tax", tax(false)), "CA");
t("bank + tax", nBoth?.bank === true && nBoth?.tax === true);
const nCard = needsOf(act("ask_card", tax(false)), "CA");
t("card proposal instead of bank", nCard?.card === true && nCard?.bank === false);
const nPartialCA = needsOf(act("ours_pay", tax(true, "123456789RT0001", null)), "CA");
t("CA with GST only still needs tax", nPartialCA?.tax === true && nPartialCA?.bank === false);

// Grouping: same provider on three bookings → ONE email
const targets = buildTargets([
  { eventRef: "F-B516", name: "Casino de Montréal", email: "compta@casino.ca", country: "CA",
    currency: "CAD", amountDue: 6657.16, action: act("ask_bank_and_tax", tax(false)) },
  { eventRef: "F-B517", name: "Casino de Montréal", email: "Compta@Casino.ca", country: "CA",
    currency: "CAD", amountDue: 6148.18, action: act("ask_bank_and_tax", tax(false)) },
  { eventRef: "F-B999", name: "Casino de Montréal", email: "compta@casino.ca", country: "CA",
    currency: "CAD", amountDue: 100, action: act("ask_tax", tax(false)) },
]);
t("one target per address", targets.length === 1, JSON.stringify(targets.length));
t("events aggregated", targets[0].events.length === 3);
t("amounts summed", Math.abs(targets[0].amounts.CAD - 12905.34) < 0.01, JSON.stringify(targets[0].amounts));
t("needs are the union", targets[0].needs.bank && targets[0].needs.tax);

// Skips
const skipped = buildTargets([
  { eventRef: "A", name: "No email", email: null, country: "CA", currency: "CAD", amountDue: 10, action: act("ask_bank", tax(false)) },
  { eventRef: "B", name: "Cancelled", email: "x@y.ca", country: "CA", currency: "CAD", amountDue: 10, action: act("ask_bank", tax(false)), isCancelled: true },
  { eventRef: "C", name: "Nothing missing", email: "ok@y.ca", country: "CA", currency: "CAD", amountDue: 0, action: act("settled", tax(true, "1RT1", "1TQ1")) },
]);
t("skips missing address, cancelled and complete", skipped.length === 0, JSON.stringify(skipped));

// Composition
const fr = composeRequest(targets[0], "Shayma Ndiaye");
t("FR subject lists both refs", fr.subject.includes("F-B516") && fr.subject.includes("F-B517"));
t("FR body asks bank and CA taxes", fr.body.includes("coordonnées bancaires") && fr.body.includes("TPS/GST") && fr.body.includes("TVQ"));
// toLocaleString uses a narrow no-break space, so normalise before comparing.
const norm = (x) => x.replace(/[\s\u00a0\u202f]+/g, " ");
t("FR body shows summed amount", norm(fr.body).includes("12 905,34 CAD"), norm(fr.body));
t("signature present", fr.body.includes("Shayma Ndiaye"));

const gb = composeRequest({
  address: "a@b.co.uk", partnerName: "Lois Freestone", country: "GB", events: ["F-B668"],
  amounts: { GBP: 17820 }, needs: { bank: true, tax: true, card: false },
}, null);
t("non-francophone gets English", gb.body.includes("bank details") && gb.subject.includes("missing details"));
t("no CA tax wording outside CA", !gb.body.includes("TVQ"));

const cardOnly = composeRequest({
  address: "c@d.ca", partnerName: "Repeat", country: "CA", events: ["X"],
  amounts: { CAD: 500 }, needs: { bank: false, tax: false, card: true },
}, null);
t("card target never asks for IBAN", !cardOnly.body.includes("IBAN") && cardOnly.body.includes("carte"));

t("describeNeeds readable", describeNeeds({ bank: true, tax: true, card: false }) === "coordonnées bancaires + numéros de taxes");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
