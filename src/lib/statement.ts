/**
 * The client statement of account for one Marketplace NA booking — data shaping
 * and HTML, with no I/O so both halves can be tested directly.
 *
 * What the document has to get right, in order of how badly it hurts to get wrong:
 *
 *  1. Only documents the client actually received. `NABI-*` are the client's own
 *     invoices; `NABCO-*` are our commission notes to the providers and carry the
 *     FEE_OWNER lines. That filter lives in the query, and the statement never
 *     sees the difference — see statement.functions.ts.
 *  2. Every status, cancelled included. A cancelled invoice always comes with a
 *     credit note reversing it: keep the pair and it nets to zero, drop the
 *     cancelled half and you have subtracted a credit for an invoice that was
 *     never added. That mistake read −113,215.94 on C-V176 against a back office
 *     49,830.47.
 *  3. Only client money as received. `HOST_PAYMENT` inflows are refunds coming
 *     back from providers; on C-P222 they are three lines worth 213,472 USD, and
 *     counting them turns a 23,332.39 receivable into a six-figure credit.
 *
 * The netting below is presentation only: a re-issued invoice and its credit note
 * are dropped from the list because listing them invites "we already credited
 * that", but they are summed either way, so the totals cannot move.
 */

export type StatementDocKind = "INVOICE" | "CREDIT_NOTE";

export type StatementDoc = {
  /** Invoice number as printed on the document the client holds. */
  ref: string;
  kind: StatementDocKind;
  status: string | null;
  currency: string;
  /** Signed: credit notes are negative, as recorded. */
  amount: number;
  /** ISO day. */
  issued: string | null;
  /** ISO day. */
  due: string | null;
};

export type StatementPayment = {
  /** ISO day. */
  paid_on: string | null;
  amount: number;
  currency: string;
  method: string;
  reference: string | null;
};

export type StatementBooking = {
  readable_id: string;
  /** The legal entity the invoices were addressed to. */
  billed_to: string;
  event: string;
  /** The Naboo entity that issued them. */
  billing_entity: string;
  em_referent: string | null;
};

export type StatementInput = {
  booking: StatementBooking;
  documents: StatementDoc[];
  payments: StatementPayment[];
  /** ISO day, computed at request time — never baked into the template. */
  generatedOn: string;
  /**
   * ISO day the warehouse has caught up to, from the last document issued in this
   * booking's own invoice series. Null when there is no series to read.
   *
   * The footnote used to say only "generated on 4 August", which reads as a snapshot of
   * today and quietly omits everything issued since the last sync. This is the number that
   * makes the sentence honest: what the document knows, rather than a completeness it
   * cannot have.
   */
  syncedUpTo?: string | null;
};

// ── Netting ─────────────────────────────────────────────────────────────────

export type NettedDocuments = {
  /** What the table lists, oldest first. */
  shown: StatementDoc[];
  /** How many invoice/credit-note pairs cancelled each other out. */
  nettedPairs: number;
};

function byIssued(a: StatementDoc, b: StatementDoc): number {
  return (a.issued ?? "").localeCompare(b.issued ?? "") || a.ref.localeCompare(b.ref);
}

/**
 * Drops invoice/credit-note pairs that cancel exactly.
 *
 * Matched on currency and absolute amount, in both directions: a re-issue is a
 * credit note for the same figure as the invoice it replaces, whichever order they
 * were recorded in. Where a bucket holds three documents of the same amount — the
 * cancelled invoice, its credit note and the re-issue — one pair goes and the
 * survivor stays, which is exactly the document still owed.
 *
 * Totals are computed from every document, so this never moves a number.
 */
export function netDocuments(docs: StatementDoc[]): NettedDocuments {
  const buckets = new Map<string, StatementDoc[]>();
  for (const d of docs) {
    const key = `${d.currency}::${Math.abs(Math.round(d.amount * 100))}`;
    const list = buckets.get(key) ?? [];
    list.push(d);
    buckets.set(key, list);
  }

  const dropped = new Set<StatementDoc>();
  let nettedPairs = 0;
  for (const list of buckets.values()) {
    const positives = list.filter((d) => d.amount > 0).sort(byIssued);
    const negatives = list.filter((d) => d.amount < 0).sort(byIssued);
    const pairs = Math.min(positives.length, negatives.length);
    for (let i = 0; i < pairs; i++) {
      dropped.add(positives[i]);
      dropped.add(negatives[i]);
    }
    nettedPairs += pairs;
  }

  return { shown: docs.filter((d) => !dropped.has(d)).sort(byIssued), nettedPairs };
}

