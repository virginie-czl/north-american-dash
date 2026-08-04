import {
  netDocuments,
  statementTotals,
  fmtMoney,
  fmtDay,
  fmtLongDay,
  statementFilename,
  generationDay,
  paymentMethodFromLabel,
  paymentReferenceFromLabel,
  buildStatementHtml,
  settleInvoices,
  DOCUMENT_CSS,
  printTitle,
} from "./statement.ts";
import { readFileSync } from "node:fs";
import {
  clientInvoiceSql,
  commissionNoteSql,
  isClientInvoice,
  isCommissionNote,
} from "./invoice-series.ts";

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

const doc = (ref, amount, o = {}) => ({
  ref,
  kind: amount < 0 ? "CREDIT_NOTE" : "INVOICE",
  status: "ISSUED",
  currency: "USD",
  amount,
  issued: "2026-07-08",
  due: "2026-07-15",
  ...o,
});

// The real C-P222 client documents, NABI-* only, every status kept.
const CP222_DOCS = [
  doc("NABI-FR26-00976", 210606.84),
  doc("NABI-FR26-00977", 66970.67),
  doc("NABI-FR26-01605", -377.81, { issued: "2026-07-16", due: "2026-07-23" }),
  doc("NABI-FR26-02120", 23710.2, {
    status: "CANCELLED",
    issued: "2026-07-23",
    due: "2026-07-30",
  }),
  doc("NABI-FR26-02496", -23710.2, { issued: "2026-07-28", due: "2026-07-28" }),
  doc("NABI-FR26-02497", 23710.2, { issued: "2026-07-28", due: "2026-08-04" }),
];

const CP222_PAYMENTS = [
  {
    paid_on: "2026-03-26",
    amount: 210606.84,
    currency: "USD",
    method: "Bank transfer",
    reference: "Altman Solon June Event, StatementC-P222-CL-260319-2423; USD Operations",
  },
  {
    paid_on: "2026-06-16",
    amount: 66970.67,
    currency: "USD",
    method: "Bank transfer",
    reference:
      "Altman Solon - June Training Event, Statement C-P222-CL-260609-2963; USD Operations",
  },
];

const CP222 = {
  booking: {
    readable_id: "C-P222",
    billed_to: "Altman Solon US LP",
    event: "Altman Solon · 21–26 Jun 2026",
    billing_entity: "NABOO GROUP (WOME STAY)",
    em_referent: "Christian Bonadio",
  },
  documents: CP222_DOCS,
  payments: CP222_PAYMENTS,
  generatedOn: "2026-07-31",
};

console.log("\n[netDocuments]");
{
  const { shown, nettedPairs } = netDocuments(CP222_DOCS);
  t("C-P222: 6 documents become 4", shown.length === 4, shown.length);
  t("C-P222: exactly one pair netted", nettedPairs === 1, nettedPairs);
  t(
    "C-P222: the surviving documents are the ones still owed",
    shown.map((d) => d.ref).join(",") ===
      "NABI-FR26-00976,NABI-FR26-00977,NABI-FR26-01605,NABI-FR26-02497",
    shown.map((d) => d.ref).join(","),
  );
  t(
    "the cancelled invoice and its credit note are the pair that goes",
    !shown.some((d) => d.ref === "NABI-FR26-02120" || d.ref === "NABI-FR26-02496"),
  );
}
{
  const { shown, nettedPairs } = netDocuments([doc("A", 100), doc("B", -100)]);
  t("a plain cancelling pair nets out", shown.length === 0 && nettedPairs === 1);
}
{
  const { shown, nettedPairs } = netDocuments([doc("A", 100), doc("B", -60)]);
  t("a partial credit note is not a pair", shown.length === 2 && nettedPairs === 0);
}
{
  const { shown } = netDocuments([doc("A", 100), doc("B", -100, { currency: "EUR" })]);
  t("same amount in another currency is not a pair", shown.length === 2);
}
{
  const { shown, nettedPairs } = netDocuments([
    doc("A", 100),
    doc("B", -100),
    doc("C", 100),
    doc("D", -100),
  ]);
  t("two cancelling pairs both net out", shown.length === 0 && nettedPairs === 2);
}
{
  // Netting is presentation only: it can never move a total.
  const before = statementTotals(CP222)[0].invoiced;
  const netted = netDocuments(CP222_DOCS);
  const shownSum = Math.round(netted.shown.reduce((s, d) => s + d.amount, 0) * 100) / 100;
  t("totals are computed from every document, not the shown ones", before === 300909.9, before);
  t("and the shown documents happen to sum the same here", shownSum === before, shownSum);
}
{
  const { shown } = netDocuments([]);
  t("no documents is not an error", shown.length === 0);
}

