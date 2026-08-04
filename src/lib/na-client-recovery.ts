/**
 * Client recovery for Marketplace NA — chasing a client for a balance they owe us.
 *
 * The partner side of this tracker recovers money we paid out by mistake
 * (na-commission-requests.ts). This is the other direction: invoices we issued
 * to the client that have not been settled.
 *
 * Two things make it more than "invoiced minus received":
 *
 *  - A booking is only worth chasing once the dust has settled. A balance is a
 *    recovery a full week after the event *and* a full week after the most
 *    recent invoice went out — an invoice issued yesterday is not late, whatever
 *    the event date says.
 *  - Documents that cancel each other out are not a balance. A 100 invoice with
 *    a 100 credit note against it nets to nothing, and neither belongs in an
 *    email asking for money: listing them would invite exactly the "we already
 *    credited that" reply the email is trying to avoid.
 *
 * Every figure in the email is computed from the documents the email itself
 * lists, so the totals always add up in the reader's hands. That is deliberately
 * not the tracker's own `balance_ccy`, which sums invoice *line items* across
 * every status and so still carries voided invoices.
 */
import type { NaRow, NaInvoiceLine, NaClientReceipt } from "./na.functions";

/** Days of grace after the event, and after the last invoice, before we chase. */
export const RECOVERY_GRACE_DAYS = 7;

export type NaClientBalance = { invoiced: number; paid: number; outstanding: number };

export type NaClientRecovery = {
  /** Live client documents, oldest first: what the email lists. */
  docs: NaInvoiceLine[];
  receipts: NaClientReceipt[];
  byCurrency: Map<string, NaClientBalance>;
  /** The currency carrying the largest balance — the one the subject quotes. */
  currency: string | null;
  invoiced: number;
  paid: number;
  outstanding: number;
  /** ISO day the most recent live invoice was issued. */
  lastInvoiceDay: string | null;
  daysSinceEvent: number | null;
  daysSinceInvoice: number | null;
  /** At least one live invoice is past its own due date. */
  anyOverdue: boolean;
  /** The Naboo entity that issued the invoices, e.g. "NABOO US Inc." */
  entityName: string | null;
  /** Set only when every live document agrees on one receiving account. */
  bankDetails: string | null;
  paymentMeans: string | null;
  eligible: boolean;
};

