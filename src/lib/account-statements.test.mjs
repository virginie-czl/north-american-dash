import { supplierStatement, clientStatement, safeFileName } from "./account-statements.ts";

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

const event = {
  ref: "F-B658",
  client: "L’Oréal Canada Inc",
  eventType: "master class",
  dates: "2026-05-14 → 2026-05-16",
  po: "4200040857",
  poDate: "2026-07-14",
  currency: "GBP",
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
t("named for the supplier and the event", supplier.name === "Lois Freestone — F-B658.csv", supplier.name);
t("states the event", supplier.text.includes("Event,F-B658"));
t("states the PO and when it arrived", supplier.text.includes("4200040857") && supplier.text.includes("2026-07-14"));
t("carries the amount owed", supplier.text.includes("Still due,1037.50"), supplier.text);
t("names the currency on the column", supplier.text.includes("Amount (GBP)"));
t("no payments table when nothing was paid", !supplier.text.includes("Payments made"));

const withPayments = supplierStatement(event, {
  name: "Bonaventure",
  currency: "CAD",
  payable: 65052,
  paid: 65052,
  due: 0,
  payments: [
    { amount: 40658, paidOn: "03/06/26", method: "wire", reference: "VIR-4471" },
    { amount: 24394, paidOn: "18/06/26", method: "card", reference: "CB-8890" },
  ],
});
t("lists every payment", withPayments.text.includes("VIR-4471") && withPayments.text.includes("CB-8890"));
t("payments carry their date and method", withPayments.text.includes("03/06/26,wire,VIR-4471,40658.00"));

const clawback = supplierStatement(event, {
  name: "Fairmont Mayakoba",
  currency: "USD",
  payable: 854554.94,
  paid: 386302.56,
  due: 0,
  commission: 22838.23,
  commissionToRecover: 22838.23,
  refundToRecover: 0,
});
t("states a commission to recover", clawback.text.includes("Commission to recover from the supplier,22838.23"));
t("says nothing about a refund that is zero", !clawback.text.includes("Overpayment to refund"));

// ── Client ─────────────────────────────────────────────────────────────────
const client = clientStatement(event, {
  invoiced: 5802.79,
  collected: 0,
  outstanding: 5802.79,
  invoices: [
    {
      ref: "CAI-CA26-00166",
      status: "ISSUED",
      issued: "2026-07-30",
      sent: "2026-07-30",
      due: "2026-09-28",
      amount: 5802.79,
    },
  ],
});
t("named for the client and the event", client.name === "L’Oréal Canada Inc — F-B658.csv", client.name);
t("states what is outstanding", client.text.includes("Outstanding,5802.79"));
t("lists the invoice with its dates", client.text.includes("CAI-CA26-00166,issued,2026-07-30,2026-07-30,2026-09-28,5802.79"));

// ── Filenames ──────────────────────────────────────────────────────────────
t("a slash cannot become a directory", safeFileName("Traiteur / Agnus Dei") === "Traiteur - Agnus Dei");
t("an empty name still yields a file", safeFileName("   ") === "statement");
t(
  "a comma in a name is quoted in the CSV, not split",
  supplierStatement(event, { name: "HOLT, RENFREW & CO." }).text.includes('"HOLT, RENFREW & CO."'),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