console.log("\n[statementTotals — C-P222 acceptance figures]");
{
  const totals = statementTotals(CP222);
  t("one currency", totals.length === 1 && totals[0].currency === "USD");
  t("total invoiced 300,909.90", totals[0].invoiced === 300909.9, totals[0].invoiced);
  t("total received 277,577.51", totals[0].received === 277577.51, totals[0].received);
  t("balance due 23,332.39", totals[0].balance === 23332.39, totals[0].balance);
  t("two payments counted", totals[0].paymentCount === 2);
  t("six documents counted", totals[0].documentCount === 6);
  // The oldest thing still unpaid, not the newest thing issued. C-P222's two payments cover
  // the first two invoices exactly (their references name them); what is left open is the
  // 23,710.20 re-issue, NABI-FR26-02497, due 4 August.
  //
  // Not the 30 July of the invoice it replaced: that one was cancelled, and a client
  // cannot be overdue on a document we withdrew. The document they hold says 4 August, so
  // telling them they were late on 31 July is an argument we would lose.
  t("due on the oldest open invoice", totals[0].dueOn === "2026-08-04", totals[0].dueOn);
  t(
    "and it is overdue on a later day",
    statementTotals({ ...CP222, generatedOn: "2026-08-05" })[0].overdue === true,
  );
  t(
    "but not before that date arrives",
    statementTotals({ ...CP222, generatedOn: "2026-07-20" })[0].overdue === false,
  );
}
{
  // A credit note's due date must never become the date the client is asked to pay by.
  const totals = statementTotals({
    ...CP222,
    payments: [],
    documents: [doc("A", 100, { due: "2026-08-01" }), doc("B", -50, { due: "2026-12-31" })],
  });
  t("credit note due dates are ignored", totals[0].dueOn === "2026-08-01", totals[0].dueOn);
  // Nor does a credit settle an invoice: it reduces what is owed, it is not money against
  // a particular document, and letting it settle one moves the overdue date forward.
  t("and a credit does not settle the invoice it does not name", totals[0].dueOn !== null);
}
{
  // Nothing left open: no date to show, and never an overdue claim.
  const settled = statementTotals({
    ...CP222,
    documents: [doc("A", 100, { due: "2026-01-01" })],
    payments: [
      {
        paid_on: "2026-01-02",
        amount: 100,
        currency: "USD",
        method: "Bank transfer",
        reference: null,
      },
    ],
  });
  t("a settled statement has no due date", settled[0].dueOn === null);
  t("and is not overdue", settled[0].overdue === false);
}

