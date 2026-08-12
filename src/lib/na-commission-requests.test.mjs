import {
  partnerClawback,
  composeNaCommissionRequest,
  composeNaRefundRequest,
  composeNaCombinedRequest,
} from "./na-commission-requests.ts";

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

const row = {
  readable_id: "C-V176",
  company_name: "Creatify",
  start_date: "2026-05-01",
  end_date: "2026-05-03",
  billing_entity: "NABOO_CA",
};

/** An overpaid provider with priced lines behind its commission. */
const partner = (overrides = {}) => ({
  name: "Fairmont Waterfront",
  email: "mice@fairmont.com",
  contact_first_name: "Dana",
  currency: "CAD",
  is_provision: false,
  payable: 10000,
  paid: 11200,
  commission: 500,
  raw_outstanding: -1200,
  commissionable_base_ht: 5000,
  commissionable: [
    { label: "Meeting room", base_ht: 3000, rate_pct: 10 },
    { label: "Catering", base_ht: 2000, rate_pct: 10 },
  ],
  disbursements: [
    { amount: 6000, currency: "CAD", paid_on: "03/06/26", method: "wire", reference: "VIR-4471" },
    { amount: 5200, currency: "CAD", paid_on: "18/06/26", method: "card", reference: "CB-8890" },
  ],
  ...overrides,
});

// ── The split ──────────────────────────────────────────────────────────────
const split = partnerClawback(partner());
t("overpayment fills the commission first", split.commission === 500, JSON.stringify(split));
t("the rest is a refund", split.refund === 700, JSON.stringify(split));

// ── Commission-only email ──────────────────────────────────────────────────
const commissionOnly = composeNaCommissionRequest(
  row,
  partner({ raw_outstanding: -500, paid: 10500 }),
  { name: "Dana" },
);
t("commission email names the items", commissionOnly.body.includes("Meeting room, Catering"));
t("commission email gives the base", commissionOnly.body.includes("5,000.00 CAD"));
t("commission email gives the rate", commissionOnly.body.includes("Commission rate: 10%"));
t("commission email gives the amount", commissionOnly.body.includes("500.00 CAD"));

// ── Combined email: the one that used to send a bare figure ────────────────
const combined = composeNaCombinedRequest(row, partner(), { name: "Dana" });
t(
  "combined email names the items",
  combined.body.includes("Meeting room, Catering"),
  combined.body,
);
t("combined email gives the base", combined.body.includes("Commissionable base: 5,000.00 CAD"));
t("combined email gives the rate", combined.body.includes("Commission rate: 10%"));
t("combined email still gives the commission", combined.body.includes("Commission due incl. tax"));
t(
  "combined email lists each payment",
  combined.body.includes("VIR-4471") && combined.body.includes("CB-8890"),
);
t(
  "combined email states the invoice total",
  combined.body.includes("Total invoice due: 10,500.00 CAD"),
);
t("combined email states the refund", combined.body.includes("Refund due to Naboo: 700.00 CAD"));
t(
  "combined email totals both claims",
  combined.body.includes("Total to be paid to Naboo (commission + overpayment): 1,200.00 CAD"),
);

// ── Several rates on one provider ──────────────────────────────────────────
const twoRates = composeNaCombinedRequest(
  row,
  partner({
    commissionable: [
      { label: "Meeting room", base_ht: 3000, rate_pct: 10 },
      { label: "Catering", base_ht: 2000, rate_pct: 12 },
    ],
  }),
  { name: "Dana" },
);
t("both rates are shown", twoRates.body.includes("10% / 12%"), twoRates.body);

// ── No priced lines: never a bare figure ───────────────────────────────────
const bare = composeNaCommissionRequest(
  row,
  partner({ raw_outstanding: -500, commissionable: [], commissionable_base_ht: 0 }),
  { name: "Dana" },
);
t(
  "falls back to the invoice it is taken on",
  bare.body.includes("Total invoice due: 10,500.00 CAD"),
);

const bareCombined = composeNaCombinedRequest(
  row,
  partner({ commissionable: [], commissionable_base_ht: 0 }),
  { name: "Dana" },
);
t(
  "no duplicate invoice total in the combined email",
  bareCombined.body.split("Total invoice due").length - 1 === 1,
  bareCombined.body,
);

// ── The other two shapes ───────────────────────────────────────────────────
const refundOnly = composeNaRefundRequest(row, partner({ commission: 0 }), { name: "Dana" });
t("refund email carries no commission section", !refundOnly.body.includes("Commissionable"));
t(
  "nothing to claim gives no email",
  composeNaCommissionRequest(row, partner({ raw_outstanding: 0 }), { name: "Dana" }) === null,
);
t(
  "a provision line is never chased",
  partnerClawback(partner({ is_provision: true })).commission === 0,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
