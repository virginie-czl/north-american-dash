import { mergePartners } from "./partner-merge.ts";

/** A provider line as partners_json delivers it, with the boring fields filled. */
function line(over) {
  return {
    name: null,
    email: null,
    phone: null,
    owner_code: null,
    vat_raw: null,
    tax_identifier: null,
    country: null,
    currency: "CAD",
    amount_due: null,
    amount_paid: null,
    net_payable_ttc: null,
    is_outstanding: false,
    is_cancelled: false,
    payout_fx_date: null,
    ...over,
  };
}

/** One quote of an unpaid provider: the query hands us gross = due, paid = 0. */
function unpaidQuote(name, email, gross, currency = "CAD") {
  return line({
    name,
    email,
    currency,
    amount_due: gross,
    amount_paid: 0,
    net_payable_ttc: gross,
    is_outstanding: true,
  });
}

const cases = [
  [
    // The real F-B658: three GBP quotes for the same person, nothing paid.
    "several quotes for one provider add up",
    [
      unpaidQuote("Lois Freestone", "lois.freestone@me.com", 887.5, "GBP"),
      unpaidQuote("Lois Freestone", "lois.freestone@me.com", 50, "GBP"),
      unpaidQuote("Lois Freestone", "lois.freestone@me.com", 100, "GBP"),
    ],
    [{ name: "Lois Freestone", amount_due: 1037.5, amount_paid: 0, net_payable_ttc: 1037.5 }],
  ],

  [
    "a single quote is left exactly as the query computed it",
    [unpaidQuote("Casino de Montréal", "hello@casino.ca", 6657.16)],
    [{ name: "Casino de Montréal", amount_due: 6657.16, net_payable_ttc: 6657.16 }],
  ],

  [
    // amount_paid repeats the provider's booking-level total on every line, so
    // it is subtracted once — not once per quote.
    "a part-payment is subtracted once, not per quote",
    [
      line({
        name: "Bonaventure",
        email: "sales@bonaventure.ca",
        amount_due: 300,
        amount_paid: 500,
        net_payable_ttc: 800,
        is_outstanding: true,
      }),
      line({
        name: "Bonaventure",
        email: "sales@bonaventure.ca",
        amount_due: 0,
        amount_paid: 500,
        net_payable_ttc: 200,
        is_outstanding: true,
      }),
    ],
    [{ name: "Bonaventure", amount_due: 500, amount_paid: 500, net_payable_ttc: 1000 }],
  ],

  [
    "a provider paid more than it is owed lands on zero, never negative",
    [
      line({
        name: "Pknik",
        email: "hi@pknik.ca",
        amount_due: 0,
        amount_paid: 7000,
        net_payable_ttc: 6739.65,
        is_outstanding: true,
      }),
    ],
    [{ name: "Pknik", amount_due: 0 }],
  ],

  [
    // Settled upstream: is_outstanding is false, so the quote owes nothing even
    // though it carries a net payable.
    "settled quotes owe nothing",
    [
      line({
        name: "Eataly Toronto Catering",
        email: "events@eataly.ca",
        amount_due: 0,
        amount_paid: 6236.4,
        net_payable_ttc: 6236.4,
      }),
      line({
        name: "Eataly Toronto Catering",
        email: "events@eataly.ca",
        amount_due: 0,
        amount_paid: 6416.38,
        net_payable_ttc: 6416.38,
      }),
    ],
    [{ name: "Eataly Toronto Catering", amount_due: 0 }],
  ],

  [
    // Legal name on the priced line, trade name on the shell from quotes.
    "name variants sharing an email collapse onto the priced line",
    [
      unpaidQuote("HOLT, RENFREW & CO., LIMITED", "events@holtrenfrew.com", 3242.49),
      line({ name: "Holt Renfrew", email: "events@holtrenfrew.com", phone: "+1 416 000 0000" }),
    ],
    [
      {
        name: "HOLT, RENFREW & CO., LIMITED",
        amount_due: 3242.49,
        phone: "+1 416 000 0000",
      },
    ],
  ],

  [
    "shells with no contact and no amounts are dropped",
    [unpaidQuote("Super Aqua Club", "book@superaquaclub.ca", 12444.2), line({ name: "Aqua Club" })],
    [{ name: "Super Aqua Club", amount_due: 12444.2 }],
  ],

  [
    "a cancelled quote alongside a live one keeps the provider payable",
    [
      unpaidQuote("Fairmont Waterfront", "mice@fairmont.com", 8765.37),
      line({
        name: "Fairmont Waterfront",
        email: "mice@fairmont.com",
        amount_due: 0,
        amount_paid: 0,
        net_payable_ttc: 743.11,
        is_cancelled: true,
      }),
    ],
    [{ name: "Fairmont Waterfront", amount_due: 8765.37, is_cancelled: false }],
  ],
];

let failures = 0;
for (const [label, input, expected] of cases) {
  const got = mergePartners(input);
  const problems = [];
  if (got.length !== expected.length) {
    problems.push(`expected ${expected.length} provider(s), got ${got.length}`);
  }
  expected.forEach((want, i) => {
    const actual = got[i];
    if (!actual) return;
    for (const [key, value] of Object.entries(want)) {
      if (actual[key] !== value) {
        problems.push(
          `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`,
        );
      }
    }
  });
  if (problems.length) {
    failures++;
    console.error(`✗ ${label}`);
    problems.forEach((p) => console.error(`    ${p}`));
  } else {
    console.log(`✓ ${label}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} failing case${failures > 1 ? "s" : ""}`);
  process.exit(1);
}
console.log(`\n${cases.length} cases passed`);