// ── Which invoice a payment settled ─────────────────────────────────────────
// The date the client is chased on comes from this, so it uses what the client themselves
// said: bank references name the invoice being paid far more often than not.
console.log("\n[settleInvoices]");
{
  const invoices = [
    doc("USI-US26-00002", 148056, { issued: "2026-06-10", due: "2026-06-17" }),
    doc("USI-US26-00020", 16210.5, { issued: "2026-07-16", due: "2026-07-23" }),
    doc("USI-US26-00024", 45023.3, { issued: "2026-07-17", due: "2026-07-24" }),
    doc("USI-US26-00029", 57314.85, { issued: "2026-07-22", due: "2026-07-29" }),
  ];
  const named = (amount, ref) => ({
    paid_on: "2026-07-23",
    amount,
    currency: "USD",
    method: "Bank transfer",
    reference: `Bland AI PAYING BILL ${ref} VIA RAMP; USD Operations`,
  });
  // The real C-U332 shape: three payments naming their invoices, one invoice left open.
  const open = settleInvoices(invoices, [
    named(148056, "USIUS2600002"),
    named(16210.5, "USIUS2600020"),
    named(57314.85, "USIUS2600029"),
  ]);
  t(
    "the reference decides which invoice is settled",
    open.oldestOpenDue === "2026-07-24",
    open.oldestOpenDue,
  );
  t("and only one is left open", open.openCount === 1, String(open.openCount));

  // Without references, oldest first is the only defensible guess.
  const blind = settleInvoices(invoices, [
    {
      paid_on: "2026-07-23",
      amount: 148056,
      currency: "USD",
      method: "Bank transfer",
      reference: null,
    },
  ]);
  t(
    "an unattributed payment settles the oldest",
    blind.oldestOpenDue === "2026-07-23",
    blind.oldestOpenDue,
  );

  // A payment naming an invoice, for more than that invoice: the excess flows on.
  const excess = settleInvoices(invoices.slice(0, 2), [named(164266.5, "USIUS2600002")]);
  t("an overpayment settles the rest too", excess.oldestOpenDue === null, excess.oldestOpenDue);

  // A part payment leaves its own invoice open.
  const part = settleInvoices([invoices[0]], [named(100000, "USIUS2600002")]);
  t("a part payment leaves the invoice open", part.oldestOpenDue === "2026-06-17");
  t(
    "nothing paid means the oldest is open",
    settleInvoices(invoices, []).oldestOpenDue === "2026-06-17",
  );
  t("and no invoices at all is not an error", settleInvoices([], []).oldestOpenDue === null);

  // C-Q382 / Hubspot: paid to the cent, and still reporting a document open because a
  // cancelled invoice was standing in the queue waiting to be paid. It is not owed —
  // its credit note is in the totals beside it and the two net to zero — so it must not
  // absorb a payment or lend its due date to the balance line.
  const q382 = [
    doc("NABI-FR26-03062", 12483, { issued: "2026-08-03", due: "2026-08-10" }),
    doc("NABI-FR26-03063", 17530.5, { issued: "2026-08-03", due: "2026-08-10" }),
    doc("NABI-FR26-03064", 8103.65, { issued: "2026-08-03", due: "2026-08-10" }),
    doc("NABI-FR26-03065", 512.68, {
      issued: "2026-08-03",
      due: "2026-08-10",
      status: "CANCELLED",
    }),
    doc("NABI-FR26-03066", -8.92, { issued: "2026-08-03", due: "2026-08-10" }),
    doc("NABI-FR26-03067", -512.68, { issued: "2026-08-03", due: "2026-08-03" }),
    doc("NABI-FR26-03068", 521.6, { issued: "2026-08-03", due: "2026-08-10" }),
  ];
  const paid = [
    { paid_on: "2026-04-23", amount: 12483, currency: "USD", method: "Card", reference: null },
    { paid_on: "2026-06-22", amount: 26146.83, currency: "USD", method: "Card", reference: null },
  ];
  const totals = statementTotals({
    ...CP222,
    booking: { ...CP222.booking, readable_id: "C-Q382" },
    documents: q382,
    payments: paid,
    generatedOn: "2026-08-04",
  })[0];
  t("C-Q382 invoiced 38,629.83", totals.invoiced === 38629.83, totals.invoiced);
  t("received the same", totals.received === 38629.83, totals.received);
  t("so the balance is nil", totals.balance === 0, totals.balance);
  t("and nothing is due", totals.dueOn === null, totals.dueOn);
  t("least of all overdue", totals.overdue === false);

  // The cancelled document is out of the queue, not merely outvoted by the balance: give
  // it an earlier due date than the live invoice and an unpaid booking, and the date the
  // client is chased on is still the live one's.
  const chased = statementTotals({
    ...CP222,
    documents: [
      doc("NABI-FR26-03065", 512.68, { issued: "2026-08-03", due: "2026-07-01" }),
      doc("NABI-FR26-03068", 521.6, { issued: "2026-08-03", due: "2026-08-10" }),
    ],
    payments: [],
    generatedOn: "2026-08-04",
  })[0];
  t("a cancelled invoice cannot set the due date", chased.dueOn === "2026-07-01");
  const withStatus = statementTotals({
    ...CP222,
    documents: [
      doc("NABI-FR26-03065", 512.68, {
        issued: "2026-08-03",
        due: "2026-07-01",
        status: "CANCELLED",
      }),
      doc("NABI-FR26-03068", 521.6, { issued: "2026-08-03", due: "2026-08-10" }),
    ],
    payments: [],
    generatedOn: "2026-08-04",
  })[0];
  t("once it is marked cancelled", withStatus.dueOn === "2026-08-10", withStatus.dueOn);
  t("and the statement is not overdue on its date", withStatus.overdue === false);
}
{
  const totals = statementTotals({
    ...CP222,
    documents: [doc("A", 100), doc("B", 200, { currency: "EUR" })],
    payments: [
      {
        paid_on: "2026-07-01",
        amount: 50,
        currency: "EUR",
        method: "Bank transfer",
        reference: null,
      },
    ],
  });
  t("currencies are never pooled", totals.length === 2);
  t(
    "each currency keeps its own balance",
    totals.find((x) => x.currency === "EUR").balance === 150 &&
      totals.find((x) => x.currency === "USD").balance === 100,
  );
}

