import {
  buildTargets,
  composeRequest,
  needsOf,
  missingOf,
  describeNeeds,
} from "./partner-requests.ts";
import { decidePartnerAction } from "./partner-actions.ts";

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

const tax = (usable, gst = null, qst = null) => ({
  gst,
  qst,
  vat: null,
  unparsed: null,
  usable,
});

/**
 * Actions come from the real decision tree rather than hand-built objects: what
 * is left to ask depends on what the tree knows about the ask, and a test that
 * invents the pair cannot catch them disagreeing.
 */
const A = (over) =>
  decidePartnerAction({
    outstanding: 1000,
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
    ...over,
  });

const act = (code, taxReg, pending = { bank: false, tax: false }) => ({
  code,
  owner: "partner",
  scanUseful: true,
  label: "",
  detail: "",
  tax: taxReg,
  pending,
});

// ─── needsOf: what is left to ASK ──────────────────────────────────────────
console.log("\n[needsOf]");

t(
  "nothing to ask when we hold everything",
  needsOf(A({ bankDetails: "received", taxRaw: "121107726RT0001" })) === null,
);

const nNew = needsOf(A({}));
t("never asked → bank + tax", nNew?.bank === true && nNew?.tax === true, JSON.stringify(nNew));

const nAfterBank = needsOf(A({ bankDetails: "asked" }));
t(
  "bank already requested → only the tax number is left to ask",
  nAfterBank?.bank === false && nAfterBank?.tax === true,
  JSON.stringify(nAfterBank),
);
t(
  "and the label says so, rather than asking for the bank again",
  A({ bankDetails: "asked" }).code === "ask_tax",
  A({ bankDetails: "asked" }).code,
);

// The regression this file exists for. A partner asked for both, on a Monday,
// was still on the ask list on the Tuesday — and got the same email again.
t(
  "a partner already asked for everything is not asked again",
  needsOf(A({ bankDetails: "asked", taxAsked: true })) === null,
  JSON.stringify(needsOf(A({ bankDetails: "asked", taxAsked: true }))),
);
t(
  "they are waiting on a reply instead",
  A({ bankDetails: "asked", taxAsked: true }).code === "await_reply",
);

// F-B802: asked on 17 August, answered "I don't have one" the same hour. The
// number is never going to arrive, and the ask must not repeat every batch.
t(
  "a tax number that will never arrive is asked for once",
  needsOf(A({ bankDetails: "asked", taxAsked: true, replied: true })) === null,
);

t(
  "a partner payable by card is never asked for an IBAN",
  needsOf(A({ cardEverAccepted: true, taxRaw: "121107726RT0001" })) === null,
);
t(
  "nothing is asked before the PO lands",
  needsOf(A({ hasPo: false, taxRaw: "121107726RT0001" })) === null,
);
t(
  "a settled partner is not chased for anything",
  needsOf(A({ outstanding: 0, taxRaw: "121107726RT0001" })) === null,
);

// ─── missingOf: what we do not HOLD ────────────────────────────────────────
console.log("\n[missingOf]");

const mAsked = missingOf(A({ bankDetails: "asked", taxAsked: true }), "CA");
t(
  "asked and unanswered still counts as missing — that is what a reminder is for",
  mAsked?.bank === true && mAsked?.tax === true,
  JSON.stringify(mAsked),
);
t(
  "nothing is missing once both are in hand",
  missingOf(A({ bankDetails: "received", taxRaw: "121107726RT0001" }), "CA") === null,
);
// Under the presence rule, a GST alone counts as on file.
t(
  "CA with GST only no longer needs tax",
  missingOf(act("ours_pay", tax(true, "121107726RT0001")), "CA") === null,
);
t("tax only when payment is settled", missingOf(act("ours_pay", tax(false)), "CA")?.tax === true);

// ─── buildTargets ──────────────────────────────────────────────────────────
console.log("\n[buildTargets]");

const partners = [
  {
    eventRef: "F-B516",
    eventDate: "2026-05-01",
    name: "Casino de Montréal",
    email: "compta@casino.ca",
    country: "CA",
    currency: "CAD",
    amountDue: 6657.16,
    action: act("ask_bank_and_tax", tax(false), { bank: true, tax: true }),
  },
  {
    eventRef: "F-B517",
    eventDate: "2026-06-10",
    name: "Casino de Montréal",
    email: "compta@casino.ca",
    country: "CA",
    currency: "CAD",
    amountDue: 6148.18,
    action: act("ask_bank_and_tax", tax(false), { bank: true, tax: true }),
  },
];
const targets = buildTargets(partners);
t("one target per booking (not grouped)", targets.length === 2, String(targets.length));
t("carries event date", targets[0].eventDate === "2026-05-01");
t("normalises address", targets[0].address === "compta@casino.ca");

