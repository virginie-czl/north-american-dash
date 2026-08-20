import {
  money,
  netOffCancellingLines,
  statementHtml,
  statementTotals,
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

// ── The document ───────────────────────────────────────────────────────────
const html = statementHtml(seed);

t("it is a standalone document", html.startsWith("<!doctype html>") && html.includes("</html>"));
t(
  "the only page rule is its margin",
  (html.match(/@page/g) ?? []).length === 1 && html.includes("@page { margin: 0; }"),
);
t("Letter width, no viewport units", html.includes("width: 8.5in") && !/\d(vh|vw)\b/.test(html));
t("both brand fonts are loaded", html.includes("Bricolage+Grotesque") && html.includes("Roboto"));
t(
  "the brand tokens are the ones specified",
  html.includes("#101F34") &&
    html.includes("#EFF779") &&
    html.includes("#FAFAF8") &&
    html.includes("#00B67A") &&
    html.includes("#DC2626"),
);
t("figures are tabular", html.includes("font-variant-numeric: tabular-nums"));

t(
  "the running header states the document, booking, issue date and currency",
  html.includes("Statement of account") &&
    html.includes("Booking C-P222 · issued 31 July 2026 · USD"),
);
t(
  "the header and footer repeat by being fixed",
  (html.match(/position: fixed/g) ?? []).length === 2,
);
t(
  "the footer names the entity and the statement",
  html.includes('Naboo Group · <a href="mailto:finance@naboo.app"') &&
    html.includes("Statement C-P222 · 31 July 2026"),
);

t(
  "the title carries the reference in gray",
  html.includes('<h1>Statement of account <span class="ref">· C-P222</span></h1>'),
);
t(
  "the meta strip is the four cells asked for",
  html.includes("Billed to") &&
    html.includes("Altman Solon US, LP") &&
    html.includes("Billing entity"),
);
t(
  "the meta strip, tiles and closing bar do not split across pages",
  (html.match(/break-inside: avoid/g) ?? []).length === 3,
);
t("orphans and widows are set", html.includes("orphans: 3") && html.includes("widows: 3"));

t(
  "the three tiles are there, with the due pill",
  html.includes("Total invoiced") &&
    html.includes("Total received") &&
    html.includes("Balance due") &&
    html.includes("Due 4 August 2026"),
);
t(
  "received is green and the balance sits on the yellow surface",
  html.includes("figure-green") && html.includes("--yellow-surface"),
);

t("both tables use a repeating head", (html.match(/<thead>/g) ?? []).length === 2);
t(
  "a credit note is chipped and red",
  html.includes('<span class="chip">Credit note</span>') &&
    html.includes('class="num negative">−377.81'),
);
t(
  "each table closes on a total row",
  (html.match(/class="total"/g) ?? []).length === 2 && html.includes(">300,909.90<"),
);
t(
  "payments carry date, method and reference",
  html.includes("26 Mar 2026") &&
    html.includes("Bank transfer") &&
    html.includes("NABI-FR26-00976"),
);

t(
  "the closing bar states the balance, the payee and the currency",
  html.includes('class="closing-figure">23,332.39<') &&
    html.includes("Payable to Naboo Group · due 4 August 2026 · reference C-P222"),
);
t("the footnote links finance@naboo.app", html.includes('href="mailto:finance@naboo.app"'));
t("nothing is said about netting when nothing was netted", !html.includes("netted off"));
t(
  "a netted statement says what it left out",
  statementHtml({
    ...seed,
    lines: [
      ...seed.lines,
      { ref: "X", type: "invoice", amount: 4500 },
      { ref: "Y", type: "credit_note", amount: -4500 },
    ],
  }).includes(
    "1 invoice and credit-note pair cancelling each other in full is netted off and not listed",
  ),
);

// A settled statement must not ask to be paid.
const paidUp = statementHtml({
  ...seed,
  payments: [...seed.payments, { paidOn: "1 Aug 2026", amount: 23332.39 }],
});
t(
  "a settled statement says nothing is outstanding",
  paidUp.includes("Nothing outstanding") && paidUp.includes("Settled in full"),
);
t("a settled statement drops the due pill", !paidUp.includes("Due 4 August 2026"));
t("a settled statement does not invite a payment", !paidUp.includes("Payable to Naboo Group"));

// ── Safety and the supplier voice ──────────────────────────────────────────
t(
  "a name cannot inject markup",
  statementHtml({ ...seed, billedTo: '<script>alert("x")</script>' }).includes("&lt;script&gt;"),
);
const supplier = statementHtml({ ...seed, side: "supplier", billedTo: "Hôtel Nelligan" });
t(
  "the supplier voice says payable, not invoiced",
  supplier.includes("Total payable") &&
    supplier.includes("Payable to") &&
    supplier.includes("Balance to pay"),
);
t("an accented supplier name survives", supplier.includes("Hôtel Nelligan"));
t(
  "money owed back to us reads as a recovery",
  statementHtml({
    ...seed,
    side: "supplier",
    payments: [{ paidOn: "1 Jul 2026", amount: 400000 }],
  }).includes("Balance to recover"),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