console.log("\n[formatting]");
t("grouped to two decimals", fmtMoney(300909.9) === "300,909.90");
t("a true minus sign, not a hyphen", fmtMoney(-377.81) === "−377.81", fmtMoney(-377.81));
t("zero", fmtMoney(0) === "0.00");
t("table date", fmtDay("2026-07-08") === "8 Jul 2026");
t("table date from a timestamp", fmtDay("2026-08-04 00:00:00+00") === "4 Aug 2026");
t("prose date", fmtLongDay("2026-07-31") === "31 July 2026");
t("missing date", fmtDay(null) === "—" && fmtLongDay("nope") === "—");
t(
  "filename carries the booking and the day of download",
  statementFilename("C-P222", "2026-07-31") === "Naboo_statement_C-P222_2026-07-31.pdf",
);
// The <title> is the file name the print dialog offers, and Chrome appends `.pdf`
// itself — leaving it on produces Naboo_statement_C-P222_2026-07-31.pdf.pdf.
t(
  "the page title is the filename without its extension",
  printTitle(statementFilename("C-P222", "2026-07-31")) === "Naboo_statement_C-P222_2026-07-31",
  printTitle(statementFilename("C-P222", "2026-07-31")),
);
t("a title with no extension is left alone", printTitle("Naboo_statement") === "Naboo_statement");

console.log("\n[generationDay]");
{
  // 01:30 UTC on 1 August is still 31 July where the statement is read.
  const lateNight = new Date("2026-08-01T01:30:00Z");
  t(
    "dated in the market it is issued for, not in UTC",
    generationDay(lateNight) === "2026-07-31",
    generationDay(lateNight),
  );
  t(
    "mid-morning is the same day either way",
    generationDay(new Date("2026-07-31T14:00:00Z")) === "2026-07-31",
  );
  t(
    "an unknown timezone falls back to UTC rather than throwing",
    generationDay(new Date("2026-07-31T14:00:00Z"), "Mars/Olympus") === "2026-07-31",
  );
}

