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
  DOCUMENT_CSS,
  printTitle,
} from "./statement.ts";

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
  t("due on the latest invoice's own due date", totals[0].dueOn === "2026-08-04", totals[0].dueOn);
}
{
  // A credit note's due date must never become the date the client is asked to pay by.
  const totals = statementTotals({
    ...CP222,
    documents: [doc("A", 100, { due: "2026-08-01" }), doc("B", -50, { due: "2026-12-31" })],
  });
  t("credit note due dates are ignored", totals[0].dueOn === "2026-08-01", totals[0].dueOn);
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
  t("screen chrome is hidden in print", /@media print \{[\s\S]*\.no-print/.test(DOCUMENT_CSS));
  t(
    "the app shell is unwound so the document is not cropped to one screen",
    /\[data-app-shell\]/.test(DOCUMENT_CSS),
  );
  t(
    "the running bands repeat as page furniture",
    /\.naboo-doc \.running-header \{[\s\S]*?position: fixed/.test(DOCUMENT_CSS),
  );
  // An unscoped `main` or `table` rule would restyle the tracker around the page.
  const selectors = DOCUMENT_CSS.split("\n")
    .filter((l) => /\{\s*$|\{.*\}\s*$/.test(l) && !l.trim().startsWith("@") && !l.includes(":root"))
    .map((l) => l.split("{")[0].trim())
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  // The only rules allowed to reach outside the document are the print-time ones
  // that unwind the tracker's shell, and they are named — not element selectors.
  const allowed = /^(\.naboo-doc|\.no-print|\.doc-viewport|html$|body$|\[data-app-shell\])/;
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
