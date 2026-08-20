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

/**
 * A statement is a PDF. Its streams are uncompressed, so the copy can be read
 * straight out of the bytes — which is also how a person would check one.
 * Octal escapes come back as their WinAnsi character.
 */
/** WinAnsi's own slots in 0x80–0x9F, mapped back to the characters they stand for. */
const WIN_ANSI = {
  0x91: "\u2018",
  0x92: "\u2019",
  0x93: "\u201c",
  0x94: "\u201d",
  0x96: "\u2013",
  0x97: "\u2014",
  0x85: "\u2026",
  0x80: "\u20ac",
};

const read = (entry) => {
  const raw = Buffer.from(entry.bytes).toString("latin1");
  return raw
    .replace(/\\([0-7]{3})/g, (_, oct) => {
      const code = parseInt(oct, 8);
      return WIN_ANSI[code] ?? Buffer.from([code]).toString("latin1");
    })
    .replace(/\\([()\\])/g, "$1");
};

const event = {
  ref: "F-B658",
  client: "L’Oréal Canada Inc",
  eventType: "master class",
  dates: "2026-05-14 – 2026-05-16",
  po: "4200040857",
  poDate: "2026-07-14",
  currency: "GBP",
};

// ── It really is a PDF ─────────────────────────────────────────────────────
const supplier = supplierStatement(event, {
  name: "Lois Freestone",
  email: "lois.freestone@me.com",
  currency: "GBP",
  payable: 1037.5,
  due: 1037.5,
  paid: 0,
  payments: [],
});
const supplierText = read(supplier);

t("the file is named for the supplier and the event", supplier.name === "Lois Freestone — F-B658.pdf", supplier.name);
t("it is a PDF, not a spreadsheet", Buffer.from(supplier.bytes.slice(0, 5)).toString() === "%PDF-");
t("it ends with the end-of-file marker", read(supplier).trimEnd().endsWith("%%EOF"));
t("one page", (supplierText.match(/\/Type \/Page[^s]/g) ?? []).length === 1);
t("the three standard fonts are declared", supplierText.includes("/Helvetica") && supplierText.includes("/Courier"));

// ── What it says ───────────────────────────────────────────────────────────
t("it names the statement and the subject", supplierText.includes("Supplier statement \u00b7 Lois Freestone"));
t("it states the event", supplierText.includes("F-B658"));
t("it states the PO and when it arrived", supplierText.includes("4200040857") && supplierText.includes("2026-07-14"));
t("it carries the amount owed", supplierText.includes("Still due") && supplierText.includes("1 037,50"), supplierText);
t("it names the currency on the section", supplierText.includes("WHAT IS OWED \u2014 GBP"));
t("an accented client name survives", supplierText.includes("L\u2019Or\u00e9al Canada Inc"));
t("no payments table when nothing was paid", !supplierText.includes("Payments made"));

const withPayments = read(
  supplierStatement(event, {
    name: "Bonaventure",
    currency: "CAD",
    payable: 65052,
    paid: 65052,
    due: 0,
    payments: [
      { amount: 40658, paidOn: "2026-06-03", method: "wire", reference: "VIR-4471" },
      { amount: 24394, paidOn: "2026-06-18", method: "card", reference: "CB-8890" },
    ],
  }),
);
t("every payment is listed", withPayments.includes("VIR-4471") && withPayments.includes("CB-8890"));
t("a payment carries its date, method and amount", withPayments.includes("2026-06-03") && withPayments.includes("wire") && withPayments.includes("40 658,00"));

const clawback = read(
  supplierStatement(event, {
    name: "Fairmont Mayakoba",
    currency: "USD",
    payable: 854554.94,
    paid: 386302.56,
    due: 0,
    commission: 22838.23,
    commissionToRecover: 22838.23,
    refundToRecover: 0,
  }),
);
t("a commission to recover is stated", clawback.includes("Commission to recover from the supplier") && clawback.includes("22 838,23"));
t("a refund of zero is not mentioned", !clawback.includes("Overpayment to refund"));

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
const clientText = read(client);
t("the client file is named for the client and the event", client.name === "L’Oréal Canada Inc — F-B658.pdf", client.name);
t("it states what is outstanding", clientText.includes("Outstanding") && clientText.includes("5 802,79"));
t("it lists the invoice with its dates", clientText.includes("CAI-CA26-00166") && clientText.includes("2026-09-28"));
t("an event with no invoice says so", read(clientStatement(event, { invoiced: 0, collected: 0, outstanding: 0 })).includes("No invoice has been issued"));

// ── Filenames ──────────────────────────────────────────────────────────────
t("a slash cannot become a directory", safeFileName("Traiteur / Agnus Dei") === "Traiteur - Agnus Dei");
t("an empty name still yields a file", safeFileName("   ") === "statement");
t(
  "a bracket in a name cannot break the PDF syntax",
  read(supplierStatement(event, { name: "HOLT, RENFREW & CO. (Montréal)" })).includes(
    "HOLT, RENFREW & CO. (Montr\u00e9al)",
  ),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
