import {
  aggregateProviders,
  buildRows,
  cardStatus,
  CARD_SCOPES,
  CARD_STATUS_LABEL,
  csvRows,
  CSV_HEADER,
  emptyTerms,
  fmtAge,
  fmtAmounts,
  fmtFee,
  hasFee,
  matchesSearch,
  NO_EVIDENCE,
  peakAmount,
  scopeCounts,
  scopeMatcher,
  sortRows,
  validateCardTerms,
} from "./card-tracking.ts";

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

const terms = (o = {}) => ({ ...emptyTerms("O-A001"), ...o });
const ev = (o = {}) => ({ ...NO_EVIDENCE, ...o });

// ── The derivation ──────────────────────────────────────────────────────────
console.log("\n[cardStatus — evidence]");
t("no evidence at all is Unknown, not a no", cardStatus(ev(), null).status === "unknown");
t("and Unknown names no source", cardStatus(ev(), null).source === "none");
{
  const v = cardStatus(ev({ slackApproved: true }), null);
  t("an approved card in the channel is Card OK", v.status === "card_ok");
  t("credited to Slack", v.source === "slack");
  t("and not flagged as an override", v.overridden === false);
}
{
  const v = cardStatus(ev({ emailVerdict: "accepted" }), null);
  t(
    "an explicit acceptance in the scan is Card OK",
    v.status === "card_ok" && v.source === "email",
  );
}
{
  const v = cardStatus(ev({ emailVerdict: "refused" }), null);
  t("an explicit refusal in the scan is Refuses card", v.status === "refuses");
}

// The trap this page exists to avoid: a Slack refusal is Naboo declining to issue a
// card, for our own reasons. It is not the provider saying no, and CardEvidence
// deliberately has no field to record it in.
console.log("\n[a Slack refusal can never make a provider a refuser]");
{
  const fields = Object.keys(ev());
  t(
    "the evidence type carries no Slack refusal at all",
    !fields.some((f) => /refus/i.test(f)),
    fields.join(","),
  );
  // The only way to reach Refuses card is the provider's own word, by scan or by hand.
  const reachable = [
    cardStatus(ev({ emailVerdict: "refused" }), null).status,
    cardStatus(ev(), terms({ accepts_card: "no" })).status,
  ];
  t(
    "only the provider's own word reaches Refuses card",
    reachable.every((s) => s === "refuses"),
  );
  t(
    "a provider with no evidence but an unapproved request stays Unknown",
    cardStatus(ev({ slackApproved: false }), null).status === "unknown",
  );
}

console.log("\n[partner_payment_method is not acceptance]");
{
  // 435 of 447 providers carry CREDIT_CARD. If the method leaked into the derivation
  // this page would claim 97% acceptance; it must change nothing.
  const provider = aggregateProviders([
    row({ payment_method: "CREDIT_CARD" }),
    row({ quote_id: "q2", payment_method: "CREDIT_CARD" }),
  ])[0];
  const rows = buildRows([provider], new Map(), new Map());
  t("a CREDIT_CARD provider with no evidence is Unknown", rows[0].verdict.status === "unknown");
  t("the method is still carried for display", provider.payment_methods.join() === "CREDIT_CARD");
}

console.log("\n[cardStatus — the fee promotes and demotes]");
t(
  "a fee on an accepted provider reads Card OK if fee",
  cardStatus(ev({ slackApproved: true }), terms({ fee_percent: 2.5 })).status === "card_ok_if_fee",
);
t(
  "a fixed fee alone does the same",
  cardStatus(ev({ slackApproved: true }), terms({ fee_fixed: 40 })).status === "card_ok_if_fee",
);
t(
  "clearing the fee demotes it back to Card OK",
  cardStatus(ev({ slackApproved: true }), terms({ fee_percent: 0, fee_fixed: null })).status ===
    "card_ok",
);
t("a zero fee is no fee", hasFee({ fee_percent: 0, fee_fixed: 0 }) === false);
t("a null fee is no fee", hasFee({ fee_percent: null, fee_fixed: null }) === false);
t(
  "a fee never promotes a refuser",
  cardStatus(ev({ emailVerdict: "refused" }), terms({ fee_percent: 3 })).status === "refuses",
);
t(
  "a fee never promotes an Unknown",
  cardStatus(ev(), terms({ fee_percent: 3 })).status === "unknown",
);

