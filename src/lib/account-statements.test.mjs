import {
  supplierStatement,
  clientStatement,
  safeFileName,
  longDate,
} from "./account-statements.ts";

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

/** The statement is an HTML document; read it back as text. */
const read = (entry) => Buffer.from(entry.bytes).toString("utf8");

const event = {
  ref: "F-B658",
  client: "L\u2019Oréal Canada Inc",
  eventType: "master class",
  from: "2026-05-14",
  to: "2026-05-16",
  po: "4200040857",
  poDate: "2026-07-14",
  currency: "GBP",
  billingEntity: "Naboo Canada",
};

// ── Supplier ───────────────────────────────────────────────────────────────
const supplier = supplierStatement(event, {
  name: "Lois Freestone",
  email: "lois.freestone@me.com",
  currency: "GBP",
  payable: 1037.5,
  due: 1037.5,
  paid: 0,
  payments: [],
});
const supplierDoc = read(supplier);

t(
  "the file is named for the supplier and the event",
  supplier.name === "Lois Freestone — F-B658.html",
  supplier.name,
);
t("it is a printable document", supplierDoc.startsWith("<!doctype html>"));
t(
  "it is addressed to the supplier",
  supplierDoc.includes("Payable to") && supplierDoc.includes("Lois Freestone"),
);
t(
  "it carries the booking and the billing entity",
  supplierDoc.includes("F-B658") && supplierDoc.includes("Naboo Canada"),
);
t("the amount payable is the total", supplierDoc.includes("1,037.50"));
t("nothing paid reads as nothing paid", supplierDoc.includes("No payment recorded yet."));
t("an accented client name survives", supplierDoc.includes("L\u2019Oréal Canada Inc"));

const withCommission = read(
  supplierStatement(event, {
    name: "Hôtel Nelligan",
    currency: "CAD",
    payable: 44900,
    commission: 6180,
    paid: 54320,
    payments: [
      { amount: 40000, paidOn: "2026-06-03", method: "wire", reference: "VIR-4471" },
      { amount: 14320, paidOn: "2026-06-18", method: "card", reference: "CB-8890" },
    ],
  }),
);
t(
  "our commission is shown as the deduction it is",
  withCommission.includes("Naboo commission") &&
    withCommission.includes("Commission") &&
    withCommission.includes("−6,180.00"),
);
t(
  "every payment is listed with its date, method and reference",
  withCommission.includes("3 June 2026") &&
    withCommission.includes("wire") &&
    withCommission.includes("VIR-4471"),
);
t(
  "an overpaid supplier reads as money to recover, without a double negative",
  withCommission.includes("Balance to recover") &&
    withCommission.includes(">15,600.00<") &&
    !withCommission.includes("−15,600.00"),
);
t(
  "and the closing line points the money back at them",
  withCommission.includes("To be refunded by Hôtel Nelligan"),
);
t("the event dates are written out", withCommission.includes("14–16 May 2026"), "");

// ── Client ─────────────────────────────────────────────────────────────────
const client = clientStatement(event, {
  invoiced: 5802.79,
  collected: 2000,
  outstanding: 3802.79,
  invoices: [
    {
      ref: "CAI-CA26-00166",
      status: "ISSUED",
      issued: "2026-07-30",
      due: "2026-09-28",
      amount: 5802.79,
    },
  ],
});
const clientDoc = read(client);

t(
  "the client file is named for the client and the event",
  client.name === "L\u2019Oréal Canada Inc — F-B658.html",
  client.name,
);
t("it is addressed to the client", clientDoc.includes("Billed to"));
t(
  "the invoice is listed with its dates",
  clientDoc.includes("CAI-CA26-00166") &&
    clientDoc.includes("30 July 2026") &&
    clientDoc.includes("28 September 2026"),
);
t(
  "the balance is what is still open",
  clientDoc.includes("3,802.79") && clientDoc.includes("Balance due"),
);
t("the due date drives the pill", clientDoc.includes("Due 28 September 2026"));
t("the PO is the reference to quote", clientDoc.includes("reference F-B658 · PO 4200040857"));
t(
  "receipts held only as a total say so",
  clientDoc.includes("Receipts are held as a total, not line by line."),
);

