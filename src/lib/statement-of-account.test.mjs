import {
  money,
  netOffCancellingLines,
  statementTotals,
  statementVoice,
} from "./statement-of-account.ts";

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

/** The seed from the brief, so the document can be checked against it. */
const seed = {
  billedTo: "Altman Solon US, LP",
  event: "June Training Event",
  bookingRef: "C-P222",
  billingEntity: "Naboo Group",
  currency: "USD",
  issuedOn: "31 July 2026",
  dueOn: "4 August 2026",
  payee: "Naboo Group",
  paymentReference: "C-P222",
  lines: [
    {
      ref: "NABI-FR26-00976",
      type: "invoice",
      issued: "26 Feb 2026",
      due: "27 Mar 2026",
      amount: 210606.84,
    },
    {
      ref: "NABI-FR26-00977",
      type: "invoice",
      issued: "26 Feb 2026",
      due: "27 Mar 2026",
      amount: 66970.67,
    },
    {
      ref: "NABI-FR26-01605",
      type: "credit_note",
      issued: "31 Mar 2026",
      due: null,
      amount: -377.81,
    },
    {
      ref: "NABI-FR26-02497",
      type: "invoice",
      issued: "5 Jul 2026",
      due: "4 Aug 2026",
      amount: 23710.2,
    },
  ],
  payments: [
    {
      paidOn: "26 Mar 2026",
      method: "Bank transfer",
      reference: "NABI-FR26-00976",
      amount: 210606.84,
    },
    {
      paidOn: "16 Jun 2026",
      method: "Bank transfer",
      reference: "NABI-FR26-00977",
      amount: 66970.67,
    },
  ],
};

// ── Figures ────────────────────────────────────────────────────────────────
const totals = statementTotals(seed);
t("total invoiced nets the credit note off", totals.invoiced === 300909.9, String(totals.invoiced));
t("total received sums the payments", totals.received === 277577.51, String(totals.received));
t("the balance is the difference", totals.balance === 23332.39, String(totals.balance));
t("thousands are grouped", money(210606.84) === "210,606.84", money(210606.84));
t("a negative carries a true minus, not a hyphen", money(-377.81) === "−377.81", money(-377.81));

// ── Netting ────────────────────────────────────────────────────────────────
const partial = netOffCancellingLines(seed.lines);
t("a partial credit note is never netted away", partial.lines.length === 4 && partial.netted === 0);

const cancelled = netOffCancellingLines([
  ...seed.lines,
  {
    ref: "NABI-FR26-03001",
    type: "invoice",
    issued: "9 Jul 2026",
    due: "8 Aug 2026",
    amount: 4500,
  },
  { ref: "NABI-FR26-03002", type: "credit_note", issued: "10 Jul 2026", due: null, amount: -4500 },
]);
t(
  "a credit note that voids an invoice in full removes both",
  cancelled.lines.length === 4,
  String(cancelled.lines.length),
);
t("the pair is counted, so the document can say so", cancelled.netted === 1);
t(
  "netting cannot move a total",
  statementTotals({ ...seed, lines: cancelled.lines }).invoiced === totals.invoiced,
);
t(
  "one credit note cancels one invoice, not two of the same amount",
  netOffCancellingLines([
    { ref: "A", type: "invoice", amount: 1000 },
    { ref: "B", type: "invoice", amount: 1000 },
    { ref: "C", type: "credit_note", amount: -1000 },
  ]).lines.length === 1,
);

// ── The document's words ───────────────────────────────────────────────────
const v = statementVoice(seed);

t(
  "the running header states the document, booking, issue date and currency",
  v.title === "Statement of account" &&
    v.headerMeta === "Booking C-P222 · issued 31 July 2026 · USD",
  v.headerMeta,
);
t(
  "the footer names the entity and the statement",
  v.footerLeft === "Naboo Group · finance@naboo.app" &&
    v.footerRight === "Statement C-P222 · 31 July 2026",
);
t(
  "the meta strip is the four cells asked for",
  v.meta.map(([label]) => label).join(", ") === "Billed to, Event, Booking, Billing entity" &&
    v.meta[0][1] === "Altman Solon US, LP",
);

t(
  "the three tiles are there, with the due pill",
  v.tiles[0].label === "Total invoiced" &&
    v.tiles[1].label === "Total received" &&
    v.tiles[2].label === "Balance due" &&
    v.tiles[2].pill === "Due 4 August 2026",
);
t(
  "the first tile counts the lines it actually lists",
  v.tiles[0].caption === "4 lines · USD",
  v.tiles[0].caption,
);
t(
  "receipts are counted, and a total-only figure says so",
  v.tiles[1].caption === "2 payments" &&
    statementVoice({ ...seed, payments: [] }).tiles[1].caption === "Recorded as a total",
);

t(
  "the documents table is titled and qualified",
  v.documents.title === "Invoices and credit notes" &&
    v.documents.qualifier === "All amounts inclusive of tax, in USD",
);
t(
  "each table closes on its own total",
  v.documents.totalFigure === "300,909.90" && v.receipts.totalFigure === "277,577.51",
);
t(
  "a statement with no receipts explains the payments table rather than leaving it bare",
  statementVoice({ ...seed, payments: [] }).receipts.qualifier.startsWith(
    "Recorded as a total in the tracker",
  ),
);