console.log("\n[cardStatus — a manual override wins, and says so]");
{
  const v = cardStatus(ev({ emailVerdict: "refused" }), terms({ accepts_card: "yes" }));
  t("a human yes beats a scanned refusal", v.status === "card_ok");
  t("and is visible as an override", v.overridden === true && v.source === "manual");
}
{
  const v = cardStatus(ev({ slackApproved: true }), terms({ accepts_card: "no" }));
  t("a human no beats an approved card", v.status === "refuses" && v.overridden === true);
}
t(
  "a null override falls back to the evidence",
  cardStatus(ev({ slackApproved: true }), terms({ accepts_card: null })).source === "slack",
);

// ── Aggregation ─────────────────────────────────────────────────────────────
function row(o = {}) {
  return {
    owner_code: "O-A001",
    quote_id: "q1",
    provider_name: "Hyatt Regency",
    country: "US",
    email: "ap@hyatt.com",
    venue_name: "Hyatt Regency Boston",
    partner_name: null,
    event_ref: "C-P222",
    currency: "USD",
    outstanding: 1000,
    start_date: "2026-06-21",
    payment_method: "CREDIT_CARD",
    ...o,
  };
}

console.log("\n[aggregateProviders]");
{
  const [p] = aggregateProviders([row(), row(), row()]);
  t("the same quote repeated counts once", p.amounts[0].amount === 1000, JSON.stringify(p.amounts));
  t("one booking", p.bookings === 1);
}
{
  // Pknik on F-B333: two quotes, same booking, same house, two real payables.
  const [p] = aggregateProviders([
    row({
      owner_code: "O-F9447",
      quote_id: "a",
      event_ref: "F-B333",
      currency: "CAD",
      outstanding: -500,
    }),
    row({
      owner_code: "O-F9447",
      quote_id: "a",
      event_ref: "F-B333",
      currency: "CAD",
      outstanding: -500,
    }),
    row({
      owner_code: "O-F9447",
      quote_id: "b",
      event_ref: "F-B333",
      currency: "CAD",
      outstanding: -6239.65,
    }),
    row({
      owner_code: "O-F9447",
      quote_id: "b",
      event_ref: "F-B333",
      currency: "CAD",
      outstanding: -6239.65,
    }),
  ]);
  t(
    "two quotes on one booking are two payables",
    p.amounts[0].amount === -6739.65,
    JSON.stringify(p.amounts),
  );
  t("but still one booking", p.bookings === 1, p.bookings);
}
{
  // BizAway: USD, EUR and 281,000,000 IDR. One sum across those means nothing.
  const [p] = aggregateProviders([
    row({
      owner_code: "O-B0446",
      quote_id: "u",
      event_ref: "C-P205",
      currency: "USD",
      outstanding: 9121.44,
    }),
    row({
      owner_code: "O-B0446",
      quote_id: "e",
      event_ref: "C-U590",
      currency: "EUR",
      outstanding: 327558,
    }),
    row({
      owner_code: "O-B0446",
      quote_id: "i",
      event_ref: "C-W041",
      currency: "IDR",
      outstanding: 281000000,
    }),
  ]);
  t("each currency keeps its own figure", p.amounts.length === 3);
  t("largest first", p.amounts[0].currency === "IDR" && p.amounts[2].currency === "USD");
  t("three bookings", p.bookings === 3);
  t("no cross-currency total is ever produced", !Object.keys(p).includes("outstanding"));
  t("peak is one currency's exposure, not a sum", peakAmount(p) === 281000000);
}
{
  const [p] = aggregateProviders([
    row({ start_date: "2026-06-21", event_ref: "C-A1" }),
    row({ quote_id: "q2", start_date: "2027-02-28", event_ref: "C-A2" }),
    row({ quote_id: "q3", start_date: "2025-01-01", event_ref: "C-A3" }),
  ]);
  t("the latest booking date wins", p.latest_start === "2027-02-28", p.latest_start);
  t("three bookings counted", p.bookings === 3);
}
{
  const [p] = aggregateProviders([
    row({ provider_name: "BizAway", venue_name: "BizAway United States" }),
    row({ quote_id: "q2", provider_name: "BizAway", venue_name: "Bizaway Indonesia" }),
  ]);
  t("every trading name is kept as an alias", p.aliases.length === 3, p.aliases.join("|"));
  t("the first non-empty name is the display name", p.provider_name === "BizAway");
}
{
  const [p] = aggregateProviders([
    row({ outstanding: 0 }),
    row({ quote_id: "q2", outstanding: 0 }),
  ]);
  t("a settled provider shows no amount at stake", p.amounts.length === 0);
}
{
  const out = aggregateProviders([row({ owner_code: "" }), row({ owner_code: null })]);
  t("a row with no owner code is not a provider", out.length === 0);
}
{
  const [p] = aggregateProviders([row({ owner_code: "o-a001" })]);
  t("owner codes are upper-cased so the Slack match is exact", p.owner_code === "O-A001");
}