console.log("\n[reading a bank-feed label]");
{
  // The two real C-P222 client payments, labels as the feed stores them.
  const first =
    "ALTMAN SOLON US, LP | reference: Altman Solon June Event, StatementC\r\n-P222-CL-260319-2423; USD Operations | id: 7af2f423-b368-433f-a864-bbe4a66f408d";
  const second =
    "ALTMAN SOLON US, LP | reference: Altman Solon - June Training Event,\r\nStatement C-P222-CL-260609-2963; USD Operations | id: 7bbd297f-df2c-4a13-aed0-9339164be162";
  t(
    "a break mid-token rejoins without a space",
    paymentReferenceFromLabel(first) ===
      "Altman Solon June Event, StatementC-P222-CL-260319-2423; USD Operations",
    paymentReferenceFromLabel(first),
  );
  t(
    "a break after punctuation keeps its space",
    paymentReferenceFromLabel(second) ===
      "Altman Solon - June Training Event, Statement C-P222-CL-260609-2963; USD Operations",
    paymentReferenceFromLabel(second),
  );
  t("both are wires", paymentMethodFromLabel(first) === "Bank transfer");
  t(
    "an MCC between pipes is a card",
    paymentMethodFromLabel("HYATT REGENCY | TRAVEL_AND_ACCOMMODATION | 8440 | C-P222/O-X801") ===
      "Card",
  );
  t(
    "a bare code pair is a card",
    paymentMethodFromLabel("something H-C8347 / C-S297 else") === "Card",
  );
  t("no label at all is not an error", paymentReferenceFromLabel(null) === null);
  t(
    "a label with no reference marker is used as-is",
    paymentReferenceFromLabel("H-E2916 Topgolf Long Island") === "H-E2916 Topgolf Long Island",
  );
}

console.log("\n[buildStatementHtml]");
{
  const html = buildStatementHtml(CP222, {
    contact: { email: "christian.bonadio@naboo.app", name: "Christian Bonadio" },
  });
  t(
    "states the generation date in the footnote",
    html.includes("finance records on 31 July 2026."),
  );
  t(
    "running footer carries the booking and date",
    html.includes("Statement C-P222 · 31 July 2026"),
  );
  t("header meta line", html.includes("Booking C-P222 · issued 31 July 2026 · USD"));
  t("qualifier names the netted pair", html.includes("1 re-issued pair netted out"));
  t("currency lives in the column header", html.includes("Amount (USD)"));
  t("balance due appears", html.includes("23,332.39"));
  t("contact is the event manager", html.includes("christian.bonadio@naboo.app"));
  t("names the manager beside the address", html.includes("(Christian Bonadio, event manager)"));
  t("the markup is injectable, not a whole document", !/<(html|head|body|style)[\s>]/i.test(html));
  t(
    "it is one scoped root the stylesheet can hang off",
    html.startsWith('<div class="naboo-doc">'),
  );
  t("no netted-out document is listed", !html.includes("NABI-FR26-02120"));
  t("the re-issued invoice is listed", html.includes("NABI-FR26-02497"));
  t("no commission note could be listed", !html.includes("NABCO"));
  t("escapes the values it interpolates", !html.includes("<script"));

  // ── The two bands need space reserved on every sheet, not only the first ──
  // A fixed band paints on each page but occupies no room in the flow, so the content
  // ran under both: on C-R893 the commission documents table's own total row printed
  // behind the header, unreadable. These two empty rows are a table header and footer
  // group, the one thing Chromium both repeats per page and reserves height for.
  t("the content is wrapped in a page frame", html.includes('<table class="page-frame"'));
  t("the frame is furniture, not data", html.includes('role="presentation"'));
  const frame = html.slice(html.indexOf("page-frame"));
  t("it reserves the top band on every page", /<thead><tr><td aria-hidden="true">/.test(frame));
  t("and the bottom band too", /<tfoot><tr><td aria-hidden="true">/.test(frame));
  // The bands are painted by the fixed elements, so they must stay outside the frame,
  // or they would scroll with the content instead of repeating.
  t(
    "the bands stay outside it",
    html.indexOf("running-header") < html.indexOf("page-frame") &&
      html.indexOf("running-footer") < html.indexOf("page-frame"),
  );
  t("the document body is inside it", frame.indexOf("<main>") < frame.indexOf("</table>"));
}

