/**
 * Account statements — one per supplier per event, and one per client per event.
 *
 * This is the adapter: it turns what the tracker holds about an event into the
 * `StatementOfAccount` the document is drawn from. The figures and the wording
 * live in `statement-of-account.ts`; what lives here is the mapping, and the
 * honesty about what we do and do not hold.
 *
 * One rendering, one renderer: the shapes below go to `statement-pdf.ts`, which
 * draws the file the download button hands over. There is no second template to
 * keep in step with it. Nothing here imports the renderer — it weighs a megabyte
 * with its font machinery, so the download loads it on the first click
 * (`use-statement-download.ts`) rather than with the page.
 *
 * Pure: shapes in, a named file out. Nothing here knows about the DOM.
 */
import type { StatementLine, StatementOfAccount } from "./statement-of-account";

export type StatementEvent = {
  ref: string;
  client: string;
  eventType?: string | null;
  /** The event's own dates, raw — the document formats them. */
  from?: string | null;
  to?: string | null;
  po?: string | null;
  poDate?: string | null;
  currency?: string | null;
  billingEntity?: string | null;
};

export type StatementPayment = {
  amount?: number | null;
  paidOn?: string | null;
  method?: string | null;
  reference?: string | null;
};

export type StatementSupplier = {
  name: string;
  email?: string | null;
  currency?: string | null;
  /** Everything the supplier is owed on this event, before anything was paid. */
  payable?: number | null;
  due?: number | null;
  paid?: number | null;
  /** Marketplace NA only: our cut, and what is left to claw back. */
  commission?: number | null;
  commissionToRecover?: number | null;
  refundToRecover?: number | null;
  payments?: StatementPayment[];
};

export type StatementInvoice = {
  ref?: string | null;
  status?: string | null;
  /** The invoice this one cancels, in part or in full. */
  cancels?: string | null;
  issued?: string | null;
  sent?: string | null;
  due?: string | null;
  amount?: number | null;
};

export type StatementClient = {
  invoiced?: number | null;
  collected?: number | null;
  outstanding?: number | null;
  invoices?: StatementInvoice[];
};