// ── Scopes: one predicate for both the filter and the count ─────────────────
console.log("\n[scopes]");
{
  const providers = aggregateProviders([
    row({ owner_code: "O-1", quote_id: "1" }),
    row({ owner_code: "O-2", quote_id: "2" }),
    row({ owner_code: "O-3", quote_id: "3" }),
    row({ owner_code: "O-4", quote_id: "4" }),
    row({ owner_code: "O-5", quote_id: "5" }),
  ]);
  const termsMap = new Map([
    ["O-2", terms({ owner_code: "O-2", naboo_pays_card: "yes" })],
    [
      "O-3",
      terms({
        owner_code: "O-3",
        fee_percent: 2,
        naboo_pays_card: "no",
        naboo_reason: "fee too high",
      }),
    ],
    ["O-4", terms({ owner_code: "O-4", accepts_card: "no", refusal_reason: "policy" })],
  ]);
  const evidenceMap = new Map([
    ["O-2", ev({ slackApproved: true })],
    ["O-3", ev({ slackApproved: true })],
    ["O-5", ev({ slackApproved: true })],
  ]);
  const rows = buildRows(providers, termsMap, evidenceMap);
  const counts = scopeCounts(rows);

  t("O-1 unknown", rows[0].verdict.status === "unknown");
  t("O-2 card ok", rows[1].verdict.status === "card_ok");
  t("O-3 card ok if fee", rows[2].verdict.status === "card_ok_if_fee");
  t("O-4 refuses", rows[3].verdict.status === "refuses");

  // The invariant: every chip's count is exactly what its filter shows.
  for (const scope of CARD_SCOPES) {
    const shown = rows.filter(scopeMatcher(scope.key)).length;
    t(
      `${scope.key}: the count is what the list shows`,
      counts[scope.key] === shown,
      `${counts[scope.key]} vs ${shown}`,
    );
  }
  t(
    "needs a decision: the unknown plus the undecided acceptor",
    counts.needs_decision === 2,
    counts.needs_decision,
  );
  t("we decline: only the divergence", counts.we_decline === 1);
  t("all: everybody", counts.all === 5);
}

console.log("\n[search and sort]");
{
  const providers = aggregateProviders([
    row({
      owner_code: "O-Z9",
      provider_name: "Zeta Venue",
      country: "CA",
      quote_id: "z",
      outstanding: 10,
    }),
    row({
      owner_code: "O-A1",
      provider_name: "Alpha Hotel",
      country: "US",
      quote_id: "a",
      outstanding: 5000,
      event_ref: "C-A",
    }),
    row({
      owner_code: "O-A1",
      provider_name: "Alpha Hotel",
      country: "US",
      quote_id: "a2",
      outstanding: 1,
      event_ref: "C-B",
    }),
  ]);
  const rows = buildRows(providers, new Map(), new Map());
  t("search by name", rows.filter((r) => matchesSearch(r, "alpha")).length === 1);
  t("search by O- code", rows.filter((r) => matchesSearch(r, "o-z9")).length === 1);
  t("search by country", rows.filter((r) => matchesSearch(r, "ca")).length === 1);
  t(
    "search by an alias",
    rows.filter((r) => matchesSearch(r, "Hyatt Regency Boston")).length === 2,
  );
  t("an empty search keeps everything", rows.filter((r) => matchesSearch(r, "  ")).length === 2);
  t(
    "sort by amount, largest first",
    sortRows(rows, "amount", true)[0].provider.owner_code === "O-A1",
  );
  t("sort by bookings", sortRows(rows, "bookings", true)[0].provider.bookings === 2);
  t("sort by name", sortRows(rows, "provider", false)[0].provider.provider_name === "Alpha Hotel");
}

// ── Saving ──────────────────────────────────────────────────────────────────
console.log("\n[validateCardTerms]");
const input = (o = {}) => ({
  owner_code: "O-A001",
  accepts_card: null,
  fee_percent: null,
  fee_fixed: null,
  fee_currency: null,
  refusal_reason: null,
  naboo_pays_card: null,
  naboo_reason: null,
  ...o,
});

