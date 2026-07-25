import { extractFacts } from "./email-facts.ts";
const ME = "shayma.ndiaye@naboo.app";
const cases = [
  ["ask bank + tax, no reply", [
    { outbound: true, at: "2026-04-10T09:00:00Z", from: ME, subject: "Naboo — F-B694 paiement",
      body: "Bonjour, pourriez-vous nous transmettre vos coordonnées bancaires ainsi que votre numéro de TPS/TVQ ?" },
  ], { bankDetails: "asked", taxInfo: "asked", cardPayment: "unknown", repliedAt: null }],

  ["partner replies with IBAN", [
    { outbound: true, at: "2026-04-10T09:00:00Z", from: ME, subject: "F-B694", body: "Vos coordonnées bancaires SVP" },
    { outbound: false, at: "2026-04-12T10:00:00Z", from: "compta@traiteur.ca", subject: "Re: F-B694",
      body: "Bonjour, voici notre IBAN : FR76 3000 6000 0112 3456 7890 189. Cordialement." },
  ], { bankDetails: "received", taxInfo: "not_asked", repliedAt: "2026-04-12T10:00:00Z" }],

  ["canadian bank coordinates", [
    { outbound: true, at: "2026-04-01T09:00:00Z", from: ME, subject: "x", body: "banking details please" },
    { outbound: false, at: "2026-04-02T09:00:00Z", from: "a@b.ca", subject: "Re",
      body: "Transit: 12345 Institution 004 Account number 7654321" },
  ], { bankDetails: "received" }],

  ["GST/TVQ numbers received", [
    { outbound: false, at: "2026-04-03T09:00:00Z", from: "a@b.ca", subject: "Facture",
      body: "TPS 123456789 RT0001 / TVQ 1234567890 TQ0001" },
  ], { taxInfo: "received" }],

  ["card refused", [
    { outbound: false, at: "2026-04-05T09:00:00Z", from: "a@b.ca", subject: "Re",
      body: "Malheureusement nous n'acceptons pas la carte, virement uniquement." },
  ], { cardPayment: "refused" }],

  ["card accepted", [
    { outbound: false, at: "2026-04-05T09:00:00Z", from: "a@b.ca", subject: "Re",
      body: "Oui, le paiement par carte de crédit nous convient très bien." },
  ], { cardPayment: "accepted" }],

  ["refusal wins in mixed sentence", [
    { outbound: false, at: "2026-04-05T09:00:00Z", from: "a@b.ca", subject: "Re",
      body: "Le paiement par carte serait possible mais malheureusement nous n'acceptons pas la carte cette année." },
  ], { cardPayment: "refused" }],

  ["attachment RIB counts", [
    { outbound: false, at: "2026-04-06T09:00:00Z", from: "a@b.ca", subject: "Doc", body: "Ci-joint.",
      attachmentNames: ["RIB_Traiteur.pdf"] },
  ], { bankDetails: "received" }],

  ["contacted attribution and dates", [
    { outbound: true, at: "2026-04-10T09:00:00Z", from: "virginie@naboo.app", subject: "s", body: "coordonnées bancaires" },
    { outbound: true, at: "2026-04-14T09:00:00Z", from: ME, subject: "s", body: "relance" },
  ], { contactedBy: ME, bankAskedBy: "virginie@naboo.app" }],

  ["no signals at all", [
    { outbound: true, at: "2026-04-10T09:00:00Z", from: ME, subject: "Bonjour", body: "Merci pour l'événement !" },
  ], { bankDetails: "not_asked", taxInfo: "not_asked", cardPayment: "unknown" }],
];

let pass = 0, fail = 0;
for (const [name, msgs, expect] of cases) {
  const got = extractFacts(msgs, ME);
  const bad = Object.entries(expect).filter(([k, v]) => got[k] !== v);
  if (bad.length === 0) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, "→", bad.map(([k, v]) => `${k}: expected ${v}, got ${got[k]}`).join("; ")); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