// ── Totals ──────────────────────────────────────────────────────────────────

export type StatementTotals = {
  currency: string;
  invoiced: number;
  received: number;
  balance: number;
  documentCount: number;
  paymentCount: number;
  /**
   * The oldest date the client was asked to settle by and has not, ISO day.
   *
   * The earliest, not the latest. A statement showing the last invoice's due date presents
   * an overdue balance as future-dated: C-U332 read "Due 6 Aug 2026" while 45,023.30 had
   * been outstanding since 24 July, which undermines the collection the document exists to
   * support.
   */
  dueOn: string | null;
  /** True when that date has passed and money is still owed. */
  overdue: boolean;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Which invoices the money received has actually settled, and the oldest one it has not.
 *
 * A payment carries the number of the invoice it was made against far more often than not
 * — bank references read "PAYING BILL USIUS2600020" — so that is used first: it is the
 * client's own statement of what they were paying for, and no allocation rule beats it.
 * What is left over is applied oldest first, which is the ordinary open-item convention and
 * the only defensible guess when nobody said.
 *
 * Credit notes deliberately settle nothing. A credit reduces what is owed in total, but it
 * is not money against a particular invoice, and treating it as such would silently move
 * the "overdue since" date forward — on C-U332 it would report 31 July instead of the 24
 * July an invoice has genuinely been outstanding since.
 */
export function settleInvoices(
  documents: StatementDoc[],
  payments: StatementPayment[],
): { oldestOpenDue: string | null; openCount: number } {
  const invoices = documents
    .filter((d) => d.amount > 0)
    .map((d) => ({
      ref: normaliseDocRef(d.ref),
      due: d.due,
      remaining: d.amount,
      issued: d.issued,
    }))
    .sort(
      (a, b) =>
        (a.due ?? a.issued ?? "").localeCompare(b.due ?? b.issued ?? "") ||
        a.ref.localeCompare(b.ref),
    );

  let pool = 0;
  for (const payment of payments) {
    const reference = normaliseDocRef(payment.reference);
    // Longest reference first, so USIUS2600020 is preferred over a shorter number that
    // happens to be a substring of the same string.
    const named = reference
      ? invoices
          .filter((i) => i.ref.length > 3 && reference.includes(i.ref) && i.remaining > 0.005)
          .sort((a, b) => b.ref.length - a.ref.length)[0]
      : undefined;
    if (named) {
      const applied = Math.min(named.remaining, payment.amount);
      named.remaining -= applied;
      pool += payment.amount - applied;
    } else {
      pool += payment.amount;
    }
  }

  for (const invoice of invoices) {
    if (pool <= 0.005) break;
    const applied = Math.min(invoice.remaining, pool);
    invoice.remaining -= applied;
    pool -= applied;
  }

  const open = invoices.filter((i) => i.remaining > 0.005 && i.due);
  return { oldestOpenDue: open[0]?.due ?? null, openCount: open.length };
}

/** Case, spacing and punctuation removed, so a bank reference can be searched for a number. */
function normaliseDocRef(ref: string | null | undefined): string {
  return (ref ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * One block of figures per currency. Never one total across currencies: adding
 * dollars to euros produces a number that means nothing, and a client reading a
 * single figure would have no way to tell.
 */
export function statementTotals(input: StatementInput): StatementTotals[] {
  const map = new Map<string, StatementTotals>();
  const of = (currency: string): StatementTotals => {
    const cur = map.get(currency) ?? {
      currency,
      invoiced: 0,
      received: 0,
      balance: 0,
      documentCount: 0,
      paymentCount: 0,
      dueOn: null,
      overdue: false,
    };
    map.set(currency, cur);
    return cur;
  };

  for (const d of input.documents) {
    const t = of(d.currency);
    t.invoiced += d.amount;
    t.documentCount += 1;
  }
  for (const p of input.payments) {
    const t = of(p.currency);
    t.received += p.amount;
    t.paymentCount += 1;
  }

  // Which invoices are still open decides the date, so it is worked out per currency —
  // see settleInvoices for how a payment is attributed to an invoice.
  for (const t of map.values()) {
    const open = settleInvoices(
      input.documents.filter((d) => d.currency === t.currency),
      input.payments.filter((p) => p.currency === t.currency),
    );
    t.dueOn = open.oldestOpenDue;
  }

  return [...map.values()]
    .map((t) => ({
      ...t,
      invoiced: round2(t.invoiced),
      received: round2(t.received),
      balance: round2(t.invoiced - t.received),
      overdue:
        t.dueOn != null && t.dueOn < input.generatedOn && round2(t.invoiced - t.received) > 0.005,
    }))
    .sort(
      (a, b) => Math.abs(b.balance) - Math.abs(a.balance) || a.currency.localeCompare(b.currency),
    );
}

// ── Formatting ──────────────────────────────────────────────────────────────

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Dates are formatted from the ISO day itself: no timezone can shift them. */
function isoParts(day: string | null | undefined): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((day ?? "").trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return [Number(m[1]), month, Number(m[3])];
}

/** `8 Jul 2026` — the table form. */
export function fmtDay(day: string | null | undefined): string {
  const p = isoParts(day);
  return p ? `${p[2]} ${MONTHS_SHORT[p[1] - 1]} ${p[0]}` : "—";
}

/** `31 July 2026` — the prose form. */
export function fmtLongDay(day: string | null | undefined): string {
  const p = isoParts(day);
  return p ? `${p[2]} ${MONTHS_LONG[p[1] - 1]} ${p[0]}` : "—";
}

const MINUS = "−";

/** Grouped to two decimals, with a true minus sign rather than a hyphen. */
export function fmtMoney(amount: number): string {
  const abs = Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return amount < 0 ? `${MINUS}${abs}` : abs;
}

// ── Reading a bank-feed label ───────────────────────────────────────────────

/**
 * Card or wire, from the label alone.
 *
 * How we were paid is not stored: provider_payload_kind says where the bank feed
 * came from, not how the money moved. The signature is in the label — an MCC
 * between pipes, or two bare owner codes joined by a slash. Same rule as the
 * provider disbursements in na.functions.ts, so the two agree.
 */
export function paymentMethodFromLabel(label: string | null | undefined): string {
  const text = label ?? "";
  const mcc = /\|\s*\d{4}\s*\|/.test(text);
  const codePair = /\b[HCO]-[A-Za-z0-9]+\s*\/\s*[HCO]-[A-Za-z0-9]+\b/.test(text);
  return mcc || codePair ? "Card" : "Bank transfer";
}

/**
 * The client's own payment reference, so they can find the line in their ledger.
 *
 * It sits between `reference: ` and ` | id:`. Bank feeds hard-wrap the label, and
 * the break lands mid-token often enough to matter: `StatementC\r\n-P222-CL-…`
 * has to rejoin without a space to read as the reference the client quoted, while
 * `Event,\r\nStatement …` needs one. Rejoining with a space only where the break
 * follows punctuation gets both right.
 */
export function paymentReferenceFromLabel(label: string | null | undefined): string | null {
  const text = (label ?? "").trim();
  if (!text) return null;
  const between = /reference:\s*([\s\S]*?)\s*\|\s*id:/.exec(text);
  const raw = between ? between[1] : text;
  const rejoined = raw.replace(/([\s\S])\r?\n\s*([\s\S])/g, (_m, before: string, after: string) =>
    /[A-Za-z0-9]/.test(before) && /[A-Za-z0-9-]/.test(after)
      ? `${before}${after}`
      : `${before} ${after}`,
  );
  const cleaned = rejoined.replace(/[ \t]+/g, " ").trim();
  return cleaned || null;
}

/**
 * The Event cell.
 *
 * Event names are generated as `{ref} / {company}`, and the statement already
 * prints the ref in its own cell — so the prefix is dropped and the dates take its
 * place, which is what a client checking the period actually wants.
 */
export function eventLabel(
  readableId: string,
  eventName: string | null | undefined,
  startDay: string | null | undefined,
  endDay: string | null | undefined,
): string {
  const name = (eventName ?? "")
    .replace(new RegExp(`^${readableId.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*/\\s*`), "")
    .trim();
  const start = isoParts(startDay);
  const end = isoParts(endDay);
  // A cell narrow enough to wrap should break after the event name, never inside
  // the dates: non-breaking spaces between the words, and a word joiner either side
  // of the en dash, which is otherwise a break opportunity.
  const nb = (s: string) => s.replace(/ /g, "\u00a0").replace(/\u2013/g, "\u2060\u2013\u2060");
  const range =
    start && end && (start[0] !== end[0] || start[1] !== end[1] || start[2] !== end[2])
      ? // Same month: say it once — "21–26 Jun 2026".
        start[0] === end[0] && start[1] === end[1]
        ? nb(`${start[2]}\u2013${fmtDay(endDay)}`)
        : `${nb(fmtDay(startDay))} – ${nb(fmtDay(endDay))}`
      : start
        ? nb(fmtDay(startDay))
        : null;
  return [name || null, range].filter(Boolean).join(" · ") || "—";
}

/**
 * The day the statement is dated, in the market it is issued for.
 *
 * Not the server's UTC day: after 20:00 in New York that is already tomorrow, and
 * a document dated a day ahead of the download is the kind of detail a client
 * notices before anything else on the page.
 */
export function generationDay(now: Date, timeZone = "America/New_York"): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const [y, m, d] = [get("year"), get("month"), get("day")];
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    /* fall through to UTC */
  }
  return now.toISOString().slice(0, 10);
}

export function statementFilename(readableId: string, generatedOn: string): string {
  const safe = readableId.replace(/[^A-Za-z0-9._-]/g, "_") || "booking";
  return `Naboo_statement_${safe}_${generatedOn}.pdf`;
}

// ── HTML ────────────────────────────────────────────────────────────────────

function esc(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The stylesheet.
 *
 * The renderer is Chromium (see pdf.server.ts), the engine the document was drawn in,
 * so nothing here works around a print engine: flex, grid and `break-inside` behave as
 * specified, and the two fonts are loaded from Google Fonts exactly as the app loads
 * them — no `@font-face`, no font file to keep in sync.
 *
 * `@page` carries nothing but `margin: 0`, as the design spec requires: the running
 * header and footer sit flush to the sheet, which a page margin would push inside the
 * page area. The paper size is not declared here either — the renderer asks for Letter,
 * which is the one place it cannot depend on someone's print dialog.
 *
 * Every rule stays scoped to `.naboo-doc` even though the document is now rendered
 * alone: it costs nothing, and it is what let the same markup be embedded in a page
 * without restyling the app around it.
 */
export const DOCUMENT_CSS = `
@page { margin: 0 }
.naboo-doc * { box-sizing: border-box }
.naboo-doc {
  font-family: 'Roboto', sans-serif;
  font-size: 13px;
  line-height: 1.5;
  color: #101F34;
  orphans: 3;
  widows: 3;
  background: #FFFFFF;
}
.naboo-doc .num { font-family: 'Bricolage Grotesque', sans-serif; font-variant-numeric: tabular-nums }

/* Running header — repeats on every page, flush to the sheet. */
.naboo-doc .running-header {
  position: fixed;
  top: 0; left: 0; right: 0;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 18px 44px 16px;
  background: #FAFAF8;
  border-bottom: 1px solid #E5E7EB;
}
.naboo-doc .logo {
  font-family: 'Bricolage Grotesque', sans-serif;
  font-weight: 800;
  font-size: 21px;
  letter-spacing: -0.03em;
  color: #101F34;
}
.naboo-doc .hdr-right { text-align: right }
.naboo-doc .hdr-title {
  display: block;
  font-size: 13px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #101F34;
}
.naboo-doc .hdr-meta { display: block; margin-top: 2px; font-size: 12px; color: #6B7280 }

/* Running footer — repeats on every page. */
.naboo-doc .running-footer {
  position: fixed;
  bottom: 0; left: 0; right: 0;
  display: flex;
  justify-content: space-between;
  padding: 10px 44px 12px;
  border-top: 1px solid #E5E7EB;
  font-size: 10px;
  color: #9CA3AF;
}

/* Per-page clearance for the two bands.
   A fixed element paints on every sheet but reserves no space in the flow, so from the
   second page onwards the content ran underneath both bands: on C-R893 the commission
   documents table's own total row printed behind the header and could not be read at
   all. Page margins would reserve the space, but the design fixes the bands flush to
   the sheet and the page box carries margin: 0 and nothing else — and Chromium
   ignores the renderer's own margins once the CSS declares one, so that is not a way
   out either. A table's header and footer groups do repeat on every page and do reserve
   their height, which is the whole job of these two empty rows. */
.naboo-doc .page-frame { width: 100%; border-collapse: collapse; margin: 0 }
.naboo-doc .page-frame > thead > tr > td { height: 94px; padding: 0; border: none }
.naboo-doc .page-frame > tfoot > tr > td { height: 48px; padding: 0; border: none }
.naboo-doc .page-frame > tbody > tr > td { padding: 0; border: none; vertical-align: top }

/* Content is inset from the sheet's edges; the frame above handles top and bottom. */
.naboo-doc main { padding: 0 44px }

.naboo-doc h1 {
  margin: 0;
  font-family: 'Bricolage Grotesque', sans-serif;
  font-weight: 800;
  font-size: 26px;
  letter-spacing: -0.02em;
  line-height: 1.15;
}
.naboo-doc h1 .ref { color: #9CA3AF; font-weight: 600 }

.naboo-doc .meta {
  display: grid;
  grid-template-columns: 1.4fr 1fr .8fr 1fr;
  gap: 24px;
  margin-top: 14px;
  padding: 14px 0 15px;
  border-top: 1px solid #E5E7EB;
  border-bottom: 1px solid #E5E7EB;
  break-inside: avoid;
}
.naboo-doc .meta-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #9CA3AF;
}
.naboo-doc .meta-value { margin-top: 3px; font-size: 14px; font-weight: 500 }

.naboo-doc .tiles {
  display: grid;
  grid-template-columns: 1fr 1fr 1.15fr;
  gap: 10px;
  margin-top: 16px;
  break-inside: avoid;
}
/* Two tiles rather than three: the commission statement carries only a base and a
   net, and the three-column grid would squeeze both into the left two thirds and
   wrap their labels. */
.naboo-doc .tiles-2 { grid-template-columns: 1fr 1.15fr }
.naboo-doc .tile {
  padding: 13px 16px 14px;
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  background: #FFFFFF;
}
.naboo-doc .tile-due { background: #FBFDE7 }
.naboo-doc .tile-head { display: flex; justify-content: space-between; align-items: center; gap: 8px }
.naboo-doc .tile-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #9CA3AF;
}
.naboo-doc .pill {
  flex: none;
  padding: 2px 8px;
  border-radius: 9999px;
  background: #EFF779;
  font-size: 10px;
  font-weight: 500;
  color: #101F34;
  white-space: nowrap;
}
/* An overdue balance is not the same news as a due one, and the pill is where a reader
   looks first. Red on the DS's own paper tone, not the naboo yellow. */
.naboo-doc .pill-overdue { background: #FDECEC; color: #B4534B; font-weight: 600 }
.naboo-doc .tile-figure { margin-top: 5px; font-size: 23px; font-weight: 700; line-height: 1.1 }
.naboo-doc .tile-figure-received { color: #00B67A }
.naboo-doc .tile-figure-due { font-weight: 800 }
.naboo-doc .tile-caption { margin-top: 3px; font-size: 10px; color: #9CA3AF }

.naboo-doc section { margin-top: 22px }
.naboo-doc .section-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  /* A heading alone at the foot of a page, its table overleaf, reads as a section
     with nothing in it. */
  break-after: avoid;
}
.naboo-doc .section-head h2 {
  margin: 0;
  font-family: 'Bricolage Grotesque', sans-serif;
  font-weight: 700;
  font-size: 17px;
  letter-spacing: -0.01em;
}
.naboo-doc .section-qualifier { font-size: 11px; color: #6B7280; text-align: right }

.naboo-doc table { width: 100%; border-collapse: collapse; margin-top: 8px }
.naboo-doc thead th {
  padding: 0 0 5px;
  border-bottom: 1px solid #101F34;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #9CA3AF;
  text-align: left;
}
.naboo-doc tbody td { padding: 7px 0; border-bottom: 1px solid #E5E7EB; font-size: 13px }
/* A line and the figures it carries belong on the same page. */
.naboo-doc tbody tr { break-inside: avoid }
/* Columns need their own gutter: the reference column is long enough to squeeze
   the dates until they touch the next cell. */
.naboo-doc thead th, .naboo-doc tbody td { padding-right: 16px }
.naboo-doc th.amount, .naboo-doc td.amount {
  text-align: right;
  padding-right: 0;
  padding-left: 12px;
}
/* Figures never break; their headings may. Held on one line, "Commission excl. tax"
   and "Commission incl. tax" are 130px of forced column width each, and four money
   columns of that beside a service name pushed the services table 164px past the
   right edge of the sheet, where the last column was simply cut off. */
.naboo-doc td.amount { white-space: nowrap; font-weight: 500 }
/* A reference is one token and must not be broken. A service name is free text from
   the pricing line and must be allowed to wrap — "Unlimited Tea/Coffee served with
   Madeleines on arrival" on a single line is what made the table too wide. */
.naboo-doc td.ref { font-weight: 500; white-space: nowrap }
.naboo-doc td.name { font-weight: 500 }
.naboo-doc td.day, .naboo-doc td.method { white-space: nowrap }
.naboo-doc td.reference { color: #374151; font-size: 12px }
.naboo-doc .chip {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  background: #F3F4F6;
  font-size: 11px;
  color: #374151;
}
.naboo-doc .credit { color: #DC2626 }
.naboo-doc tbody tr.total td {
  border-bottom: none;
  padding-top: 9px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #6B7280;
}
.naboo-doc tbody tr.total td.amount {
  font-size: 16px;
  font-weight: 700;
  text-transform: none;
  letter-spacing: 0;
  color: #101F34;
}

.naboo-doc .closing {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  margin-top: 22px;
  padding: 16px 22px;
  background: #EFF779;
  border: 1px solid #101F34;
  border-radius: 12px;
  break-inside: avoid;
}
.naboo-doc .closing-title {
  font-family: 'Bricolage Grotesque', sans-serif;
  font-weight: 700;
  font-size: 17px;
}
.naboo-doc .closing-sub { margin-top: 2px; font-size: 11px; color: #374151 }
.naboo-doc .closing-figure { text-align: right; white-space: nowrap }
.naboo-doc .closing-amount { font-size: 28px; font-weight: 800; line-height: 1.1 }
.naboo-doc .closing-ccy {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #374151;
}

.naboo-doc .footnote { margin-top: 18px; font-size: 10px; line-height: 1.6; color: #9CA3AF }
.naboo-doc .footnote a { color: #101F34; text-decoration: underline; text-underline-offset: 2px }

`;

function docRow(d: StatementDoc): string {
  const credit = d.amount < 0;
  const type = d.kind === "CREDIT_NOTE" ? `<span class="chip">Credit note</span>` : "Invoice";
  return `<tr>
  <td class="ref">${esc(d.ref)}</td>
  <td>${type}</td>
  <td class="day">${esc(fmtDay(d.issued))}</td>
  <td class="day">${esc(fmtDay(d.due))}</td>
  <td class="amount num${credit ? " credit" : ""}">${esc(fmtMoney(d.amount))}</td>
</tr>`;
}

function paymentRow(p: StatementPayment): string {
  return `<tr>
  <td class="day">${esc(fmtDay(p.paid_on))}</td>
  <td class="method">${esc(p.method)}</td>
  <td class="reference">${esc(p.reference ?? "—")}</td>
  <td class="amount num">${esc(fmtMoney(p.amount))}</td>
</tr>`;
}

function pluralise(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * One currency's block: the two tables and the closing bar. A booking billed in
 * one currency — every North American booking so far — renders exactly one.
 */
function currencyBlock(
  input: StatementInput,
  totals: StatementTotals,
  netted: NettedDocuments,
  multi: boolean,
): string {
  const docs = netted.shown.filter((d) => d.currency === totals.currency);
  const payments = input.payments.filter((p) => p.currency === totals.currency);
  const nettedHere = netted.nettedPairs;
  const qualifier =
    nettedHere > 0
      ? `Client invoices only · ${pluralise(nettedHere, "re-issued pair")} netted out`
      : "Client invoices only";
  const ccy = esc(totals.currency);
  const suffix = multi ? ` · ${ccy}` : "";

  return `
<section>
  <div class="section-head">
    <h2>Invoices and credit notes${multi ? ` — ${ccy}` : ""}</h2>
    <span class="section-qualifier">${qualifier}</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Document</th><th>Type</th><th>Issued</th><th>Due</th>
        <th class="amount">Amount (${ccy})</th>
      </tr>
    </thead>
    <tbody>
      ${docs.map(docRow).join("\n      ")}
      <tr class="total">
        <td colspan="4">Total invoiced</td>
        <td class="amount num">${esc(fmtMoney(totals.invoiced))}</td>
      </tr>
    </tbody>
  </table>
</section>

<section>
  <div class="section-head">
    <h2>Payments received${multi ? ` — ${ccy}` : ""}</h2>
    <span class="section-qualifier">${
      payments.length > 0
        ? `${pluralise(payments.length, "payment")} credited to your account`
        : "No payment recorded to date"
    }</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Date</th><th>Method</th><th>Reference</th>
        <th class="amount">Amount (${ccy})</th>
      </tr>
    </thead>
    <tbody>
      ${
        payments.length > 0
          ? payments.map(paymentRow).join("\n      ")
          : `<tr><td colspan="3">Nothing received on this booking so far.</td><td class="amount num">${esc(
              fmtMoney(0),
            )}</td></tr>`
      }
      <tr class="total">
        <td colspan="3">Total received</td>
        <td class="amount num">${esc(fmtMoney(totals.received))}</td>
      </tr>
    </tbody>
  </table>
</section>

<div class="closing">
  <div>
    <div class="closing-title">Balance due${suffix}</div>
    <div class="closing-sub">Payable to ${esc(input.booking.billing_entity)} · ${
      totals.dueOn
        ? totals.overdue
          ? `overdue since ${esc(fmtDay(totals.dueOn))}`
          : `due ${esc(fmtDay(totals.dueOn))}`
        : "due on receipt"
    } · reference ${esc(input.booking.readable_id)}</div>
  </div>
  <div class="closing-figure">
    <div class="closing-amount num">${esc(fmtMoney(totals.balance))}</div>
    <div class="closing-ccy">${ccy}</div>
  </div>
</div>`;
}

export type StatementHtmlOptions = {
  /** Contact for the footnote, derived from the event manager by the caller. */
  contact: { email: string; name: string | null };
};

/**
 * The whole document. Every date in it is derived from `generatedOn`, which the
 * server computes at request time — nothing here is baked in at build time.
 */
export function buildStatementHtml(input: StatementInput, options: StatementHtmlOptions): string {
  const totals = statementTotals(input);
  const netted = netDocuments(input.documents);
  const multi = totals.length > 1;
  const headline = totals[0];
  const generated = fmtLongDay(input.generatedOn);
  const currencies = totals.map((t) => t.currency).join(" / ") || "—";
  const { email, name } = options.contact;

  const blocks = totals.map((t) => currencyBlock(input, t, netted, multi)).join("\n");

  const tiles = totals
    .map(
      (t) => `
<div class="tiles">
  <div class="tile">
    <div class="tile-head"><span class="tile-label">Total invoiced</span></div>
    <div class="tile-figure num">${esc(fmtMoney(t.invoiced))}</div>
    <div class="tile-caption">${pluralise(t.documentCount, "document")} · ${esc(t.currency)}</div>
  </div>
  <div class="tile">
    <div class="tile-head"><span class="tile-label">Total received</span></div>
    <div class="tile-figure tile-figure-received num">${esc(fmtMoney(t.received))}</div>
    <div class="tile-caption">${pluralise(t.paymentCount, "payment")} · ${esc(t.currency)}</div>
  </div>
  <div class="tile tile-due">
    <div class="tile-head">
      <span class="tile-label">Balance due</span>
      ${
        t.dueOn
          ? t.overdue
            ? `<span class="pill pill-overdue">Overdue since ${esc(fmtDay(t.dueOn))}</span>`
            : `<span class="pill">Due ${esc(fmtDay(t.dueOn))}</span>`
          : ""
      }
    </div>
    <div class="tile-figure tile-figure-due num">${esc(fmtMoney(t.balance))}</div>
    <div class="tile-caption">Invoiced less received · ${esc(t.currency)}</div>
  </div>
</div>`,
    )
    .join("\n");

  const nettingNote =
    netted.nettedPairs > 0
      ? ` ${pluralise(netted.nettedPairs, "re-issued invoice pair")} ${
          netted.nettedPairs === 1 ? "has" : "have"
        } been netted out of the document list; the totals above include ${
          netted.nettedPairs === 1 ? "it" : "them"
        } either way.`
      : "";

  return documentShell({
    kind: "Statement of account",
    // The running footer says "Statement C-P222", not the whole title.
    footerLabel: "Statement",
    label: "STATEMENT OF ACCOUNT",
    reference: input.booking.readable_id,
    generatedOn: input.generatedOn,
    currencies,
    metaCells: [
      { label: "Billed to", value: input.booking.billed_to },
      { label: "Event", value: input.booking.event },
      { label: "Booking", value: input.booking.readable_id },
      { label: "Billing entity", value: input.booking.billing_entity },
    ],
    entity: input.booking.billing_entity,
    bodyHtml: `${tiles}\n${blocks}`,
    footnoteHtml: `Generated from Naboo's finance records on ${esc(generated)}${
      input.syncedUpTo ? `, synchronised up to ${esc(fmtLongDay(input.syncedUpTo))}` : ""
    }.${esc(nettingNote)}
    Amounts are shown including taxes${headline ? ` in ${esc(currencies)}` : ""}.
    Questions on this statement: <a href="mailto:${esc(email)}">${esc(email)}</a>${
      name ? ` (${esc(name)}, event manager)` : ""
    }.`,
    contactEmail: email,
  });
}

export type DocumentShellOptions = {
  /** Used for the page title and the H1, e.g. "Commission statement". */
  kind: string;
  /** The running footer's own label, when it is shorter than the H1's. */
  footerLabel?: string;
  /** The running header's right-hand label, in caps. */
  label: string;
  reference: string;
  /** ISO day; every date in the document is derived from it. */
  generatedOn: string;
  currencies: string;
  metaCells: Array<{ label: string; value: string }>;
  /** Tiles, tables and the closing bar — already escaped by the caller. */
  bodyHtml: string;
  /** Already escaped, and may contain the contact's mailto link. */
  footnoteHtml: string;
  contactEmail: string;
  /**
   * The legal entity that issued the document, for the running footer.
   *
   * Taken from the booking rather than assumed: the footer read "Naboo Group" on a
   * statement issued by NABOO US Inc., which the balance bar named correctly two
   * centimetres above it. A document that disagrees with itself about who is owed the
   * money invites a call rather than a payment.
   */
  entity?: string | null;
};

/**
 * The document's own markup: the two running bands, the H1, the meta strip and the
 * footnote, around whatever tables the caller built.
 *
 * Markup only — no `<html>`, no `<style>`. It is injected into a route inside the
 * tracker, and the stylesheet (DOCUMENT_CSS) is served alongside it, so the same
 * page a reviewer looks at on screen is the one the browser prints.
 *
 * Shared by every document this tracker issues so they cannot drift apart — the
 * client statement of account and the per-provider commission statement differ in
 * their tables, not in their furniture.
 */
export function documentShell(options: DocumentShellOptions): string {
  const generated = fmtLongDay(options.generatedOn);
  const ref = esc(options.reference);
  return `<div class="naboo-doc">
<header class="running-header">
  <span class="logo">naboo</span>
  <span class="hdr-right">
    <span class="hdr-title">${esc(options.label)}</span>
    <span class="hdr-meta">Booking ${ref} · issued ${esc(generated)} · ${esc(
      options.currencies,
    )}</span>
  </span>
</header>
<footer class="running-footer">
  <span>${esc(options.entity ?? "Naboo Group")} · ${esc(options.contactEmail)}</span>
  <span>${esc(options.footerLabel ?? options.kind)} ${ref} · ${esc(generated)}</span>
</footer>
<table class="page-frame" role="presentation">
<thead><tr><td aria-hidden="true"></td></tr></thead>
<tfoot><tr><td aria-hidden="true"></td></tr></tfoot>
<tbody><tr><td>
<main>
  <h1>${esc(options.kind)} <span class="ref">· ${ref}</span></h1>

  <div class="meta">
${options.metaCells
  .map(
    (c) => `    <div>
      <div class="meta-label">${esc(c.label)}</div>
      <div class="meta-value">${esc(c.value)}</div>
    </div>`,
  )
  .join("\n")}
  </div>

${options.bodyHtml}

  <p class="footnote">
    ${options.footnoteHtml}
  </p>
</main>
</td></tr></tbody>
</table>
</div>`;
}

/**
 * The `<title>`, which browsers offer as the default file name when the reader
 * saves the page as a PDF — so it is the intended file name without its extension,
 * because Chrome appends `.pdf` itself.
 */
export function printTitle(filename: string): string {
  return filename.replace(/\.pdf$/i, "");
}

/**
 * The two typefaces the design is drawn in, loaded the way the app itself loads them
 * (see styles.css). Declared here rather than embedded as font files: the renderer is
 * a browser, so it fetches them, and a committed copy is one more thing to keep in
 * sync with the app's own stylesheet.
 */
export const FONT_STYLESHEET_URL =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700;800" +
  "&family=Roboto:wght@400;500&display=swap";

/**
 * A complete document, for the renderer: the markup, its stylesheet and the fonts.
 *
 * The same body and CSS the page route served, wrapped so Chromium can be handed one
 * string. `html, body { margin: 0 }` is the browser default reset the printable page
 * got from the app's own stylesheet; the document's own rules stay as the design spec
 * requires them — `@page { margin: 0 }` and nothing else.
 */
export function standaloneDocument(input: {
  title: string;
  bodyHtml: string;
  css: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(input.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${esc(FONT_STYLESHEET_URL)}">
<style>html, body { margin: 0; padding: 0 }</style>
<style>${input.css}</style>
</head>
<body>${input.bodyHtml}</body>
</html>`;
}

export { esc as escapeHtml, pluralise };