/** Filenames go into a zip and onto someone's desktop: keep them harmless. */
export function safeFileName(text: string): string {
  return (
    text
      .replace(/[/\\?%*:|"<>]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "statement"
  );
}

/** `4 August 2026` — the way the document writes a date. */
export function longDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return value;
  return new Date(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function today(): string {
  return longDate(new Date().toISOString()) ?? "";
}

/**
 * The next date money is actually due: the earliest due date still ahead of us.
 * The earliest date overall is usually in the past — "Due 17 June" on a
 * statement issued in August is noise — so when every date has passed, the
 * latest one is used, which is the date the balance became overdue.
 */
function nextDue(invoices: StatementInvoice[], asOf = new Date()): string | null {
  const dates = invoices
    .map((i) => i.due)
    .filter((d): d is string => !!d)
    .sort();
  if (dates.length === 0) return null;
  const ahead = dates.find((d) => Date.parse(d) >= asOf.getTime());
  return longDate(ahead ?? dates[dates.length - 1]);
}

/** `27–29 March 2026`, or `28 March – 2 April 2026` across a month. */
export function dateRange(
  from: string | null | undefined,
  to: string | null | undefined,
): string | null {
  const start = from ? new Date(Date.parse(from)) : null;
  const end = to ? new Date(Date.parse(to)) : null;
  if (!start || Number.isNaN(start.getTime())) return longDate(to);
  if (!end || Number.isNaN(end.getTime()) || start.getTime() === end.getTime()) {
    return longDate(from);
  }
  if (
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth()
  ) {
    return `${start.getUTCDate()}–${longDate(to)}`;
  }
  return `${longDate(from)} – ${longDate(to)}`;
}

/**
 * Event names are often keyed as "C-U332 / Bland AI" — the reference and the
 * company again. Repeating them in the Event cell, next to the Booking cell and
 * the Billed to cell, reads as a mistake, so the parts that are already on the
 * document are dropped.
 */
export function cleanEventName(
  name: string | null | undefined,
  ref: string,
  client: string,
): string | null {
  if (!name) return null;
  const noise = new Set([ref.toLowerCase(), client.toLowerCase()]);
  const kept = name
    .split(/\s*[/·|]\s*/)
    .map((part) => part.trim())
    .filter((part) => part !== "" && !noise.has(part.toLowerCase()));
  return kept.join(" · ") || null;
}

/**
 * What the Event cell says. A supplier is told whose event it was — they know
 * the venue and the dates, not always the end client, and it is the first thing
 * they ask when reconciling.
 */
function eventLabel(event: StatementEvent, side: "client" | "supplier"): string {
  const name = cleanEventName(event.eventType, event.ref, event.client);
  const parts =
    side === "supplier"
      ? [name, event.client, dateRange(event.from, event.to)]
      : [name, dateRange(event.from, event.to)];
  return parts.filter(Boolean).join(" · ") || event.ref;
}

/** The statement's data, before it is rendered as anything. */
export function supplierStatementData(
  event: StatementEvent,
  supplier: StatementSupplier,
): StatementOfAccount {
  const payable = supplier.payable ?? 0;
  const commission = supplier.commission ?? 0;

  // What the supplier is owed, and our cut shown as the deduction it is — so
  // the total on the document is the figure they should expect to be paid.
  const lines: StatementLine[] = [
    { ref: "Payable for this event", type: "invoice", chip: "Amount payable", amount: payable },
  ];
  if (commission > 0.005) {
    lines.push({
      ref: "Naboo commission",
      type: "credit_note",
      chip: "Commission",
      amount: -commission,
    });
  }

  const payments = (supplier.payments ?? [])
    .filter((p) => Math.abs(p.amount ?? 0) > 0.005)
    .map((p) => ({
      paidOn: longDate(p.paidOn) ?? "—",
      method: p.method,
      reference: p.reference,
      amount: p.amount ?? 0,
    }));

  const data: StatementOfAccount = {
    side: "supplier",
    billedTo: supplier.name,
    event: eventLabel(event, "supplier"),
    bookingRef: event.ref,
    billingEntity: event.billingEntity ?? "Naboo Group",
    currency: supplier.currency ?? event.currency ?? "EUR",
    issuedOn: today(),
    dueOn: null,
    lines,
    payments,
    receivedTotal: supplier.paid ?? 0,
    payee: supplier.name,
    paymentReference: event.ref,
  };

  return data;
}

export function clientStatementData(
  event: StatementEvent,
  client: StatementClient,
): StatementOfAccount {
  const invoices = client.invoices ?? [];

  /**
   * Every document counts toward the total — invoices, credit notes and the
   * cancellations between them. A cancelled invoice always comes with the credit
   * notes that void it, so dropping the parent on its own leaves the children
   * subtracting an amount that was never added: on C-U332 that is the difference
   * between 250 906,32 and the right figure, 266 494,01.
   *
   * What a fully cancelled group does earn is being left off the *listing* —
   * `group` carries the link, and the netting reads it.
   */
  const lines: StatementLine[] = invoices.map((invoice) => {
    const amount = invoice.amount ?? 0;
    const cancels = invoice.cancels?.trim() || null;
    return {
      ref: invoice.ref ?? "—",
      // A negative amount is a credit note whatever the status says.
      type: amount < 0 ? "credit_note" : "invoice",
      chip: cancels ? (amount < 0 ? "Credit note" : "Cancellation") : null,
      group: cancels ?? invoice.ref ?? null,
      issued: longDate(invoice.issued),
      due: longDate(invoice.due),
      amount,
    };
  });

  const data: StatementOfAccount = {
    side: "client",
    billedTo: event.client,
    event: eventLabel(event, "client"),
    bookingRef: event.ref,
    billingEntity: event.billingEntity ?? "Naboo Group",
    currency: event.currency ?? "EUR",
    issuedOn: today(),
    dueOn: nextDue(invoices),
    lines:
      lines.length > 0
        ? lines
        : // Nothing issued yet, but the client agreed a figure: say so as one
          // line rather than showing an empty statement with a balance.
          client.invoiced && client.invoiced > 0.005
          ? [{ ref: "Invoiced to date", type: "invoice", amount: client.invoiced }]
          : [],
    payments: [],
    receivedTotal: client.collected ?? 0,
    payee: event.billingEntity ?? "Naboo Group",
    paymentReference: event.po ? `${event.ref} · PO ${event.po}` : event.ref,
  };

  return data;
}

/** `Bland AI — C-U332.pdf` — what lands in someone's Downloads folder. */
export function statementFileName(data: StatementOfAccount): string {
  return `${safeFileName(data.billedTo)} — ${safeFileName(data.bookingRef)}.pdf`;
}

/** `statements-client-2026-08-18.zip` */
export function archiveName(kind: "supplier" | "client" | "all", today: string): string {
  return `statements-${kind}-${today}.zip`;
}