// A credit note that voids an invoice in full is left off the recap.
const netted = read(
  clientStatement(event, {
    invoiced: 5802.79,
    collected: 0,
    outstanding: 5802.79,
    invoices: [
      {
        ref: "CAI-CA26-00166",
        status: "ISSUED",
        issued: "2026-07-30",
        due: "2026-09-28",
        amount: 5802.79,
      },
      {
        ref: "CAI-CA26-00201",
        status: "ISSUED",
        issued: "2026-08-01",
        due: "2026-09-30",
        amount: 1200,
      },
      { ref: "CAI-CA26-00202", status: "ISSUED", issued: "2026-08-02", due: null, amount: -1200 },
    ],
  }),
);
t(
  "the cancelling pair is not listed",
  !netted.includes("CAI-CA26-00201") && !netted.includes("CAI-CA26-00202"),
);
t("the invoice that stands is still listed", netted.includes("CAI-CA26-00166"));
t("the document says what it netted off", netted.includes("netted off and not listed"));
t("the total is unmoved by netting", netted.includes("5,802.79"));

const empty = read(clientStatement(event, { invoiced: 0, collected: 0, outstanding: 0 }));
t("an event with no invoice says so", empty.includes("Nothing issued on this booking yet."));

// ── C-U332, against the back office ────────────────────────────────────────
// Every client-facing document on the booking. The back office totals these at
// USD 266 494,01, and the statement has to agree with it.
const u332Invoices = [
  {
    ref: "USI-US26-00002",
    status: "ISSUED",
    issued: "2026-06-10",
    due: "2026-06-17",
    amount: 148056.0,
  },
  {
    ref: "USI-US26-00012",
    status: "ISSUED",
    cancels: "USI-US26-00002",
    issued: "2026-07-02",
    amount: -53000.0,
  },
  {
    ref: "USI-US26-00020",
    status: "ISSUED",
    issued: "2026-07-16",
    due: "2026-07-23",
    amount: 16210.5,
  },
  {
    ref: "USI-US26-00024",
    status: "ISSUED",
    issued: "2026-07-17",
    due: "2026-07-24",
    amount: 45023.3,
  },
  {
    ref: "USI-US26-00029",
    status: "ISSUED",
    issued: "2026-07-22",
    due: "2026-07-29",
    amount: 57314.85,
  },
  {
    ref: "USI-US26-00034",
    status: "ISSUED",
    issued: "2026-07-24",
    due: "2026-07-31",
    amount: 10700.0,
  },
  {
    ref: "USI-US26-00035",
    status: "ISSUED",
    issued: "2026-07-24",
    due: "2026-07-31",
    amount: 12142.34,
  },
  {
    ref: "USI-US26-00047",
    status: "CANCELLED",
    issued: "2026-07-30",
    due: "2026-08-06",
    amount: 15587.69,
  },
  {
    ref: "USI-US26-00054",
    status: "ISSUED",
    cancels: "USI-US26-00002",
    issued: "2026-08-03",
    amount: -7200.0,
  },
  {
    ref: "USI-US26-00055",
    status: "ISSUED",
    cancels: "USI-US26-00047",
    issued: "2026-08-03",
    amount: -4800.0,
  },
  {
    ref: "USI-US26-00063",
    status: "ISSUED",
    cancels: "USI-US26-00002",
    issued: "2026-08-04",
    amount: -4800.0,
  },
  {
    ref: "USI-US26-00064",
    status: "ISSUED",
    cancels: "USI-US26-00047",
    issued: "2026-08-04",
    amount: -8016.64,
  },
  {
    ref: "USI-US26-00065",
    status: "ISSUED",
    issued: "2026-08-04",
    due: "2026-08-11",
    amount: 2538.59,
  },
  {
    ref: "USI-US26-00069",
    status: "ISSUED",
    issued: "2026-08-05",
    due: "2026-08-12",
    amount: 40678.46,
  },
  {
    ref: "USI-US26-00070",
    status: "ISSUED",
    cancels: "USI-US26-00002",
    issued: "2026-08-06",
    amount: -6000.0,
  },
  {
    ref: "USI-US26-00071",
    status: "ISSUED",
    cancels: "USI-US26-00047",
    issued: "2026-08-06",
    amount: -5741.95,
  },
  {
    ref: "USI-US26-00072",
    status: "ISSUED",
    cancels: "USI-US26-00069",
    issued: "2026-08-06",
    amount: 7213.25,
  },
  {
    ref: "USI-US26-00073",
    status: "ISSUED",
    cancels: "USI-US26-00047",
    issued: "2026-08-06",
    amount: 2970.9,
  },
  {
    ref: "USI-US26-00074",
    status: "ISSUED",
    cancels: "USI-US26-00069",
    issued: "2026-08-06",
    amount: -7407.0,
  },
  {
    ref: "USI-US26-00075",
    status: "ISSUED",
    issued: "2026-08-06",
    due: "2026-08-13",
    amount: 4643.26,
  },
  {
    ref: "USI-US26-00078",
    status: "ISSUED",
    issued: "2026-08-07",
    due: "2026-08-14",
    amount: 1157.78,
  },
  {
    ref: "USI-US26-00083",
    status: "ISSUED",
    issued: "2026-08-11",
    due: "2026-08-18",
    amount: -777.32,
  },
];
const u332 = read(
  clientStatement(
    {
      ref: "C-U332",
      client: "Bland AI",
      eventType: "C-U332 / Bland AI",
      from: "2026-08-10",
      to: "2026-08-13",
      currency: "USD",
      billingEntity: "Naboo Inc",
    },
    { invoiced: 266494.01, collected: 267617.45, outstanding: -1123.44, invoices: u332Invoices },
  ),
);