const skipped = buildTargets([
  {
    eventRef: "A",
    eventDate: null,
    name: "No email",
    email: null,
    country: "CA",
    currency: "CAD",
    amountDue: 10,
    action: act("ask_bank", tax(false), { bank: true, tax: false }),
  },
  {
    eventRef: "B",
    eventDate: null,
    name: "Cancelled",
    email: "x@y.ca",
    country: "CA",
    currency: "CAD",
    amountDue: 10,
    action: act("ask_bank", tax(false), { bank: true, tax: false }),
    isCancelled: true,
  },
  {
    eventRef: "C",
    eventDate: null,
    name: "Nothing missing",
    email: "ok@y.ca",
    country: "CA",
    currency: "CAD",
    amountDue: 0,
    action: act("settled", tax(true, "1RT1", "1TQ1")),
  },
]);
t("skips no-address, cancelled and complete", skipped.length === 0, JSON.stringify(skipped));

// The two modes: a first ask, and a reminder to someone who has gone quiet.
const asked = [
  {
    eventRef: "F-B802",
    eventDate: "2026-08-22",
    name: "Laura Scavo",
    email: "laurascavo1@gmail.com",
    country: "CA",
    currency: "CAD",
    amountDue: 400,
    action: A({ bankDetails: "asked", taxAsked: true }),
  },
];
t("a partner already asked is not in the new-ask batch", buildTargets(asked).length === 0);
const reminders = buildTargets(asked, "reminder");
t("but can be reminded", reminders.length === 1, JSON.stringify(reminders));
t(
  "and the reminder asks for what is still not here",
  reminders[0]?.needs.bank === true && reminders[0]?.needs.tax === true,
  JSON.stringify(reminders[0]?.needs),
);

// ─── composeRequest: Shayma's templates ────────────────────────────────────
console.log("\n[templates]");

const bankOnly = composeRequest({
  address: "a@b.ca",
  partnerName: "Eventure",
  country: "CA",
  eventRef: "F-B694",
  eventDate: "2026-07-21",
  currency: "CAD",
  amountDue: 1506.18,
  needs: { bank: true, tax: false },
});
t("bank subject", bankOnly.subject === "Your payment from Naboo – F-B694", bankOnly.subject);
t(
  "bank body has card offer first",
  bankOnly.body.includes("easiest way for us to pay you is by credit card"),
);
t(
  "bank body lists the six fields",
  [
    "Bank name",
    "Account holder name",
    "Address",
    "Institution number",
    "Transit number",
    "Account number",
  ].every((f) => bankOnly.body.includes(f)),
);
t("bank body has no tax ask", !bankOnly.body.includes("tax number"));
t("bank body has event date", bankOnly.body.includes("July 21, 2026"), bankOnly.body.slice(0, 300));

const taxOnly = composeRequest({
  address: "a@b.ca",
  partnerName: "Eventure",
  country: "CA",
  eventRef: "F-B694",
  eventDate: "2026-07-21",
  currency: "CAD",
  amountDue: 0,
  needs: { bank: false, tax: true },
});
t("tax subject", taxOnly.subject === "Tax number request – F-B694", taxOnly.subject);
t("tax body asks GST/HST", taxOnly.body.includes("GST/HST and provincial if applicable"));
t("tax body has no bank fields", !taxOnly.body.includes("Institution number"));

const bothT = composeRequest({
  address: "a@b.ca",
  partnerName: "Eventure",
  country: "CA",
  eventRef: "F-B694",
  eventDate: "2026-07-21",
  currency: "CAD",
  amountDue: 1506.18,
  needs: { bank: true, tax: true },
});
t("combined subject uses payment wording", bothT.subject === "Your payment from Naboo – F-B694");
t("combined has bank fields", bothT.body.includes("Transit number"));
t("combined has tax ask", bothT.body.includes("GST/HST and provincial if applicable"));
t("combined has the Also connector", bothT.body.includes("Also, could you share your tax number"));

t(
  "no signature in body (Gmail appends it)",
  !bothT.body.includes("Naboo — Finance") && bothT.body.trim().endsWith("Thanks so much!"),
  JSON.stringify(bothT.body.slice(-60)),
);

// ─── describeNeeds ─────────────────────────────────────────────────────────
console.log("\n[describeNeeds]");
t("both", describeNeeds({ bank: true, tax: true }) === "bank + tax");
t("bank", describeNeeds({ bank: true, tax: false }) === "bank details");
t("tax", describeNeeds({ bank: false, tax: true }) === "tax number");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
