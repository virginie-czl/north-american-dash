/**
 * Account statements — one per supplier per event, and one per client per event.
 *
 * A statement is the answer to "what do you owe me, and how did you get there?"
 * put in writing: the event it belongs to, the amounts, and the payments or
 * invoices behind them. It exists so a figure can leave the tracker with its
 * reasoning attached, rather than as a number in an email.
 *
 * Amounts are written raw to two decimals with a comma-separated layout, the same
 * as the tracker's other exports, so a statement can be reconciled in a
 * spreadsheet without anyone having to undo formatting first.
 *
 * Pure: shapes in, text out. Nothing here knows about the DOM.
 */
import type { ZipEntry } from "./zip";

export type StatementEvent = {
  ref: string;
  client: string;
  eventType?: string | null;
  dates?: string | null;
  po?: string | null;
  poDate?: string | null;
  currency?: string | null;
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

function csvEscape(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function row(...cells: unknown[]): string {
  return cells.map(csvEscape).join(",");
}

/** Two decimals, no thousands separator — a spreadsheet reads it as a number. */
function amount(value: number | null | undefined): string {
  if (value == null) return "";
  return value.toFixed(2);
}

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

function header(event: StatementEvent, kind: string, subject: string): string[] {
  return [
    row("Naboo — account statement"),
    row("Statement", kind),
    row("For", subject),
    row("Event", event.ref),
    row("Client", event.client),
    ...(event.eventType ? [row("Event type", event.eventType)] : []),
    ...(event.dates ? [row("Dates", event.dates)] : []),
    ...(event.po ? [row("Purchase order", event.po)] : []),
    ...(event.poDate ? [row("PO received", event.poDate)] : []),
    ...(event.currency ? [row("Currency", event.currency)] : []),
    "",
  ];
}

export function supplierStatement(event: StatementEvent, supplier: StatementSupplier): ZipEntry {
  const ccy = supplier.currency ?? event.currency ?? "";
  const lines = [
    ...header(event, "Supplier", supplier.name),
    ...(supplier.email ? [row("Contact", supplier.email), ""] : []),
    row("Item", `Amount${ccy ? ` (${ccy})` : ""}`),
    ...(supplier.payable != null
      ? [row("Total payable for this event", amount(supplier.payable))]
      : []),
    ...(supplier.commission != null ? [row("Naboo commission", amount(supplier.commission))] : []),
    row("Paid by Naboo", amount(supplier.paid ?? 0)),
    row("Still due", amount(supplier.due ?? 0)),
    ...(supplier.commissionToRecover != null && supplier.commissionToRecover > 0.01
      ? [row("Commission to recover from the supplier", amount(supplier.commissionToRecover))]
      : []),
    ...(supplier.refundToRecover != null && supplier.refundToRecover > 0.01
      ? [row("Overpayment to refund to Naboo", amount(supplier.refundToRecover))]
      : []),
  ];

  const payments = supplier.payments ?? [];
  if (payments.length > 0) {
    lines.push("", row("Payments made"), row("Date", "Method", "Reference", "Amount"));
    for (const p of payments) {
      lines.push(row(p.paidOn ?? "", p.method ?? "", p.reference ?? "", amount(p.amount)));
    }
  }

  return {
    name: `${safeFileName(supplier.name)} — ${safeFileName(event.ref)}.csv`,
    text: lines.join("\n") + "\n",
  };
}

export function clientStatement(event: StatementEvent, client: StatementClient): ZipEntry {
  const ccy = event.currency ?? "";
  const lines = [
    ...header(event, "Client", event.client),
    row("Item", `Amount${ccy ? ` (${ccy})` : ""}`),
    row("Invoiced", amount(client.invoiced ?? 0)),
    row("Received", amount(client.collected ?? 0)),
    row("Outstanding", amount(client.outstanding ?? 0)),
  ];

  const invoices = client.invoices ?? [];
  if (invoices.length > 0) {
    lines.push(
      "",
      row("Invoices"),
      row("Reference", "Status", "Issued", "Sent", "Payment due", "Amount"),
    );
    for (const i of invoices) {
      lines.push(
        row(
          i.ref ?? "",
          (i.status ?? "").toLowerCase(),
          i.issued ?? "",
          i.sent ?? "",
          i.due ?? "",
          amount(i.amount),
        ),
      );
    }
  }

  return {
    name: `${safeFileName(event.client)} — ${safeFileName(event.ref)}.csv`,
    text: lines.join("\n") + "\n",
  };
}

/** `statements-supplier-2026-08-18.zip` */
export function archiveName(kind: "supplier" | "client" | "all", today: string): string {
  return `statements-${kind}-${today}.zip`;
}