t("the total invoiced matches the back office", u332.includes("266,494.01"), "");
t(
  "the fully cancelled invoice and its four credit notes are not listed",
  !u332.includes("USI-US26-00047") &&
    !u332.includes("USI-US26-00055") &&
    !u332.includes("USI-US26-00064") &&
    !u332.includes("USI-US26-00071") &&
    !u332.includes("USI-US26-00073"),
);
t(
  "the document says five documents came off",
  u332.includes("5 documents that cancel each other in full"),
);
t(
  "a partially cancelled invoice keeps its children on the page",
  u332.includes("USI-US26-00069") &&
    u332.includes("USI-US26-00072") &&
    u332.includes("USI-US26-00074"),
);
t(
  "the partial credit notes against the first invoice stay listed",
  u332.includes("USI-US26-00002") && u332.includes("USI-US26-00012"),
);
t("17 documents are listed", u332.includes("17 lines · USD"), "");
t(
  "an event name that repeats the reference and the client is cleaned up",
  !u332.includes("C-U332 / Bland AI"),
);

// ── Names and dates ────────────────────────────────────────────────────────
t(
  "a slash cannot become a directory",
  safeFileName("Traiteur / Agnus Dei") === "Traiteur - Agnus Dei",
);
t("an empty name still yields a file", safeFileName("   ") === "statement");
t(
  "a date is written out in full",
  longDate("2026-08-04") === "4 August 2026",
  String(longDate("2026-08-04")),
);
t("a missing date stays missing", longDate(null) === null);
t(
  "a name cannot inject markup into the document",
  read(supplierStatement(event, { name: "<b>Le Balcon</b>" })).includes("&lt;b&gt;Le Balcon"),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