t(
  "the closing bar states the balance, the payee and the currency",
  v.closing.figure === "23,332.39" &&
    v.closing.sub === "Payable to Naboo Group · due 4 August 2026 · reference C-P222" &&
    v.closing.currency === "USD",
);
t(
  "the footnote gives an address for a question",
  v.footnote.endsWith("Questions on any line: finance@naboo.app."),
  v.footnote,
);
// A statement points at whoever ran the event, not at a finance inbox.
const withEm = statementVoice({
  ...seed,
  contactName: "Emily Osei",
  contactEmail: "emily.osei@naboo.app",
});
t(
  "the event manager is named, and their address is the one to write to",
  withEm.footnote.endsWith("Questions on any line: Emily Osei — emily.osei@naboo.app."),
  withEm.footnote,
);
t(
  "the footer carries that address too, so there is only one to pick",
  withEm.footerLeft === "Naboo Group · emily.osei@naboo.app",
  withEm.footerLeft,
);
t(
  "an address with no name still reads as a sentence",
  statementVoice({ ...seed, contactEmail: "em@naboo.app" }).footnote.endsWith(
    "Questions on any line: em@naboo.app.",
  ),
);
t(
  "a blank contact falls back to finance rather than printing nothing",
  statementVoice({ ...seed, contactEmail: "  ", contactName: "  " }).contact ===
    "finance@naboo.app",
);
t("nothing is said about netting when nothing was netted", !v.footnote.includes("netted off"));
t(
  "a netted statement says what it left out",
  statementVoice({
    ...seed,
    lines: [
      ...seed.lines,
      { ref: "X", type: "invoice", amount: 4500 },
      { ref: "Y", type: "credit_note", amount: -4500 },
    ],
  }).footnote.includes("2 documents that cancel each other in full — 1 group — are netted off"),
);
t(
  "an omission the caller declares is said out loud",
  statementVoice({
    ...seed,
    omissions: ["Two deposits are held against the group."],
  }).footnote.includes("Two deposits are held against the group."),
);

// A settled statement must not ask to be paid.
const paidUp = statementVoice({
  ...seed,
  payments: [...seed.payments, { paidOn: "1 Aug 2026", amount: 23332.39 }],
});
t(
  "a settled statement says nothing is outstanding",
  paidUp.settled &&
    paidUp.closing.label === "Nothing outstanding" &&
    paidUp.tiles[2].caption === "Settled in full",
);
t("a settled statement drops the due pill", paidUp.tiles[2].pill === null);
t(
  "a settled statement does not invite a payment",
  !paidUp.closing.sub.includes("Payable to") && paidUp.closing.sub.startsWith("Settled in full"),
);

// A client who paid more than we billed is not "in arrears".
const overpaid = statementVoice({
  ...seed,
  payments: [...seed.payments, { paidOn: "1 Aug 2026", amount: 40000 }],
});
t(
  "an overpaid client reads as a credit balance",
  overpaid.credit &&
    overpaid.closing.label === "Credit balance" &&
    overpaid.tiles[2].caption === "Paid beyond what we invoiced",
);
t(
  "the figure drops its sign, because the label carries the direction",
  overpaid.closing.figure === "16,667.61",
  overpaid.closing.figure,
);
t("a credit balance is not given a due date", overpaid.tiles[2].pill === null);
t(
  "a credit balance says who refunds it",
  overpaid.closing.sub.includes("To be refunded by Naboo Group"),
);

// ── The supplier voice ─────────────────────────────────────────────────────
const supplier = statementVoice({ ...seed, side: "supplier", billedTo: "Hôtel Nelligan" });
t(
  "the supplier voice says payable, not invoiced",
  supplier.meta[0][0] === "Payable to" &&
    supplier.tiles[0].label === "Total payable" &&
    supplier.tiles[1].label === "Total paid" &&
    supplier.documents.title === "Amounts payable" &&
    supplier.closing.label === "Balance to pay",
);
t("an accented supplier name survives", supplier.meta[0][1] === "Hôtel Nelligan");
t(
  "money owed back to us reads as a recovery",
  statementVoice({
    ...seed,
    side: "supplier",
    payments: [{ paidOn: "1 Jul 2026", amount: 400000 }],
  }).closing.label === "Balance to recover",
);

// The hierarchy the back office draws: an invoice and the credit notes against
// it. C-U332's USI-US26-00047 is voided by four of them.
const grouped = [
  { ref: "USI-US26-00047", type: "invoice", group: "USI-US26-00047", amount: 15587.69 },
  { ref: "USI-US26-00055", type: "credit_note", group: "USI-US26-00047", amount: -4800 },
  { ref: "USI-US26-00064", type: "credit_note", group: "USI-US26-00047", amount: -8016.64 },
  { ref: "USI-US26-00071", type: "credit_note", group: "USI-US26-00047", amount: -5741.95 },
  { ref: "USI-US26-00073", type: "invoice", group: "USI-US26-00047", amount: 2970.9 },
];
const groupNet = netOffCancellingLines(grouped);
t(
  "a fully cancelled group goes in one piece",
  groupNet.lines.length === 0 && groupNet.netted === 1,
);
t("it counts the documents it removed", groupNet.omitted === 5);
t(
  "and the group's own total is zero, so no figure can move",
  Math.abs(grouped.reduce((sum, l) => sum + l.amount, 0)) < 0.005,
);

// Partially cancelled: the reduction is something the reader needs to see.
const partiallyCancelled = netOffCancellingLines([
  { ref: "USI-US26-00069", type: "invoice", group: "USI-US26-00069", amount: 40678.46 },
  { ref: "USI-US26-00072", type: "invoice", group: "USI-US26-00069", amount: 7213.25 },
  { ref: "USI-US26-00074", type: "credit_note", group: "USI-US26-00069", amount: -7407 },
]);
t(
  "a partially cancelled invoice keeps its whole group",
  partiallyCancelled.lines.length === 3 && partiallyCancelled.netted === 0,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