/** The date part of an emission/due stamp, which arrives as a full timestamp. */
function isoDay(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const day = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function dayMs(raw: string | null | undefined): number | null {
  const day = isoDay(raw);
  if (!day) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

function daysBetween(from: number, to: number): number {
  return Math.floor((to - from) / 86_400_000);
}

/**
 * The client documents that still represent money, oldest first.
 *
 * Grouping is by the invoice a credit note reverses (`cancels_invoice_id`), so a
 * document and its reversals are weighed together. A group is dropped when
 *
 *  - it nets to zero, i.e. the documents fully cancel each other; or
 *  - its invoice was cancelled outright, whether or not a credit note followed.
 *    A voided invoice is never something to chase, and a cancelled invoice left
 *    only partly credited is a data anomaly we resolve in the client's favour.
 *
 * A credit note whose invoice is not in the list (issued against another
 * booking) survives on its own and reduces the total, same reasoning.
 */
export function liveClientDocs(invoices: NaInvoiceLine[]): NaInvoiceLine[] {
  // Strictly CLIENT: an INCOME document can also be our commission note to a
  // provider. `party` is absent on payloads cached before it existed, and those
  // fall through to "nothing to chase" until the cache turns over — better than
  // billing a client for a provider's commission.
  const docs = invoices.filter((d) => d.party === "CLIENT");
  const key = (d: NaInvoiceLine) => d.cancels_invoice_id ?? d.invoice_id ?? d.invoice_ref ?? "";

  const net = new Map<string, number>();
  const voided = new Set<string>();
  for (const d of docs) {
    const k = key(d);
    net.set(k, (net.get(k) ?? 0) + (d.amount_ttc ?? 0));
    if (d.status === "CANCELLED" && d.doc_kind !== "CREDIT_NOTE") voided.add(k);
  }

  return docs
    .filter((d) => {
      const k = key(d);
      if (voided.has(k)) return false;
      return Math.abs(net.get(k) ?? 0) > 0.01;
    })
    .sort((a, b) => (isoDay(a.emission_date) ?? "").localeCompare(isoDay(b.emission_date) ?? ""));
}

/** Sum of the values in a per-currency map, for a single currency. */
function balanceFor(map: Map<string, NaClientBalance>, ccy: string | null): NaClientBalance {
  return map.get(ccy ?? "—") ?? { invoiced: 0, paid: 0, outstanding: 0 };
}

/**
 * The recovery position on one booking.
 *
 * Currencies are kept apart rather than pooled: invoices and receipts each carry
 * their own, and netting across them would produce a number that is not money.
 * The headline currency is the one owed the most.
 */
export function naClientRecovery(
  row: NaRow,
  invoices: NaInvoiceLine[],
  receipts: NaClientReceipt[],
  now: Date = new Date(),
): NaClientRecovery {
  const docs = liveClientDocs(invoices);
  const byCurrency = new Map<string, NaClientBalance>();
  const bump = (ccy: string | null, field: keyof NaClientBalance, amount: number) => {
    const c = ccy ?? "—";
    const cur = byCurrency.get(c) ?? { invoiced: 0, paid: 0, outstanding: 0 };
    cur[field] += amount;
    byCurrency.set(c, cur);
  };

  for (const d of docs) bump(d.currency, "invoiced", d.amount_ttc ?? 0);
  for (const r of receipts) bump(r.currency, "paid", r.amount ?? 0);
  for (const [, v] of byCurrency) v.outstanding = Math.round((v.invoiced - v.paid) * 100) / 100;

  let currency: string | null = null;
  let outstanding = 0;
  for (const [c, v] of byCurrency) {
    if (v.outstanding > outstanding) {
      outstanding = v.outstanding;
      currency = c === "—" ? null : c;
    }
  }

  // The clock runs from the last *invoice*: a credit note reduces a balance, it
  // does not restart the wait on the invoices already sent.
  const invoiceDays = docs
    .filter((d) => d.doc_kind !== "CREDIT_NOTE")
    .map((d) => isoDay(d.emission_date))
    .filter((d): d is string => d != null)
    .sort();
  const lastInvoiceDay = invoiceDays.length > 0 ? invoiceDays[invoiceDays.length - 1] : null;

  const nowMs = now.getTime();
  const eventMs = dayMs(row.end_date ?? row.start_date);
  const invoiceMs = dayMs(lastInvoiceDay);
  const daysSinceEvent = eventMs == null ? null : daysBetween(eventMs, nowMs);
  const daysSinceInvoice = invoiceMs == null ? null : daysBetween(invoiceMs, nowMs);

  const headline = balanceFor(byCurrency, currency);
  const eligible =
    outstanding > 0.01 &&
    daysSinceEvent != null &&
    daysSinceEvent >= RECOVERY_GRACE_DAYS &&
    daysSinceInvoice != null &&
    daysSinceInvoice >= RECOVERY_GRACE_DAYS;

  const anyOverdue = docs.some((d) => {
    if (d.doc_kind === "CREDIT_NOTE") return false;
    const due = dayMs(d.due_date);
    return due != null && due < nowMs;
  });

  // A booking can be invoiced by more than one Naboo entity (a French invoice
  // reissued from the US one, say). The email can only name one, so it names
  // whichever issued the most of what is still owed.
  const byEntity = new Map<string, number>();
  for (const d of docs) {
    if (!d.seller_name) continue;
    byEntity.set(d.seller_name, (byEntity.get(d.seller_name) ?? 0) + Math.abs(d.amount_ttc ?? 0));
  }
  let entityName: string | null = null;
  let entityWeight = -1;
  for (const [name, weight] of byEntity) {
    if (weight > entityWeight) {
      entityWeight = weight;
      entityName = name;
    }
  }
  // Only when unanimous: entities hold several accounts, and naming the wrong one
  // sends the money somewhere it has to be traced back from.
  const accounts = new Set(docs.map((d) => d.bank_details).filter(Boolean));
  const meansSet = new Set(docs.map((d) => d.payment_means).filter(Boolean));

  return {
    docs,
    receipts,
    byCurrency,
    currency,
    invoiced: headline.invoiced,
    paid: headline.paid,
    outstanding,
    lastInvoiceDay,
    daysSinceEvent,
    daysSinceInvoice,
    anyOverdue,
    entityName,
    bankDetails: accounts.size === 1 ? [...accounts][0]! : null,
    paymentMeans: meansSet.size === 1 ? [...meansSet][0]! : null,
    eligible,
  };
}

/**
 * Who to write to about the money: the address the invoices were actually
 * addressed to, which is the accounts-payable contact when the booking has one,
 * before the person who briefed the event.
 */
export function naClientContactFor(
  row: NaRow,
  docs: NaInvoiceLine[],
): { address: string | null; name: string | null } {
  const billed = docs
    .map((d) => d.buyer_email?.trim())
    .filter((e): e is string => !!e && e.includes("@"))
    .pop();
  const fallback = row.client_contact_email?.trim() || null;
  const address = billed ?? (fallback?.includes("@") ? fallback : null);
  if (!address) return { address: null, name: null };
  const name = row.client_contact_name?.trim().split(/\s+/)[0] ?? null;
  return { address, name: name || null };
}

function fmtMoney(amount: number | null | undefined, ccy: string | null): string {
  if (amount == null) return "—";
  return (
    Number(amount).toLocaleString("en-CA", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + (ccy ? ` ${ccy}` : "")
  );
}

function fmtDay(raw: string | null | undefined): string {
  const day = isoDay(raw);
  if (!day) return "—";
  try {
    return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return day;
  }
}

/** Totals line, one figure per currency in play — usually just the one. */
function totalsLine(map: Map<string, NaClientBalance>, field: keyof NaClientBalance): string {
  const parts = [...map.entries()]
    .filter(([, v]) => Math.abs(v[field]) > 0.005)
    .map(([c, v]) => fmtMoney(v[field], c === "—" ? null : c));
  return parts.length > 0 ? parts.join(" · ") : fmtMoney(0, null);
}

function docLine(d: NaInvoiceLine): string {
  const ref = d.invoice_ref ?? "—";
  const label = d.doc_kind === "CREDIT_NOTE" ? `${ref} (credit note)` : ref;
  const link = d.pdf_url ? ` – ${d.pdf_url}` : "";
  return `- ${label} – ${fmtMoney(d.amount_ttc, d.currency)} – issued ${fmtDay(d.emission_date)}${link}`;
}

function receiptLine(r: NaClientReceipt): string {
  const detail = r.reference
    ? r.method
      ? `${r.reference} (${r.method})`
      : r.reference
    : (r.method ?? "");
  return `- ${fmtDay(r.paid_on)} – ${fmtMoney(r.amount, r.currency)}${detail ? ` – ${detail}` : ""}`;
}

/** How to settle, from what the invoices themselves say. */
function settlementRoute(rec: NaClientRecovery): string {
  const means =
    rec.paymentMeans === "BANK_TRANSFER"
      ? "bank transfer"
      : (rec.paymentMeans ?? "").trim()
        ? rec.paymentMeans!.replaceAll("_", " ").toLowerCase()
        : null;
  if (rec.bankDetails && means) return `${means} (${rec.bankDetails})`;
  if (rec.bankDetails) return rec.bankDetails;
  if (means) return `${means}, to the details shown on the invoices above`;
  return "the payment details shown on the invoices above";
}

export type NaClientComposed = { subject: string; body: string };

/**
 * The recovery email. Nothing in it is asserted that the listed documents do not
 * already show: the totals are sums of those lines, and the settlement route is
 * the one printed on the invoices themselves.
 */
export function composeNaClientRecovery(
  row: NaRow,
  rec: NaClientRecovery,
  now: Date = new Date(),
): NaClientComposed | null {
  if (rec.outstanding <= 0.01) return null;

  const entity = rec.entityName ?? prettyEntity(row.billing_entity);
  // "NABOO US Inc." already ends a sentence: a second full stop reads as a typo.
  const entitySentenceEnd = entity.endsWith(".") ? entity : `${entity}.`;
  const amount = fmtMoney(rec.outstanding, rec.currency);
  const subject = `${entity} – Balance due: ${amount}`;

  const invoiceLines = rec.docs.map(docLine).join("\n");
  const receiptLines =
    rec.receipts.length > 0
      ? rec.receipts.map(receiptLine).join("\n")
      : "- none recorded on our side to date";

  const settleBy = new Date(now.getTime() + RECOVERY_GRACE_DAYS * 86_400_000);
  const settleDay = fmtDay(settleBy.toISOString());

  // Eligibility keys off the invoice date, not the due date, so a booking can
  // reach this email while its longest-dated invoice is still inside its terms.
  const overdueSentence = rec.anyOverdue
    ? "These invoices are now past their due date, and we'd appreciate settlement of the balance"
    : "We'd appreciate settlement of the balance";

  const body = `Hello,

Hope you're well !

I'm writing regarding the outstanding balance on your account with ${entitySentenceEnd}

Here is the current position:

Invoices :
${invoiceLines}
Total invoiced : ${totalsLine(rec.byCurrency, "invoiced")}

Payments received:
${receiptLines}
Total paid : ${totalsLine(rec.byCurrency, "paid")}

Balance due: ${amount}

${overdueSentence} by ${settleDay} via ${settlementRoute(rec)}.

If anything above doesn't match your records, do let me know and we'll look into it right away. Otherwise, a quick confirmation of when we can expect the payment would be much appreciated.

Thank you in advance, and don't hesitate to reach out if you have any questions !

Best,`;

  return { subject, body };
}

/** Fallback entity label when no invoice carries a legal name. */
export function prettyEntity(billingEntity: string | null | undefined): string {
  const raw = (billingEntity ?? "").trim();
  if (!raw) return "Naboo";
  const known: Record<string, string> = {
    NABOO_US: "NABOO US Inc.",
    NABOO_CA: "NABOO CA Events Inc.",
    NABOO_GROUP: "NABOO GROUP",
    NABOO_DE: "NABOO Deutschland GmbH",
    NABOO_ES: "NABOO ESP SL",
    BIZMEETING: "Bizmeeting",
  };
  return known[raw] ?? raw.replaceAll("_", " ");
}
