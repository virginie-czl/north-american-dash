import {
  partnerClawback,
  partnerRecoveryAsk,
  rowClawbackSplit,
  naContactFor,
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

const partner = (overrides = {}) => ({
  name: "Renaissance Hotel Dallas",
  email: "lindsay@renaissancehotels.com",
  contact_first_name: null,
  currency: "USD",
  gmv_ttc: 1000,
  paid: 1000,
  outstanding: 0,
  raw_outstanding: 0,
  payable: 800,
  commission: 100,
  locked: false,
  locked_by_admin: false,
  locked_by_client: false,
  locked_by_owner: false,
  is_provision: false,
  payment_method: null,
  ...overrides,
});

const row = {
  readable_id: "C-V885",
  client_request_id: "abc123",
  company_name: "InterSolutions",
  sales_referent: "Leo Chiasson",
  em_referent: null,
  days_before_start: 203,
  currency_client: "USD",
  event_name: "C-V885 / InterSolutions",
  start_date: "2027-02-17",
  end_date: "2027-02-19",
  event_type: "NIGHTLY_TRIP",
  participants: 220,
  billing_entity: "NABOO_US",
  booking_url: null,
  gmv_client_ccy: 226176.6,
  gmv_client_eur: null,
  invoiced_ccy: null,
  paid_ccy: 0,
  balance_ccy: 226176.6,
  partners_json: null,
};

// ── partnerClawback ─────────────────────────────────────────────────────────
console.log("\n[partnerClawback]");

t(
  "not overpaid → zero/zero",
  partnerClawback(partner({ raw_outstanding: 0 })).commission === 0 &&
    partnerClawback(partner({ raw_outstanding: 0 })).refund === 0,
);

t(
  "overpaid less than commission → all commission, no refund",
  (() => {
    const cb = partnerClawback(partner({ raw_outstanding: -50, commission: 100 }));
    return cb.commission === 50 && cb.refund === 0;
  })(),
);

t(
  "overpaid more than commission → commission capped, remainder is refund",
  (() => {
    const cb = partnerClawback(partner({ raw_outstanding: -150, commission: 100 }));
    return cb.commission === 100 && cb.refund === 50;
  })(),
);

t(
  "provision line → always zero/zero even if raw_outstanding negative",
  partnerClawback(partner({ raw_outstanding: -500, commission: 100, is_provision: true }))
    .commission === 0,
);

// ── partnerRecoveryAsk ──────────────────────────────────────────────────────
console.log("\n[partnerRecoveryAsk]");

t("nothing to claw back → no ask", partnerRecoveryAsk(partner({ raw_outstanding: 0 })) === null);

t(
  "overpaid within our commission → ask for the commission",
  partnerRecoveryAsk(partner({ raw_outstanding: -50, commission: 100 })) === "commission",
);

t(
  "overpaid beyond our commission → the refund is the ask",
  partnerRecoveryAsk(partner({ raw_outstanding: -150, commission: 100 })) === "refund",
);

// The Double Tree case: paid 9 999,37 against 7 148,38 payable to date, leaving
// 2 756,49 to recover beyond commission. Nothing more is owed to the provider, so
// the action tree calls the line settled — the ask has to survive that.
t(
  "a line the action tree calls settled still carries its refund ask",
  partnerRecoveryAsk(
    partner({ raw_outstanding: -2756.49, commission: 0, outstanding: -2851, paid: 9999.37 }),
  ) === "refund",
);

t(
  "paid ahead of client invoicing is not an ask",
  partnerRecoveryAsk(partner({ raw_outstanding: 500, outstanding: -1200 })) === null,
);

t(
  "provision line is never an ask",
  partnerRecoveryAsk(partner({ raw_outstanding: -500, commission: 100, is_provision: true })) ===
    null,
);

// ── rowClawbackSplit (display roll-up only — emails no longer aggregate) ────
console.log("\n[rowClawbackSplit]");

const split = rowClawbackSplit([
  partner({ raw_outstanding: -150, commission: 100, currency: "USD" }),
  partner({ raw_outstanding: -30, commission: 100, currency: "USD" }),
]);
t(
  "commission sums across partners in the same currency",
  split.commission.get("USD") === 130,
  JSON.stringify([...split.commission]),
);
t(
  "refund sums across partners in the same currency",
  split.refund.get("USD") === 50,
  JSON.stringify([...split.refund]),
);

// ── naContactFor ─────────────────────────────────────────────────────────────
console.log("\n[naContactFor]");

const c = naContactFor(partner({ name: "Lindsay McIlroy" }));
t(
  "falls back to venue name's first word when no contact_first_name",
  c.address === "lindsay@renaissancehotels.com" && c.name === "Lindsay",
);

const noContact = naContactFor(partner({ email: null }));
t("returns null address when none found", noContact.address === null);

t(
  "prefers owners.firstname over the venue name when present",
  naContactFor(partner({ name: "Renaissance Hotel Dallas", contact_first_name: "Amélie" })).name ===
    "Amélie",
);

// ── composeNaCommissionRequest (single partner) ─────────────────────────────
console.log("\n[composeNaCommissionRequest]");

t(
  "null when this partner was not overpaid",
  composeNaCommissionRequest(row, partner({ raw_outstanding: 0 }), c) === null,
);

const commOnlyPartner = partner({ raw_outstanding: -50, commission: 100 });
const commissionOnly = composeNaCommissionRequest(
  row,
  commOnlyPartner,
  naContactFor(commOnlyPartner),
);
t("subject has client name", commissionOnly.subject.includes("InterSolutions"));
t("subject has booking ID", commissionOnly.subject.includes("C-V885"));
// The greeting is deliberately impersonal: the only name on a partner line is the
// venue's, and "Hi Renaissance" addresses a hotel as if it were a person.
t("body greets the desk, not the venue's name", commissionOnly.body.startsWith("Hi team,"));
t("body has the commission amount", commissionOnly.body.includes("50.00 USD"), commissionOnly.body);
t("body never mentions a rate (not tracked here)", !/%/.test(commissionOnly.body));
t("net 15 terms in body", commissionOnly.body.includes("net 15"));
t("ACH for NABOO_US billing entity", commissionOnly.body.includes("ACH"));
t("body does not mention any other partner", !commissionOnly.body.includes("Venue B"));

// ── The commission rate, as the provider reads it ───────────────────────────
// The stored rate is a percentage scaled by 10,000 (70000 = 7%, 120000 = 12%).
// Dividing by 1,000 in the query printed ten times the real rate in this very
// paragraph — 70% on a 7% commission — in a document addressed to the provider
// being billed.
{
  const ratedPartner = partner({ raw_outstanding: -50, commission: 100 });
  // The breakdown now arrives as a per-provider detail fetched on demand, not on
  // the partner line. 10 nights at 100.00 is a base of 1,000.00 — quantity times
  // unit price, which is the number a rate can be applied to.
  const detail = (rate_pct) => ({
    event_ref: "C-V885",
    house_code: "H-0001",
    disbursements: [],
    commissionable: [
      { label: "Bedrooms", base_ht: 1000, qty: 10, unit: "NIGHT", unit_excl_tax: 100, rate_pct },
    ],
    commissionable_base_ht: 1000,
    commission_ht: (1000 * rate_pct) / 100,
    commission_ttc: null,
  });
  const rated = (rate_pct) =>
    composeNaCommissionRequest(row, ratedPartner, naContactFor(ratedPartner), detail(rate_pct));

  const seven = rated(7);
  t("a 7% rate reads as 7%", seven.body.includes("Commission rate: 7%"), seven.body);
  t("and the base it applies to", seven.body.includes("Commissionable base: 1,000.00"), seven.body);
  t("the base is quantity × unit price, not the unit price", !seven.body.includes("100.00 USD\n"));
  t("the standard 12% reads as 12%", rated(12).body.includes("Commission rate: 12%"));
  t("a fractional rate survives", rated(7.05).body.includes("Commission rate: 7.05%"));

  // Defence in depth against a future unit slip: a rate over 100% cannot be one,
  // so the line is dropped rather than quoted. It cannot catch every scale error
  // (a mis-scaled 7% reads as 70%, which is not impossible on its face), but a
  // mis-scaled rate of 10% or more — nine tenths of the real ones — lands here.
  const absurd = rated(120);
  t("an impossible rate is not quoted at all", !absurd.body.includes("Commission rate"));
  t("but the base still is", absurd.body.includes("Commissionable base"), absurd.body);
  t("and so is the amount owed", absurd.body.includes("50.00 USD"));
  t("a real 100% rate is still shown", rated(100).body.includes("Commission rate: 100%"));

  // Without the detail the email still goes out — it just states the amount.
  const bare = composeNaCommissionRequest(row, ratedPartner, naContactFor(ratedPartner));
  t("no detail: the amount is still asked for", bare.body.includes("50.00 USD"), bare.body);
  t("no detail: no base is invented", !bare.body.includes("Commissionable base"));

  // The bug this reconciliation exists to catch: a base that cannot imply the
  // commission being claimed is not printed at all. 1,000.00 at 7% is 70.00, so a
  // recorded commission of 3,513.51 means the lines are wrong, not the commission.
  const mismatched = composeNaCommissionRequest(row, ratedPartner, naContactFor(ratedPartner), {
    ...detail(7),
    commission_ht: 3513.51,
  });
  t(
    "a base that does not imply the commission is withheld",
    !/Commissionable/.test(mismatched.body),
  );
  t("but the commission is still claimed", mismatched.body.includes("50.00 USD"));
}

const efPartner = partner({ raw_outstanding: -50, commission: 100 });
const efBody = composeNaCommissionRequest(
  { ...row, billing_entity: "NABOO_CA" },
  efPartner,
  naContactFor(efPartner),
);
t("EFT for non-US billing entity", efBody.body.includes("EFT"));

// ── composeNaRefundRequest (single partner) ─────────────────────────────────
console.log("\n[composeNaRefundRequest]");

t(
  "null when no overpayment beyond commission",
  composeNaRefundRequest(row, partner({ raw_outstanding: -50, commission: 100 }), c) === null,
);

const refundPartner = partner({ raw_outstanding: -150, commission: 100, payable: 800, paid: 950 });
const refundOnly = composeNaRefundRequest(row, refundPartner, naContactFor(refundPartner));
t("subject mentions overpayment", refundOnly.subject.includes("Overpayment"));
t("body has the overpayment amount", refundOnly.body.includes("50.00 USD"), refundOnly.body);
t("body asks for a refund", refundOnly.body.toLowerCase().includes("refund"));

// ── composeNaCombinedRequest (single partner with both) ─────────────────────
console.log("\n[composeNaCombinedRequest]");

t(
  "null unless this partner has both commission and refund",
  composeNaCombinedRequest(row, partner({ raw_outstanding: -50, commission: 100 }), c) === null,
);

const combinedPartner = partner({
  raw_outstanding: -150,
  commission: 100,
  payable: 800,
  paid: 950,
});
const combined = composeNaCombinedRequest(row, combinedPartner, naContactFor(combinedPartner));
t(
  "combined mentions both sections",
  combined.body.includes("1) Commission") && combined.body.includes("2) Overpayment"),
);
t("combined has commission amount", combined.body.includes("100.00 USD"), combined.body);
t("combined has overpayment amount", combined.body.includes("50.00 USD"), combined.body);

// The bug this covers: composeNaCombinedRequest used to print a bare commission
// figure and never called commissionBlock at all, so a partner with both a
// commission and a refund never got the itemised breakdown the commission-only
// email already had — regardless of whether real detail was fetched for them.
const combinedWithDetail = composeNaCombinedRequest(
  row,
  combinedPartner,
  naContactFor(combinedPartner),
  {
    event_ref: "C-V885",
    house_code: "H-0001",
    disbursements: [],
    commissionable: [
      {
        label: "Room Rental",
        base_ht: 1350,
        qty: 1,
        unit: "GROUP",
        unit_excl_tax: 1350,
        rate_pct: 7,
      },
    ],
    commissionable_base_ht: 1350,
    commission_ht: 94.5,
    commission_ttc: 94.5,
  },
);
t(
  "combined shows the commissionable base when detail is available",
  combinedWithDetail.body.includes("Commissionable base: 1,350.00"),
  combinedWithDetail.body,
);
t("and the rate", combinedWithDetail.body.includes("Commission rate: 7%"), combinedWithDetail.body);
t(
  "still under the Commission heading, not a bare figure",
  combinedWithDetail.body.includes("1) Commission\n• Commissionable"),
  combinedWithDetail.body,
);

// ── Two different partners on the same booking never bleed into each other ──
console.log("\n[isolation across partners]");

const venueA = partner({
  name: "Venue A",
  email: "a@x.com",
  raw_outstanding: -50,
  commission: 100,
  currency: "USD",
});
const venueB = partner({
  name: "Venue B",
  email: "b@x.com",
  raw_outstanding: -150,
  commission: 100,
  currency: "USD",
});
const emailA = composeNaCommissionRequest(row, venueA, naContactFor(venueA));
const emailB = composeNaCombinedRequest(row, venueB, naContactFor(venueB));
t("Venue A's email never mentions Venue B", !emailA.body.includes("Venue B"));
t("Venue B's email never mentions Venue A", !emailB.body.includes("Venue A"));
t(
  "Venue A and Venue B get different contact addresses",
  naContactFor(venueA).address !== naContactFor(venueB).address,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
