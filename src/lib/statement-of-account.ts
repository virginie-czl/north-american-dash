/**
 * Statement of account — the printable document, in Naboo's own brand.
 *
 * This is an HTML print template rather than a hand-built PDF, because the
 * design needs things only a print engine gives you: Bricolage Grotesque and
 * Roboto, 12px card radii, coloured surfaces, a running header and footer that
 * repeat on every page, and `<thead>` rows that repeat with a table. The PDF
 * comes out of the browser's own "Save as PDF" — which is what the print rules
 * below are written for.
 *
 * Letter, flowing layout. The only `@page` rule is its margin; the header and
 * footer are fixed elements, so they repeat, with body padding standing in for
 * the space they occupy.
 *
 * Pure: a typed object in, a document out. Nothing here knows about the DOM,
 * the tracker, or where the figures came from.
 */

export type StatementLineType = "invoice" | "credit_note";

export type StatementLine = {
  ref: string;
  type: StatementLineType;
  /** Overrides the word in the Type column — "Commission", "Adjustment". */
  chip?: string | null;
  /** ISO or already-formatted; printed as given. */
  issued?: string | null;
  due?: string | null;
  /** Signed: a credit note is negative. */
  amount: number;
};

export type StatementReceipt = {
  paidOn: string;
  method?: string | null;
  reference?: string | null;
  amount: number;
};

export type StatementOfAccount = {
  billedTo: string;
  event: string;
  bookingRef: string;
  billingEntity: string;
  currency: string;
  /** The date the statement itself was drawn up. */
  issuedOn: string;
  dueOn?: string | null;
  lines: StatementLine[];
  payments: StatementReceipt[];
  /**
   * What was received, when the individual receipts are not in the tracker. The
   * payments table then says so rather than implying nothing was paid.
   */
  receivedTotal?: number | null;
  /** Who the money is paid to, and the reference to quote — the closing bar. */
  payee?: string | null;
  paymentReference?: string | null;
  /** Reverses the voice: what we owe a supplier rather than what a client owes. */
  side?: "client" | "supplier";
  contactEmail?: string;
};