t(
  "they accept and we decline with no reason: refused",
  /why we are not paying/i.test(
    validateCardTerms(input({ naboo_pays_card: "no" }), "card_ok") ?? "",
  ),
);
t(
  "the same on Card OK if fee",
  validateCardTerms(input({ naboo_pays_card: "no" }), "card_ok_if_fee") !== null,
);
t(
  "with a reason it saves",
  validateCardTerms(
    input({ naboo_pays_card: "no", naboo_reason: "over the card limit" }),
    "card_ok",
  ) === null,
);
t(
  "whitespace is not a reason",
  validateCardTerms(input({ naboo_pays_card: "no", naboo_reason: "   " }), "card_ok") !== null,
);
t(
  "no justification is asked for when the provider refuses",
  validateCardTerms(input({ naboo_pays_card: "no" }), "refuses") === null,
);
t(
  "nor when nothing is known yet",
  validateCardTerms(input({ naboo_pays_card: "no" }), "unknown") === null,
);
t(
  "saying yes needs no reason",
  validateCardTerms(input({ naboo_pays_card: "yes" }), "card_ok") === null,
);
t(
  "leaving it undecided needs no reason",
  validateCardTerms(input({ naboo_pays_card: null }), "card_ok") === null,
);
t(
  "a fee on a refusing provider is a data-entry error",
  /refuses card cannot have a card fee/i.test(
    validateCardTerms(input({ accepts_card: "no", fee_percent: 2 }), "refuses") ?? "",
  ),
);
t(
  "a refusal reason on an accepting provider is too",
  /accepts card/i.test(
    validateCardTerms(input({ accepts_card: "yes", refusal_reason: "no" }), "card_ok") ?? "",
  ),
);
t("a negative fee is refused", validateCardTerms(input({ fee_percent: -1 }), "card_ok") !== null);
t("a fee over 100% is refused", validateCardTerms(input({ fee_percent: 101 }), "card_ok") !== null);
t("100% exactly is allowed", validateCardTerms(input({ fee_percent: 100 }), "card_ok") === null);

// ── Formatting ──────────────────────────────────────────────────────────────
console.log("\n[formatting]");
t("cents on every amount", fmtAmounts([{ currency: "USD", amount: 1000 }]) === "1,000.00 USD");
t(
  "every currency is listed",
  fmtAmounts([
    { currency: "IDR", amount: 281000000 },
    { currency: "USD", amount: 9121.44 },
  ]) === "281,000,000.00 IDR · 9,121.44 USD",
);
t("nothing outstanding reads as a dash", fmtAmounts([]) === "—");
t(
  "a negative amount keeps its sign",
  fmtAmounts([{ currency: "CAD", amount: -4799.34 }]) === "-4,799.34 CAD",
);
t("a percentage fee", fmtFee(terms({ fee_percent: 2.5 })) === "2.50%");
t("a fixed fee", fmtFee(terms({ fee_fixed: 40, fee_currency: "USD" })) === "40.00 USD");
t(
  "both at once, because both can apply",
  fmtFee(terms({ fee_percent: 2.5, fee_fixed: 40, fee_currency: "USD" })) === "2.50% + 40.00 USD",
);
t("no fee", fmtFee(terms()) === "—");
t("the mirror age reads in hours", fmtAge(3 * 3600) === "synced 3 h ago", fmtAge(3 * 3600));
t("minutes below the hour", fmtAge(600) === "synced 10 min ago");
t("just now", fmtAge(5) === "synced just now");
t("days beyond two", fmtAge(72 * 3600) === "synced 3 d ago", fmtAge(72 * 3600));
t("never synced is said, not hidden", fmtAge(null) === "never synced");
t(
  "statuses are all labelled",
  Object.values(CARD_STATUS_LABEL).every((l) => l.length > 0),
);

console.log("\n[CSV]");
{
  const providers = aggregateProviders([row()]);
  const rows = buildRows(
    providers,
    new Map([
      [
        "O-A001",
        terms({
          fee_percent: 2.5,
          naboo_pays_card: "no",
          naboo_reason: "fee",
          updated_by: "shayma",
        }),
      ],
    ]),
    new Map([["O-A001", ev({ slackApproved: true })]]),
  );
  const [line] = csvRows(rows);
  t(
    "one column per header",
    line.length === CSV_HEADER.length,
    `${line.length} vs ${CSV_HEADER.length}`,
  );
  t("the status is spelled out", line[6] === "Card OK if fee");
  t("both questions are exported apart", line[12] === "no" && line[13] === "fee");
  t("the amount keeps its currency", line[5] === "1,000.00 USD");
}
{
  const rows = buildRows(
    aggregateProviders([row()]),
    new Map([["O-A001", terms({ accepts_card: "yes" })]]),
    new Map(),
  );
  t("an override is marked in the export", csvRows(rows)[0][6] === "Card OK (override)");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