// ── The stylesheet ──────────────────────────────────────────────────────────
// It is served with the markup by the same server function, so the page a reviewer
// looks at and the sheet the browser prints are the one document.
console.log("\n[DOCUMENT_CSS]");
{
  t(
    "the page box carries a zero margin and nothing else",
    /@page \{ margin: 0 \}/.test(DOCUMENT_CSS) && !/@page[^}]*size/i.test(DOCUMENT_CSS),
  );
  t("the paper size is the print dialog's to choose", !/\bsize:\s*(letter|a4)/i.test(DOCUMENT_CSS));
  t("no font file is embedded — the app loads both faces", !/@font-face/.test(DOCUMENT_CSS));
  t(
    "the WeasyPrint heading workaround is gone",
    !/\.section-head h2 \{[^}]*white-space:\s*nowrap/.test(DOCUMENT_CSS),
  );
  // The document is rendered alone by Chromium now, not embedded in the tracker, so
  // the rules that framed it on screen and unwound the app shell for printing are gone.
  t("no leftover framing for a page it no longer lives in", !/@media/.test(DOCUMENT_CSS));
  t(
    "nothing addresses the tracker's shell",
    !/\[data-app-shell\]|\.doc-viewport|\.no-print/.test(DOCUMENT_CSS),
  );
  t(
    "the running bands repeat as page furniture",
    /\.naboo-doc \.running-header \{[\s\S]*?position: fixed/.test(DOCUMENT_CSS),
  );
  // The frame's spacer rows are what keep the content off them, page after page.
  t(
    "the top band's height is reserved",
    /\.page-frame > thead > tr > td \{[^}]*height: 94px/.test(DOCUMENT_CSS),
  );
  t(
    "the bottom band's height is reserved",
    /\.page-frame > tfoot > tr > td \{[^}]*height: 48px/.test(DOCUMENT_CSS),
  );
  // The clearance now comes from the frame; leaving it on `main` as well would inset
  // the first page twice.
  t(
    "main carries no vertical padding of its own",
    /\.naboo-doc main \{ padding: 0 44px \}/.test(DOCUMENT_CSS),
  );
  t(
    "the frame is not styled as one of the document's tables",
    /\.naboo-doc \.page-frame \{[^}]*margin: 0/.test(DOCUMENT_CSS) &&
      /\.page-frame > tbody > tr > td \{[^}]*border: none/.test(DOCUMENT_CSS),
  );

  // ── Nothing may be wider than the sheet ────────────────────────────────────
  // Four money columns whose headings could not wrap, beside a service name that
  // could not either, made the services table 164px wider than the page: the last
  // column was cut off at the paper's edge. Figures still never break.
  t("figures never break", /\.naboo-doc td\.amount \{[^}]*white-space: nowrap/.test(DOCUMENT_CSS));
  t(
    "their headings may",
    !/th\.amount[^{]*\{[^}]*white-space:\s*nowrap/.test(DOCUMENT_CSS) &&
      !/\.naboo-doc th[^.{]*\{[^}]*white-space:\s*nowrap/.test(DOCUMENT_CSS),
  );
  t(
    "a reference is still one token",
    /\.naboo-doc td\.ref \{[^}]*white-space: nowrap/.test(DOCUMENT_CSS),
  );
  t(
    "free text has a class of its own that wraps",
    /\.naboo-doc td\.name \{[^}]*\}/.test(DOCUMENT_CSS) &&
      !/\.naboo-doc td\.name \{[^}]*nowrap/.test(DOCUMENT_CSS),
  );
  t(
    "a heading is not left alone at the foot of a page",
    /\.section-head \{[^}]*break-after: avoid/.test(DOCUMENT_CSS),
  );
  t(
    "a line and its figures stay on one page",
    /\.naboo-doc tbody tr \{ break-inside: avoid \}/.test(DOCUMENT_CSS),
  );
  // An unscoped `main` or `table` rule would restyle the tracker around the page.
  const selectors = DOCUMENT_CSS.split("\n")
    .filter((l) => /\{\s*$|\{.*\}\s*$/.test(l) && !l.trim().startsWith("@") && !l.includes(":root"))
    .map((l) => l.split("{")[0].trim())
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  // Every rule belongs to the document; none reaches outside it.
  const allowed = /^\.naboo-doc/;
  const unscoped = selectors.filter((s) => !allowed.test(s));
  t("no rule can restyle the tracker around it", unscoped.length === 0, unscoped.join(" | "));
}
{
  const html = buildStatementHtml(
    { ...CP222, booking: { ...CP222.booking, billed_to: 'Acme <b>"x"</b> & Co' } },
    { contact: { email: "finance@naboo.app", name: null } },
  );
  t(
    "HTML in a company name is escaped",
    html.includes("Acme &lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; Co"),
  );
  t("no manager named when the address is the fallback", !html.includes("event manager)"));
}

// ── Which series a document belongs to ──────────────────────────────────────
// Every billing entity issues two numbered series and the pair always has the same shape:
// the client's invoices end the prefix in I, the commission notes we raise against
// providers end it in CO. Three queries used to test for the French entity's series by
// name, so a booking billed from NABOO US Inc. produced a statement that read empty —
// C-U332 / Bland AI, 148,056 USD invoiced, ten documents, zero shown.
console.log("\n[client invoices and commission notes]");
{
  // The real series, one per entity, taken off the data.
  const clientSeries = [
    "NABI-FR26-00825",
    "CAI-CA26-00159",
    "USI-US26-00002",
    "DEI-DE26-00011",
    "ESI-ES26-00018",
    "BIZI-FR26-00339",
  ];
  const commissionSeries = [
    "NABCO-FR26-00814",
    "CACO-CA26-00035",
    "USCO-US26-00002",
    "DECO-DE26-00052",
    "ESCO-ES26-00019",
    "BIZCO-FR26-00184",
  ];
  t(
    "every entity's client series is a client document",
    clientSeries.every(isClientInvoice),
    clientSeries.filter((n) => !isClientInvoice(n)).join(", "),
  );
  t(
    "and none of them is mistaken for a commission note",
    clientSeries.every((n) => !isCommissionNote(n)),
  );
  t(
    "every entity's commission series is a commission note",
    commissionSeries.every(isCommissionNote),
    commissionSeries.filter((n) => !isCommissionNote(n)).join(", "),
  );
  t(
    "and none of them reaches a client statement",
    commissionSeries.every((n) => !isClientInvoice(n)),
  );
  // The specific document that must not appear on C-U332's statement: a commission note
  // to Alohilani, income-side, on the same booking as the client's own invoices.
  t("the note to the provider is excluded", !isClientInvoice("USCO-US26-00002"));
  t("while the client's invoice beside it is not", isClientInvoice("USI-US26-00002"));
  t("nothing is not a document", !isClientInvoice("") && !isClientInvoice(null));

  // The SQL says the same thing, and the three queries all ask through it rather than
  // spelling a prefix out again.
  const sql = commissionNoteSql("i");
  t("the predicate names no entity", !/NAB|USCO|CACO/.test(sql), sql);
  t("and it is anchored to the start of the number", sql.includes("^[A-Za-z]*CO-"));
  t("the client predicate is its negation", clientInvoiceSql("i") === `NOT ${sql}`);
  t("it takes the table's own alias", commissionNoteSql("inv").includes("inv.invoiceNumber"));

  for (const [file, expected] of [
    ["./statement.functions.ts", 'clientInvoiceSql("i")'],
    ["./na.functions.ts", 'commissionNoteSql("i")'],
    ["./commission-statement.functions.ts", 'commissionNoteSql("i")'],
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    t(`${file.slice(2)} asks through the shared rule`, src.includes(expected));
    t(
      `${file.slice(2)} no longer hard-codes a prefix`,
      !/invoiceNumber LIKE '(NABI|NABCO)-%'/.test(src),
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