const BRAND = {
  navy: "#101F34",
  yellow: "#EFF779",
  yellowSurface: "#FBFDE7",
  offWhite: "#FAFAF8",
  border: "#E5E7EB",
  gray700: "#374151",
  gray500: "#6B7280",
  gray400: "#9CA3AF",
  chip: "#F3F4F6",
  green: "#00B67A",
  red: "#DC2626",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `210,606.84`. A true minus sign, never a hyphen, on a negative figure. */
export function money(value: number): string {
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
  return value < 0 ? `−${formatted}` : formatted;
}

/**
 * Drop invoice and credit-note pairs that cancel each other out.
 *
 * A credit note issued to void an invoice in full tells the reader nothing: the
 * two lines net to zero and only make the statement longer and harder to tie to
 * the balance. Removing both leaves every total untouched — which is the point,
 * and why it is safe.
 *
 * Pairing is on the amount alone, biggest first, one credit note against one
 * invoice. It is deliberately conservative: a partial credit note never cancels
 * anything, and stays listed.
 */
export function netOffCancellingLines(lines: StatementLine[]): {
  lines: StatementLine[];
  netted: number;
} {
  const credits = lines.filter((l) => l.amount < -0.005).sort((a, b) => a.amount - b.amount); // most negative first
  const remaining = new Set(lines);
  let netted = 0;

  for (const credit of credits) {
    if (!remaining.has(credit)) continue;
    const match = [...remaining].find(
      (l) => l !== credit && l.amount > 0.005 && Math.abs(l.amount + credit.amount) < 0.005,
    );
    if (!match) continue;
    remaining.delete(credit);
    remaining.delete(match);
    netted += 1;
  }

  return { lines: lines.filter((l) => remaining.has(l)), netted };
}

export type StatementTotals = {
  invoiced: number;
  received: number;
  balance: number;
};

/**
 * The totals come from every line, netted or not — cancelling pairs sum to zero,
 * so hiding them cannot move a total.
 */
export function statementTotals(data: StatementOfAccount): StatementTotals {
  const invoiced = data.lines.reduce((total, l) => total + l.amount, 0);
  const received =
    data.payments.length > 0
      ? data.payments.reduce((total, p) => total + p.amount, 0)
      : (data.receivedTotal ?? 0);
  return {
    invoiced: round(invoiced),
    received: round(received),
    balance: round(invoiced - received),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The Naboo mark, at the size the header sets it. */
const LOGO = `<svg viewBox="0 0 19 32" width="15" height="25" fill="currentColor" aria-hidden="true"><path d="M18.3224 18.2291V31.606H12.8998V17.355C12.8998 13.4644 12.1129 11.5406 10.1011 11.5406C7.78332 11.5406 5.68484 13.9889 5.37882 19.6714V31.606H0V13.4644C2.05549 13.1585 4.02281 12.0658 5.37882 10.7539V17.6609C5.99087 13.2896 7.91521 10.5791 12.3752 10.5791C16.2669 10.5791 18.2786 13.2459 18.3224 18.2291Z"/></svg>`;

function cell(label: string, value: string): string {
  return `<div class="cell"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}

function tile(opts: {
  label: string;
  figure: string;
  caption: string;
  tone?: "green" | "balance";
  pill?: string | null;
}): string {
  const classes = ["tile", opts.tone === "balance" ? "tile-balance" : ""].filter(Boolean).join(" ");
  const figureClass = [
    "figure",
    opts.tone === "green" ? "figure-green" : "",
    opts.tone === "balance" ? "figure-balance" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<div class="${classes}">
        <div class="tile-head">
          <div class="label">${escapeHtml(opts.label)}</div>
          ${opts.pill ? `<span class="pill">${escapeHtml(opts.pill)}</span>` : ""}
        </div>
        <div class="${figureClass}">${escapeHtml(opts.figure)}</div>
        <div class="caption">${escapeHtml(opts.caption)}</div>
      </div>`;
}

/**
 * The document. Data drives every string; the only literals are labels and the
 * two notes at the foot.
 */
export function statementHtml(data: StatementOfAccount): string {
  const totals = statementTotals(data);
  const { lines, netted } = netOffCancellingLines(data.lines);
  const supplier = data.side === "supplier";
  const contact = data.contactEmail ?? "finance@naboo.app";
  const meta = [`Booking ${data.bookingRef}`, `issued ${data.issuedOn}`, data.currency].join(" · ");

  const lineRows = lines
    .map((line) => {
      const credit = line.type === "credit_note";
      return `<tr>
            <td class="ref">${escapeHtml(line.ref)}</td>
            <td>${
              line.chip
                ? `<span class="chip">${escapeHtml(line.chip)}</span>`
                : credit
                  ? `<span class="chip">Credit note</span>`
                  : "Invoice"
            }</td>
            <td>${escapeHtml(line.issued ?? "—")}</td>
            <td>${escapeHtml(line.due ?? "—")}</td>
            <td class="num${credit ? " negative" : ""}">${money(line.amount)}</td>
          </tr>`;
    })
    .join("\n");

  const paymentRows = data.payments
    .map(
      (p) => `<tr>
            <td>${escapeHtml(p.paidOn)}</td>
            <td>${escapeHtml(p.method ?? "—")}</td>
            <td class="ref">${escapeHtml(p.reference ?? "—")}</td>
            <td class="num">${money(p.amount)}</td>
          </tr>`,
    )
    .join("\n");

  const settled = Math.abs(totals.balance) < 0.005;
  const recovering = supplier && totals.balance < -0.005;
  // A settled statement must not ask to be paid: no due date, no payee, no
  // "balance due" over a zero.
  const balanceLabel = settled
    ? "Nothing outstanding"
    : supplier
      ? recovering
        ? "Balance to recover"
        : "Balance to pay"
      : "Balance due";
  // The direction is in the label, so the figure is written without its sign —
  // "Balance to recover −15,600.00" reads as a double negative.
  const balanceFigure = money(recovering ? Math.abs(totals.balance) : totals.balance);

  const closingSub = settled
    ? `Settled in full · reference ${data.paymentReference ?? data.bookingRef}`
    : [
        data.payee
          ? recovering
            ? `To be refunded by ${data.payee}`
            : `Payable to ${data.payee}`
          : null,
        data.dueOn ? `due ${data.dueOn}` : null,
        data.paymentReference ? `reference ${data.paymentReference}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Statement of account · ${escapeHtml(data.bookingRef)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=Roboto:wght@400;500&display=swap" rel="stylesheet">
<style>
  @page { margin: 0; }

  :root {
    --navy: ${BRAND.navy};
    --yellow: ${BRAND.yellow};
    --yellow-surface: ${BRAND.yellowSurface};
    --off-white: ${BRAND.offWhite};
    --border: ${BRAND.border};
    --gray-700: ${BRAND.gray700};
    --gray-500: ${BRAND.gray500};
    --gray-400: ${BRAND.gray400};
    --chip: ${BRAND.chip};
    --green: ${BRAND.green};
    --red: ${BRAND.red};
  }

  * { box-sizing: border-box; }

  html { background: #fff; }

  body {
    margin: 0;
    width: 8.5in;
    font-family: Roboto, system-ui, -apple-system, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: var(--navy);
    /* Room for the fixed header and footer, which repeat on every page. */
    padding: 78px 0 46px;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    orphans: 3;
    widows: 3;
  }

  h1, h2, .figure, .num, .total-figure, .closing-figure {
    font-family: "Bricolage Grotesque", Roboto, system-ui, sans-serif;
  }

  .num, .figure, .total-figure, .closing-figure, .value, td, th {
    font-variant-numeric: tabular-nums;
  }

  /* ── 1. Running header ─────────────────────────────────────────────────── */
  .running-header {
    position: fixed;
    top: 0; left: 0; right: 0;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    padding: 18px 44px 16px;
    background: var(--off-white);
    border-bottom: 1px solid var(--border);
  }
  .running-header .mark { color: var(--navy); display: flex; }
  .header-right { text-align: right; }
  .doc-kind {
    font-size: 13px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .doc-meta { margin-top: 3px; font-size: 12px; color: var(--gray-500); }

  /* ── 9. Running footer ─────────────────────────────────────────────────── */
  .running-footer {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    display: flex;
    justify-content: space-between;
    gap: 24px;
    padding: 10px 44px 12px;
    font-size: 10px;
    color: var(--gray-400);
    border-top: 1px solid var(--border);
    background: #fff;
  }
  .running-footer a { color: var(--gray-400); text-decoration: none; }

  /* ── 2. Content ────────────────────────────────────────────────────────── */
  main { padding: 26px 44px 0; }

  /* ── 3. Title ──────────────────────────────────────────────────────────── */
  h1 {
    margin: 0;
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.02em;
  }
  h1 .ref { color: var(--gray-400); font-weight: 600; }

  /* ── 4. Meta strip ─────────────────────────────────────────────────────── */
  .meta-strip {
    display: grid;
    grid-template-columns: 1.4fr 1fr 0.8fr 1fr;
    gap: 24px;
    margin-top: 14px;
    padding: 14px 0 15px;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    break-inside: avoid;
  }
  .label {
    font-size: 10px;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--gray-400);
  }
  .cell .value { margin-top: 3px; font-size: 14px; font-weight: 500; }

  /* ── 5. Summary tiles ──────────────────────────────────────────────────── */
  .tiles {
    display: grid;
    grid-template-columns: 1fr 1fr 1.15fr;
    gap: 10px;
    margin-top: 14px;
    break-inside: avoid;
  }
  .tile {
    padding: 13px 16px 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: #fff;
  }
  .tile-balance { background: var(--yellow-surface); }
  .tile-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .pill {
    padding: 2px 9px;
    border-radius: 9999px;
    background: var(--yellow);
    font-size: 10px;
    font-weight: 500;
    color: var(--navy);
    white-space: nowrap;
  }
  .figure { margin-top: 5px; font-size: 23px; font-weight: 700; letter-spacing: -0.01em; }
  .figure-green { color: var(--green); }
  .figure-balance { font-weight: 800; }
  .caption { margin-top: 2px; font-size: 10px; color: var(--gray-500); }

  /* ── 6. Tables ─────────────────────────────────────────────────────────── */
  .section { margin-top: 22px; }
  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
  }
  .section-head h2 { margin: 0; font-size: 17px; font-weight: 700; }
  .qualifier { font-size: 11px; color: var(--gray-500); text-align: right; }

  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  thead th {
    padding: 0 0 6px;
    font-family: Roboto, sans-serif;
    font-size: 10px;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--gray-400);
    text-align: left;
    border-bottom: 1px solid var(--navy);
  }
  thead th.num, tbody td.num { text-align: right; }
  tbody td {
    padding: 7px 0;
    border-bottom: 1px solid var(--border);
    color: var(--gray-700);
  }
  tbody td.ref { color: var(--navy); }
  tbody td.num { font-size: 13px; font-weight: 500; color: var(--navy); }
  tbody td.negative { color: var(--red); }
  .chip {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 4px;
    background: var(--chip);
    font-size: 11px;
    color: var(--gray-700);
  }
  tr.total td {
    border-bottom: 0;
    padding-top: 9px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--gray-400);
  }
  tr.total td.num {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: none;
    color: var(--navy);
  }

  /* ── 7. Closing balance ────────────────────────────────────────────────── */
  .closing {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    margin-top: 22px;
    padding: 16px 22px;
    background: var(--yellow);
    border: 1px solid var(--navy);
    border-radius: 12px;
    break-inside: avoid;
  }
  .closing-label { font-family: "Bricolage Grotesque", Roboto, sans-serif; font-size: 17px; font-weight: 700; }
  .closing-sub { margin-top: 2px; font-size: 11px; color: var(--gray-700); }
  .closing-right { text-align: right; }
  .closing-figure { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; }
  .closing-ccy { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--gray-700); }

  /* ── 8. Footnote ───────────────────────────────────────────────────────── */
  .footnote { margin: 16px 0 0; font-size: 10px; color: var(--gray-400); }
  .footnote a { color: var(--navy); text-decoration: underline; text-underline-offset: 2px; }

  /* An address someone copies out of the PDF must not come with an "fi"
     ligature glued into it — some mail clients will not resolve it. */
  a[href^="mailto"] { font-variant-ligatures: none; }

  /* On screen only: the way to the PDF. */
  .print-bar {
    display: flex;
    justify-content: flex-end;
    padding: 12px 44px 0;
  }
  .print-bar button {
    font-family: Roboto, sans-serif;
    font-size: 12px;
    padding: 7px 14px;
    border-radius: 9999px;
    border: 1px solid var(--navy);
    background: var(--yellow);
    color: var(--navy);
    cursor: pointer;
  }
  @media print { .print-bar { display: none; } }
</style>
</head>
<body>
  <div class="running-header">
    <span class="mark">${LOGO}</span>
    <div class="header-right">
      <div class="doc-kind">Statement of account</div>
      <div class="doc-meta">${escapeHtml(meta)}</div>
    </div>
  </div>

  <div class="print-bar"><button type="button" onclick="window.print()">Save as PDF</button></div>

  <main>
    <h1>Statement of account <span class="ref">· ${escapeHtml(data.bookingRef)}</span></h1>

    <section class="meta-strip">
      ${cell(supplier ? "Payable to" : "Billed to", data.billedTo)}
      ${cell("Event", data.event)}
      ${cell("Booking", data.bookingRef)}
      ${cell("Billing entity", data.billingEntity)}
    </section>

    <section class="tiles">
      ${tile({
        label: supplier ? "Total payable" : "Total invoiced",
        figure: money(totals.invoiced),
        caption: `${lines.length} line${lines.length === 1 ? "" : "s"} · ${data.currency}`,
      })}
      ${tile({
        label: supplier ? "Total paid" : "Total received",
        figure: money(totals.received),
        caption:
          data.payments.length > 0
            ? `${data.payments.length} payment${data.payments.length === 1 ? "" : "s"}`
            : "Recorded as a total",
        tone: "green",
      })}
      ${tile({
        label: balanceLabel,
        figure: balanceFigure,
        caption: settled ? "Settled in full" : `In ${data.currency}`,
        tone: "balance",
        pill: !settled && data.dueOn ? `Due ${data.dueOn}` : null,
      })}
    </section>

    <section class="section">
      <div class="section-head">
        <h2>${supplier ? "Amounts payable" : "Invoices and credit notes"}</h2>
        <div class="qualifier">All amounts inclusive of tax, in ${escapeHtml(data.currency)}</div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Reference</th>
            <th>Type</th>
            <th>Issued</th>
            <th>Payment due</th>
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${lineRows || `<tr><td colspan="5">Nothing issued on this booking yet.</td></tr>`}
          <tr class="total">
            <td colspan="4">${supplier ? "Total payable" : "Total invoiced"}</td>
            <td class="num">${money(totals.invoiced)}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>${supplier ? "Payments made" : "Payments received"}</h2>
        <div class="qualifier">${
          data.payments.length > 0
            ? "Applied in date order"
            : "Recorded as a total in the tracker; individual receipts are not itemised"
        }</div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Method</th>
            <th>Reference</th>
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${
            paymentRows ||
            `<tr><td colspan="4">${
              (data.receivedTotal ?? 0) > 0.005
                ? "Receipts are held as a total, not line by line."
                : "No payment recorded yet."
            }</td></tr>`
          }
          <tr class="total">
            <td colspan="3">${supplier ? "Total paid" : "Total received"}</td>
            <td class="num">${money(totals.received)}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="closing">
      <div>
        <div class="closing-label">${balanceLabel}</div>
        ${closingSub ? `<div class="closing-sub">${escapeHtml(closingSub)}</div>` : ""}
      </div>
      <div class="closing-right">
        <div class="closing-figure">${balanceFigure}</div>
        <div class="closing-ccy">${escapeHtml(data.currency)}</div>
      </div>
    </section>

    <p class="footnote">
      Generated on ${escapeHtml(data.issuedOn)}.${
        netted > 0
          ? ` ${netted} invoice and credit-note pair${netted === 1 ? "" : "s"} cancelling each other in full ${netted === 1 ? "is" : "are"} netted off and not listed; the totals are unchanged.`
          : ""
      }
      Questions on any line: <a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>.
    </p>
  </main>

  <div class="running-footer">
    <span>Naboo Group · <a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a></span>
    <span>Statement ${escapeHtml(data.bookingRef)} · ${escapeHtml(data.issuedOn)}</span>
  </div>

  <script>
    // Opened from the tracker with #print: go straight to the print dialog, so
    // "Save as PDF" is one step. A file opened from a zip just renders.
    if (location.hash === "#print") window.addEventListener("load", () => window.print());
  </script>
</body>
</html>
`;
}
