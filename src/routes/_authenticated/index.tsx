import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState, useEffect, Fragment } from "react";
import {
  getSlaRows,
  parsePartners,
  parseInvoices,
  type SlaRow,
  type PartnerLine,
  type InvoiceLine,
} from "@/lib/sla.functions";
import {
  partnerKey,
  useAddComment,
  useCommentSummaries,
  useCurrentUser,
  useDeleteComment,
  useEventComments,
  usePartnerStatuses,
  usePoEmissionDates,
  useSetPartnerStatus,
  type PartnerStatusValue,
  type EventCommentSummary,
  type PartnerStatusRow,
} from "@/lib/use-annotations";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TagFilterSelect } from "@/components/tag-filter-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useRegisterTrackerActions } from "@/components/tracker-chrome";
import { PartnerEmails } from "@/components/partner-emails";
import { PartnerInvoicePdfs } from "@/components/partner-invoice-pdfs";
import { RequestInfoDialog, useRequestDialog } from "@/components/request-info-dialog";
import { buildTargets, needsOf, type Needs, type RequestTarget } from "@/lib/partner-requests";
import type { PartnerAction } from "@/lib/partner-actions";
import type { PartnerFacts } from "@/lib/gmail.functions";
import { CommandPalette, type PaletteGroup } from "@/components/command-palette";
import { EventNotes } from "@/components/paper-notes";
import { listCsv, listFileName } from "@/lib/list-export";
import { haystack, matching, overflowNote } from "@/lib/search-index";
import {
  EventScreen,
  ListScreen,
  type EventMove,
  type EventPartnerRow,
  type PaperRow,
} from "@/components/paper-screens";
import {
  BreadcrumbBar,
  DownloadLink,
  OutlineButton,
  PaperCheckbox,
  PaperLink,
  PrimaryButton,
  RailBlock,
  RailRows,
  SectionLabel,
  StatStrip,
  fmtPaper,
  usePaletteShortcut,
  useSyncedLabel,
} from "@/components/paper";
import { zipStored } from "@/lib/zip";
import {
  archiveName,
  clientStatement,
  supplierStatement,
  type StatementEvent,
} from "@/lib/account-statements";
import { useActionIndex, tagsForEvent, TAG_FILTER_GROUPS } from "@/lib/use-partner-actions";
import { useFactScan, useGmailConnection, usePartnerFacts } from "@/lib/use-gmail";
import { Download, SlidersHorizontal } from "lucide-react";

export const Route = createFileRoute("/_authenticated/")({
  /**
   * Which list is open, which figure was clicked, and which event is showing —
   * in the URL, so a screen can be linked, bookmarked and walked back to with
   * the browser's own back button.
   */
  validateSearch: (search: Record<string, unknown>): TrackerSearch => ({
    list: typeof search.list === "string" ? (search.list as ListKey) : undefined,
    figure: typeof search.figure === "string" ? (search.figure as StatKey) : undefined,
    ref: typeof search.ref === "string" ? search.ref : undefined,
  }),
  // Presentation aside, the data query refuses too (requireTracker).
  beforeLoad: ({ context }) => {
    const allowed = (context as { allowedTrackers?: string[] }).allowedTrackers ?? [];
    if (!allowed.includes("loreal")) {
      const fallback = allowed.includes("loreal")
        ? "/"
        : allowed.includes("veolia")
          ? "/veolia"
          : allowed.includes("na")
            ? "/tracking-north-america"
            : null;
      throw redirect(
        fallback ? { to: fallback } : { to: "/auth", search: { status: "no-tracker" } },
      );
    }
  },
  head: () => ({
    meta: [
      { title: "L'Oréal Canada — Invoicing SLA Tracker" },
      {
        name: "description",
        content:
          "Track free-invoicing SLAs for L'Oréal Canada events: bookings, partner payouts, client invoicing and receivables.",
      },
    ],
  }),
  component: SlaPage,
});

function fmtCurrency(value: number | null | undefined, currency: string | null | undefined) {
  if (value == null) return "—";
  const ccy = currency || "EUR";
  try {
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: ccy,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${ccy}`;
  }
}

/** Range end dates drop the year when it adds no information. */
function fmtDateShort(v: string | null | undefined): string {
  const full = fmtDate(v);
  return full.length === 10 ? full.slice(5) : full;
}

function fmtDate(value: string | null | undefined) {
  if (!value) return "—";
  return value.slice(0, 10);
}

function daysSince(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

function earliestSent(invoices?: InvoiceLine[]): string | null {
  if (!invoices || invoices.length === 0) return null;
  const sent = invoices
    .map((i) => i.first_sent_at)
    .filter((v): v is string => !!v)
    .sort();
  return sent[0] ?? null;
}

function isSent(invoice: InvoiceLine): boolean {
  return invoice.is_sent === true || !!invoice.first_sent_at;
}

/** The three invoicing states of an event, read off its client invoices. */
type InvoiceStatus = "issued_sent" | "issued_not_sent" | "not_issued";

/**
 * Invoicing state of an event. `invoices` only ever holds client (INCOME)
 * invoices that were not cancelled, so "nothing here" means nothing issued.
 * An event whose invoices are only partly sent counts as "issued, not sent":
 * something is still waiting to go out.
 */
function invoiceStatusOf(invoices: InvoiceLine[]): InvoiceStatus {
  if (invoices.length === 0) return "not_issued";
  return invoices.every(isSent) ? "issued_sent" : "issued_not_sent";
}

const INVOICE_STATUS_META: Record<InvoiceStatus, { label: string; cls: string }> = {
  issued_sent: { label: "Issued and sent", cls: "bg-emerald-100 text-emerald-800" },
  issued_not_sent: { label: "Issued, not sent", cls: "bg-amber-100 text-amber-800" },
  not_issued: { label: "No invoice issued", cls: "bg-slate-100 text-slate-600" },
};

const INVOICE_STATUS_ORDER: InvoiceStatus[] = ["issued_sent", "issued_not_sent", "not_issued"];

function paymentStatus(
  row: SlaRow,
  invoices?: InvoiceLine[],
): {
  label: string;
  variant: "paid" | "partial" | "due" | "overdue" | "muted";
} {
  const invoiced = row.client_invoiced_ttc ?? 0;
  const collected = row.client_collected_total ?? 0;
  const emission = row.first_income_invoice_emission_date;
  if (!emission || invoiced <= 0.01) return { label: "Not invoiced", variant: "muted" };
  if (collected + 0.01 >= invoiced) return { label: "Paid", variant: "paid" };
  // Payment terms start from the date the invoice was sent, not issued.
  const sentDate = earliestSent(invoices);
  if (!sentDate) return { label: "Not sent", variant: "muted" };
  const ds = daysSince(sentDate);
  const daysLeft = ds == null ? null : 60 - ds;
  if (daysLeft == null) return { label: "—", variant: "muted" };
  if (daysLeft < 0) return { label: `Overdue ${-daysLeft}d`, variant: "overdue" };
  return { label: `Due in ${daysLeft}d`, variant: "due" };
}

// Invoicing SLA: the invoice must be SENT within 3 days after event end.
// Exception: if the PO was received after the event end, the deadline shifts
// to 3 days after PO reception. The SLA tracks sending, not issuing.
function invoicingSla(
  row: SlaRow,
  invoices?: InvoiceLine[],
): { label: string; variant: "paid" | "partial" | "due" | "overdue" | "muted" } {
  const hasPo = !!(row.purchase_order_number && String(row.purchase_order_number).trim());
  if (!hasPo) return { label: "No PO", variant: "muted" };
  const poTs = row.purchase_order_date ? new Date(row.purchase_order_date).getTime() : null;
  const endTs = row.end_date ? new Date(row.end_date).getTime() : null;
  const anchor = poTs != null && endTs != null ? Math.max(poTs, endTs) : (poTs ?? endTs);
  if (anchor == null) return { label: "No date", variant: "muted" };
  const THREE_D = 3 * 86_400_000;
  const deadline = anchor + THREE_D;
  const sentDate = earliestSent(invoices);
  const emission = row.first_income_invoice_emission_date;
  if (sentDate) {
    const st = new Date(sentDate).getTime();
    if (st <= deadline) return { label: "On time", variant: "paid" };
    const lateBy = Math.ceil((st - deadline) / 86_400_000);
    return { label: `Sent late ${lateBy}d`, variant: "partial" };
  }
  const now = Date.now();
  // Invoice issued but not sent — cannot be "on time".
  if (emission) {
    if (now <= deadline) {
      const daysLeft = Math.max(0, Math.ceil((deadline - now) / 86_400_000));
      return { label: `Issued, send in ${daysLeft}d`, variant: "due" };
    }
    const overBy = Math.ceil((now - deadline) / 86_400_000);
    return { label: `Issued, send breached ${overBy}d`, variant: "partial" };
  }
  if (now <= deadline) {
    const daysLeft = Math.max(0, Math.ceil((deadline - now) / 86_400_000));
    return { label: `Issue+send in ${daysLeft}d`, variant: "due" };
  }
  const overBy = Math.ceil((now - deadline) / 86_400_000);
  return { label: `Breached ${overBy}d`, variant: "overdue" };
}

// Payout SLA: 24h after PO emission. No PO → "No PO".
function payoutSla(
  row: SlaRow,
  partners?: PartnerLine[],
): { label: string; variant: "paid" | "partial" | "due" | "overdue" | "muted" } {
  const remaining = row.partner_reste_a_decaisser_ttc ?? 0;
  const owed = row.partner_net_a_payer_ttc ?? 0;
  // If every active partner has been settled, the SLA can't be "due" even if
  // the row-level remaining is non-zero (rounding / late finance sync).
  const allPartnersSettled =
    partners &&
    partners.length > 0 &&
    partners.every((p) => {
      if (p.is_cancelled) return true;
      const due = Math.max(p.amount_due ?? 0, 0);
      const paid = Math.abs(p.amount_paid ?? 0);
      if (due <= 0.01) return true;
      return paid + 0.01 >= due;
    });
  if (allPartnersSettled) return { label: "Fully paid", variant: "paid" };
  if (owed <= 0.01 && remaining <= 0.01) {
    if (row.payout_sla_status === "NO_PARTNER_LIABILITY")
      return { label: "No liability", variant: "muted" };
    return { label: "Fully paid", variant: "paid" };
  }
  if (remaining <= 0.01) return { label: "Fully paid", variant: "paid" };
  const hasPo = !!(row.purchase_order_number && String(row.purchase_order_number).trim());
  if (!hasPo) return { label: "No PO", variant: "muted" };
  const poTs = row.purchase_order_date ? new Date(row.purchase_order_date).getTime() : null;
  if (poTs == null) return { label: "No PO date", variant: "muted" };
  const deadline = poTs + 86_400_000;
  const now = Date.now();
  if (now <= deadline) {
    const hLeft = Math.max(0, Math.round((deadline - now) / 3_600_000));
    return { label: `Due in ${hLeft}h`, variant: "due" };
  }
  const overBy = Math.ceil((now - deadline) / 86_400_000);
  return { label: `Breached ${overBy}d`, variant: "overdue" };
}

const PARTNER_STATUS_OPTIONS: { value: PartnerStatusValue; label: string; cls: string }[] = [
  {
    value: "not_contacted",
    label: "Not contacted",
    cls: "bg-slate-100 text-slate-700 border-slate-200",
  },
  {
    value: "waiting_bank",
    label: "Waiting bank details",
    cls: "bg-amber-100 text-amber-800 border-amber-200",
  },
  {
    value: "partially_paid",
    label: "Partially paid",
    cls: "bg-sky-100 text-sky-800 border-sky-200",
  },
  {
    value: "fully_paid",
    label: "Fully paid",
    cls: "bg-emerald-100 text-emerald-800 border-emerald-200",
  },
];

function hasPurchaseOrder(row: SlaRow): boolean {
  return !!(row.purchase_order_number && String(row.purchase_order_number).trim());
}

/** An invoice the client has actually received: issued, and sent by email. */
function isIssuedAndEmailed(invoice: InvoiceLine): boolean {
  return (
    (invoice.status ?? "").toUpperCase() === "ISSUED" &&
    (invoice.send_method ?? "").toUpperCase().includes("EMAIL")
  );
}

/**
 * What is left to invoice on an event: what the client agreed to pay, less what
 * has already been issued. The agreed figure comes from the confirmed proposal
 * because an event with no invoice yet has no invoice amount to read.
 */
function stillToInvoice(row: SlaRow): number {
  const agreed = row.client_proposal_total_ttc ?? 0;
  const issued = row.client_invoiced_ttc ?? 0;
  return Math.max(Math.round((agreed - issued) * 100) / 100, 0);
}

type Decorated = { row: SlaRow; partners: PartnerLine[]; invoices: InvoiceLine[] };

/** One list per action type — the spine of the redesigned overview. */
export type ListKey = "ask" | "pay" | "invoice" | "chase" | "waiting";

const LIST_ORDER: ListKey[] = ["ask", "pay", "invoice", "chase", "waiting"];

type ListMember = { item: Decorated; lists: { units: Record<ListKey, number> } };

/**
 * How each list introduces itself. The sentence carries the count so the row
 * reads as an instruction rather than a label with a number bolted on, and the
 * second line says why the work exists — the rule, or what is already known.
 */
const LIST_META: Record<
  ListKey,
  {
    /** Short name for breadcrumbs and sibling links. */
    name: string;
    title: (units: number) => string;
    detail: (members: ListMember[]) => string;
    /** The caption under the figure. */
    unit: string;
    /** How the list screen explains the rule that produced the work. */
    explanation: string;
    /** The three right-hand columns, in order. */
    columns: [string, string, string];
    /** What the rows are, for "7 more ___ in this list". */
    unitNoun: string;
    /** The one list whose button sends rather than navigates. */
    primary?: boolean;
    /** A list nobody has to act on — its button stays quiet. */
    quiet?: boolean;
  }
> = {
  ask: {
    name: "Ask partners for details",
    title: (n) => `Ask ${n} partner${n === 1 ? "" : "s"} for bank details and tax numbers`,
    detail: () => "One email per partner, covering all their bookings",
    unit: "to pay out",
    explanation:
      "One email per partner, in their language, listing every booking of theirs and asking only for what is missing. Nothing sends until you confirm.",
    columns: ["Owed to partner", "Client outstanding", "Waiting"],
    unitNoun: "partners",
    primary: true,
  },
  pay: {
    name: "Pay partners",
    title: (n) => `Pay ${n} partner${n === 1 ? "" : "s"} whose PO has landed`,
    detail: () => "Everything needed is on file · payout is due 24h after the PO",
    unit: "to pay out",
    explanation:
      "We hold the bank details and the tax numbers for these partners, and the purchase order has landed. The payout is due 24 hours after the PO.",
    columns: ["To pay", "Client outstanding", "Since the PO"],
    unitNoun: "partners",
  },
  invoice: {
    name: "Send invoices",
    title: (n) => `Send ${n} client invoice${n === 1 ? "" : "s"} before the SLA runs out`,
    detail: (members) => {
      const late = members.filter(({ item }) => {
        const sla = invoicingSla(item.row, item.invoices);
        return sla.variant === "overdue" || sla.variant === "partial";
      }).length;
      return late > 0
        ? `${late} past the deadline · invoices must be sent 3 days after the event ends`
        : "Invoices must be sent 3 days after the event ends";
    },
    unit: "to invoice",
    explanation:
      "The invoice has to be sent within 3 days of the event ending. Issuing happens in the back office — this list is what is still open.",
    columns: ["To invoice", "Client outstanding", "Since the event"],
    unitNoun: "events",
  },
  chase: {
    name: "Chase clients",
    title: (n) => `Chase ${n} overdue client invoice${n === 1 ? "" : "s"}`,
    detail: () => "Payment terms are 60 days from the day the invoice was sent",
    unit: "overdue",
    explanation:
      "Payment terms are 60 days from the day the invoice was sent. These are past that date and the money has not arrived.",
    columns: ["Overdue", "Invoiced", "Sent"],
    unitNoun: "events",
  },
  waiting: {
    name: "Waiting",
    title: (n) => `Wait on ${n} partner repl${n === 1 ? "y" : "ies"}`,
    detail: () => "Nothing to do until they answer",
    unit: "on hold",
    explanation:
      "The ask is with the partner. Nothing to do until they answer — if one has gone quiet for too long, send it again from the ask list.",
    columns: ["Owed to partner", "Client outstanding", "Waiting"],
    unitNoun: "partners",
    quiet: true,
  },
};

export type StatKey =
  | "client_outstanding_po"
  | "client_paid"
  | "partner_remaining_po"
  | "invoices_sent"
  | "invoices_to_do"
  | "invoices_no_po";

/**
 * The headline figures, each one clickable.
 *
 * `test` decides both what the figure counts and which events the list shows
 * when it is clicked — one predicate, so a total can never describe a different
 * set of events than the one it opens.
 */
const STATS: Array<{
  key: StatKey;
  band: "money" | "invoicing";
  label: string;
  hint: string;
  test: (d: Decorated) => boolean;
  amount: (d: Decorated) => number;
  /** Invoices rather than events, where that is what was asked for. */
  countsInvoices?: (d: Decorated) => number;
}> = [
  {
    key: "client_outstanding_po",
    band: "money",
    label: "Client outstanding",
    hint: "PO received, still owed by L'Oréal",
    test: (d) => hasPurchaseOrder(d.row) && (d.row.client_reste_a_encaisser_ttc ?? 0) > 0.01,
    amount: (d) => d.row.client_reste_a_encaisser_ttc ?? 0,
  },
  {
    key: "client_paid",
    band: "money",
    label: "Paid by the client",
    hint: "Received to date, every event",
    test: (d) => (d.row.client_collected_total ?? 0) > 0.01,
    amount: (d) => d.row.client_collected_total ?? 0,
  },
  {
    key: "partner_remaining_po",
    band: "money",
    label: "Owed to partners",
    hint: "PO received, still to disburse",
    test: (d) => hasPurchaseOrder(d.row) && (d.row.partner_reste_a_decaisser_ttc ?? 0) > 0.01,
    amount: (d) => d.row.partner_reste_a_decaisser_ttc ?? 0,
  },
  {
    key: "invoices_sent",
    band: "invoicing",
    label: "Issued and sent",
    hint: "Invoices issued and emailed",
    test: (d) => d.invoices.some(isIssuedAndEmailed),
    amount: (d) =>
      d.invoices.filter(isIssuedAndEmailed).reduce((total, i) => total + (i.amount_ttc ?? 0), 0),
    countsInvoices: (d) => d.invoices.filter(isIssuedAndEmailed).length,
  },
  {
    key: "invoices_to_do",
    band: "invoicing",
    label: "To invoice",
    hint: "PO received, nothing emailed yet",
    test: (d) => hasPurchaseOrder(d.row) && !d.invoices.some(isIssuedAndEmailed),
    amount: (d) => stillToInvoice(d.row),
  },
  {
    key: "invoices_no_po",
    band: "invoicing",
    label: "Waiting for a PO",
    hint: "Cannot be invoiced yet",
    test: (d) => !hasPurchaseOrder(d.row),
    amount: (d) => stillToInvoice(d.row),
  },
];

/** A provider still owed money on an event, and how much is left. */
type UnpaidPartner = { partner: PartnerLine; remaining: number };

/**
 * Providers that still have to be paid, biggest first. Cancelled quotes and
 * anything already settled drop out; a provider with no name stays in — the
 * money is owed whether or not the line carries a name.
 */
function unpaidPartners(partners: PartnerLine[]): UnpaidPartner[] {
  return partners
    .filter((p) => !p.is_cancelled)
    .map((p) => {
      const due = Math.max(p.amount_due ?? 0, 0);
      const paid = Math.abs(p.amount_paid ?? 0);
      return { partner: p, remaining: +(due - paid).toFixed(2) };
    })
    .filter(({ remaining }) => remaining > 0.01)
    .sort((a, b) => b.remaining - a.remaining);
}

function totalByCurrency(
  list: UnpaidPartner[],
  fallback: string | null | undefined,
): Map<string, number> {
  const m = new Map<string, number>();
  list.forEach(({ partner, remaining }) => {
    const ccy = partner.currency || fallback || "EUR";
    m.set(ccy, (m.get(ccy) ?? 0) + remaining);
  });
  return m;
}

/** Currencies are never added together — each is shown on its own. */
function fmtMulti(m: Map<string, number>): string {
  if (m.size === 0) return fmtCurrency(0, "EUR");
  return Array.from(m.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([ccy, v]) => fmtCurrency(v, ccy))
    .join(" · ");
}

function partnerLabel(p: PartnerLine): string {
  const name = p.name?.trim();
  return name || "Unnamed provider";
}

/** Hands the browser a file without leaving anything behind. */
/**
 * Open a statement and go straight to the print dialog, where "Save as PDF"
 * produces the file. The `#print` hash is what tells the document to do that —
 * the same file opened later out of a zip just renders.
 */
function openStatement(entry: { name: string; bytes: Uint8Array<ArrayBuffer> }) {
  const url = URL.createObjectURL(new Blob([entry.bytes], { type: "text/html;charset=utf-8" }));
  const opened = window.open(`${url}#print`, "_blank");
  if (!opened) {
    // Pop-up blocked: fall back to handing over the file itself.
    const a = document.createElement("a");
    a.href = url;
    a.download = entry.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  // The tab has the bytes; the URL can go once it has loaded.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function statementEvent(row: SlaRow): StatementEvent {
  return {
    ref: row.readable_id ?? row.client_request_id ?? "—",
    client: row.company_name ?? "L'Oréal Canada",
    eventType: (row.event_type ?? "").replaceAll("_", " ").toLowerCase() || null,
    from: row.start_date,
    to: row.end_date,
    po: row.purchase_order_number ? String(row.purchase_order_number) : null,
    poDate: row.purchase_order_date ? fmtDate(row.purchase_order_date) : null,
    currency: row.currency,
    billingEntity: row.billing_entity,
  };
}

/** One statement per supplier on an event — every supplier, paid or not. */
function supplierStatementsFor({ row, partners }: { row: SlaRow; partners: PartnerLine[] }) {
  const event = statementEvent(row);
  return partners
    .filter((p) => !p.is_cancelled)
    .map((p) => {
      const due = Math.max(p.amount_due ?? 0, 0);
      const paid = Math.abs(p.amount_paid ?? 0);
      return supplierStatement(event, {
        name: partnerLabel(p),
        email: p.email,
        currency: p.currency ?? row.currency,
        payable: p.net_payable_ttc,
        due,
        paid,
      });
    });
}

function clientStatementFor({ row, invoices }: { row: SlaRow; invoices: InvoiceLine[] }) {
  return clientStatement(statementEvent(row), {
    invoiced: row.client_invoiced_ttc,
    collected: row.client_collected_total,
    outstanding: row.client_reste_a_encaisser_ttc,
    invoices: invoices.map((i) => ({
      ref: i.invoice_ref,
      status: i.status,
      issued: i.emission_date,
      sent: i.first_sent_at,
      due: i.due_date,
      amount: i.amount_ttc,
    })),
  });
}

function csvEscape(v: string): string {
  if (/[",\n;]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function exportUnpaidPartners(decorated: { row: SlaRow; partners: PartnerLine[] }[]) {
  const rows: string[][] = [
    [
      "Event date",
      "Event ref",
      "Company",
      "Partner name",
      "Partner email",
      "Currency",
      "Amount due",
      "Amount paid",
      "Remaining",
    ],
  ];
  // Same rule as the "Partners to pay" scope, so the file and the screen list
  // the same providers — an unnamed one included, since the money is still owed.
  decorated.forEach(({ row, partners }) => {
    if (!hasPurchaseOrder(row)) return;
    unpaidPartners(partners).forEach(({ partner: p, remaining }) => {
      const due = Math.max(p.amount_due ?? 0, 0);
      const paid = Math.abs(p.amount_paid ?? 0);
      rows.push([
        row.booking_date ?? row.end_date ?? "",
        row.readable_id ?? "",
        row.company_name ?? "",
        p.name ?? "",
        p.email ?? "",
        p.currency ?? row.currency ?? "",
        due.toFixed(2),
        paid.toFixed(2),
        remaining.toFixed(2),
      ]);
    });
  });
  const csv = rows.map((r) => r.map((c) => csvEscape(String(c))).join(",")).join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `unpaid-partners-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportContactToBeDone(
  decorated: { row: SlaRow; partners: PartnerLine[] }[],
  statusMap: Map<string, PartnerStatusRow> | undefined,
) {
  const rows: string[][] = [
    [
      "Event date",
      "Event ref",
      "Company",
      "Partner name",
      "Partner email",
      "Currency",
      "Amount due",
      "Outreach status",
    ],
  ];
  decorated.forEach(({ row, partners }) => {
    if (!row.purchase_order_number || !String(row.purchase_order_number).trim()) return;
    partners.forEach((p) => {
      if (!p.name || !p.name.trim()) return;
      if (p.is_cancelled) return;
      const due = Math.max(p.amount_due ?? 0, 0);
      const paid = Math.abs(p.amount_paid ?? 0);
      if (due <= 0.01) return;
      if (paid + 0.01 >= due) return; // fully paid
      if (paid > 0.01) return; // partial → payout issue, not outreach
      const k = `${row.readable_id ?? row.client_request_id ?? ""}::${partnerKey(p.name)}`;
      const status = statusMap?.get(k)?.status ?? "not_contacted";
      if (status !== "not_contacted") return;
      rows.push([
        row.booking_date ?? row.end_date ?? "",
        row.readable_id ?? "",
        row.company_name ?? "",
        p.name ?? "",
        p.email ?? "",
        p.currency ?? row.currency ?? "",
        due.toFixed(2),
        "Not contacted",
      ]);
    });
  });
  const csv = rows.map((r) => r.map((c) => csvEscape(String(c))).join(",")).join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `partner-contact-todo-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

type TrackerSearch = { list?: ListKey; figure?: StatKey; ref?: string };

function SlaPage() {
  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["sla-rows"],
    queryFn: () => getSlaRows(),
    staleTime: 60_000,
  });
  const syncedLabel = useSyncedLabel(dataUpdatedAt);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [invoiceFilter, setInvoiceFilter] = useState<InvoiceStatus | "all">("all");
  // Turnkey is out by default (Naboo runs those end to end) but can be brought back.
  const [kindFilter, setKindFilter] = useState<string>("no_turnkey");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  // Where we are, read from the URL. The open event is identified by its
  // readable ref — the same token ⌘K and the back office use.
  const navigate = Route.useNavigate();
  const params = Route.useSearch();
  const activeList = params.list && LIST_ORDER.includes(params.list) ? params.list : null;
  const statFilter =
    params.figure && STATS.some((s) => s.key === params.figure) ? params.figure : null;
  const selectedRef = params.ref ?? "";
  const setSelectedRef = useCallback(
    (value: string) =>
      navigate({ search: (prev: TrackerSearch) => ({ ...prev, ref: value || undefined }) }),
    [navigate],
  );
  const [sortKey, setSortKey] = useState<string>("booking_created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const setCol = (k: string, v: string) =>
    setColFilters((prev) => {
      const next = { ...prev };
      if (!v || v === "all") delete next[k];
      else next[k] = v;
      return next;
    });
  // ⌘K.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteCursor, setPaletteCursor] = useState(0);
  /** The rows ticked on an action list, by row id. */
  const [selection, setSelection] = useState<Set<string>>(new Set());
  /** Which of the event's side panels (emails, PDFs, comments) is open. */
  const [panel, setPanel] = useState<"emails" | "docs" | null>(null);
  const rawRows = data ?? [];
  const poDates = usePoEmissionDates(rawRows);
  const { data: statusMap } = usePartnerStatuses();
  const { data: commentSummaries } = useCommentSummaries();
  const setStatus = useSetPartnerStatus();
  const { factsMap, factsError, actionFor, eventNeedsScan, cardApprovedCodes } = useActionIndex();
  const { data: gmailConnection, error: gmailError } = useGmailConnection();
  const { data: me } = useCurrentUser();
  const requestDialog = useRequestDialog();
  const { progress: scanProgress, start: startScan } = useFactScan();
  const rows = useMemo(() => {
    if (!poDates) return rawRows;
    return rawRows.map((r) => {
      const ref = r.readable_id;
      const po = r.purchase_order_number ? String(r.purchase_order_number).trim() : "";
      if (!ref || !po) return r;
      // The warehouse now carries the real PO date; the annotation store only
      // knows when this app first laid eyes on the number, so it is a last
      // resort rather than an override.
      if (r.purchase_order_date) return r;
      const entry = poDates.get(ref);
      if (!entry || entry.po !== po) return r;
      return { ...r, purchase_order_date: entry.emitted_at };
    });
  }, [rawRows, poDates]);

  // Decorate rows with parsed sub-lines once
  const decorated = useMemo(
    () =>
      rows.map((r) => {
        const partners = parsePartners(r.partners_json);
        // Trust the aggregated tracker: when the booking's payout is FULLY_PAID
        // (or nothing left to disburse), force each partner line to fully-paid
        // regardless of what the raw reconciliation table still shows.
        const fullyPaid =
          r.payout_sla_status === "FULLY_PAID" || (r.partner_reste_a_decaisser_ttc ?? 0) === 0;
        const normalizedPartners = fullyPaid
          ? partners.map((p) => ({
              ...p,
              amount_due: 0,
              amount_paid: p.net_payable_ttc ?? p.amount_paid ?? 0,
              is_outstanding: false,
            }))
          : partners;
        return {
          row: r,
          partners: normalizedPartners,
          invoices: parseInvoices(r.invoices_json),
        };
      }),
    [rows],
  );

  const distinctEventTypes = useMemo(
    () =>
      Array.from(
        new Set(decorated.map((d) => d.row.event_type).filter((v): v is string => !!v)),
      ).sort(),
    [decorated],
  );
  const distinctCountries = useMemo(
    () =>
      Array.from(
        new Set(decorated.map((d) => d.row.country_iso_code).filter((v): v is string => !!v)),
      ).sort(),
    [decorated],
  );
  const distinctOutreach = useMemo(() => {
    const s = new Set<string>();
    decorated.forEach(({ row, partners }) => {
      const hasPo = !!(row.purchase_order_number && String(row.purchase_order_number).trim());
      const o = partnerOutreach(partners, row.readable_id ?? row.client_request_id ?? "", hasPo);
      if (o) s.add(o.label);
    });
    return Array.from(s).sort();
  }, [decorated, statusMap]);

  // Every filter except the invoicing status. Kept apart so the three
  // invoicing-status options can show how many events each one would leave.
  const preInvoiceStatus = useMemo(() => {
    let r = decorated;
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter(
        (x) =>
          x.row.readable_id?.toLowerCase().includes(q) ||
          x.row.event_type?.toLowerCase().includes(q) ||
          x.partners.some(
            (p) => p.name?.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q),
          ) ||
          x.invoices.some((i) => i.invoice_ref?.toLowerCase().includes(q)),
      );
    }
    if (statusFilter !== "all") {
      r = r.filter(({ row: x, partners: ps, invoices: iv }) => {
        if (statusFilter === "invoicing_breached") return invoicingSla(x, iv).variant === "overdue";
        if (statusFilter === "payout_breached") return payoutSla(x, ps).variant === "overdue";
        if (statusFilter === "receivable_overdue")
          return paymentStatus(x, iv).variant === "overdue";
        if (statusFilter === "partner_outstanding")
          return (x.partner_reste_a_decaisser_ttc ?? 0) > 0;
        return true;
      });
    }
    // Transaction kind. Turnkey is excluded by default: Naboo runs those end to end,
    // so there is no partner payment or PO cycle for this tracker to chase.
    if (kindFilter !== "all") {
      r = r.filter(({ row: x }) => {
        const kind = (x.transaction_kind ?? "").toUpperCase();
        if (kindFilter === "no_turnkey") return kind !== "TURNKEY";
        return kind === kindFilter;
      });
    }
    // Tag filter — matches the badges shown on the row, so the filter and the
    // stickers can never disagree. Multiple tags selected = OR (any match).
    if (tagFilter.length > 0) {
      r = r.filter(({ row: x, partners: ps }) => {
        const tags = tagsForEvent(
          x.readable_id ?? x.client_request_id ?? "",
          ps,
          Boolean(x.purchase_order_number),
          actionFor,
          factsMap,
          cardApprovedCodes,
        );
        return tagFilter.some((t) => tags.has(t as never));
      });
    }
    // Column-level filters
    if (Object.keys(colFilters).length > 0) {
      r = r.filter(({ row: x, partners: ps, invoices: iv }) => {
        for (const [key, val] of Object.entries(colFilters)) {
          if (key === "event_type" && (x.event_type ?? "") !== val) return false;
          if (key === "country" && (x.country_iso_code ?? "") !== val) return false;
          if (key === "billing_entity" && (x.billing_entity ?? "") !== val) return false;
          if (key === "po") {
            const has = !!(x.purchase_order_number && String(x.purchase_order_number).trim());
            if (val === "with" && !has) return false;
            if (val === "without" && has) return false;
          }
          if (key === "invoicing_sla" && invoicingSla(x, iv).variant !== val) return false;
          if (key === "payment_status" && paymentStatus(x, iv).variant !== val) return false;
          if (key === "payout_sla" && payoutSla(x, ps).variant !== val) return false;
          if (key === "outreach") {
            const has = !!(x.purchase_order_number && String(x.purchase_order_number).trim());
            const o = partnerOutreach(ps, x.readable_id ?? x.client_request_id ?? "", has);
            const label = o?.label ?? "—";
            if (label !== val) return false;
          }
        }
        return true;
      });
    }

    return r;
  }, [
    decorated,
    search,
    statusFilter,
    kindFilter,
    tagFilter,
    colFilters,
    actionFor,
    factsMap,
    cardApprovedCodes,
  ]);

  // How many events sit in each invoicing state, under the other filters.
  const invoiceStatusCounts = useMemo(() => {
    const counts: Record<InvoiceStatus, number> = {
      issued_sent: 0,
      issued_not_sent: 0,
      not_issued: 0,
    };
    preInvoiceStatus.forEach(({ invoices: iv }) => {
      counts[invoiceStatusOf(iv)]++;
    });
    return counts;
  }, [preInvoiceStatus]);

  const filtered = useMemo(() => {
    // Invoicing status: was a client invoice issued, and did it go out?
    const r =
      invoiceFilter === "all"
        ? preInvoiceStatus
        : preInvoiceStatus.filter(({ invoices: iv }) => invoiceStatusOf(iv) === invoiceFilter);

    const sorted = [...r].sort((a, b) => {
      const av = (a.row as unknown as Record<string, unknown>)[sortKey];
      const bv = (b.row as unknown as Record<string, unknown>)[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number")
        return sortDir === "asc" ? av - bv : bv - av;
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return sorted;
  }, [preInvoiceStatus, invoiceFilter, sortKey, sortDir]);

  /**
   * The headline figures, over whatever the filters have left — so the numbers
   * and the list always describe the same population. Deliberately computed
   * before the scope chips and before the clicked figure itself, which would
   * otherwise fold back into its own total.
   */
  const statTotals = useMemo(() => {
    const out = new Map<StatKey, { events: number; count: number; byCcy: Map<string, number> }>();
    for (const stat of STATS) out.set(stat.key, { events: 0, count: 0, byCcy: new Map() });
    for (const item of filtered) {
      for (const stat of STATS) {
        if (!stat.test(item)) continue;
        const bucket = out.get(stat.key)!;
        bucket.events += 1;
        bucket.count += stat.countsInvoices ? stat.countsInvoices(item) : 1;
        const ccy = item.row.currency || "CAD";
        bucket.byCcy.set(ccy, (bucket.byCcy.get(ccy) ?? 0) + stat.amount(item));
      }
    }
    return out;
  }, [filtered]);

  // Outreach status: do we know that all active partners have been contacted?
  function partnerOutreach(
    partners: PartnerLine[],
    eventRef: string,
    hasPo: boolean,
  ): { label: string; cls: string } | null {
    // Active partners = named, not cancelled, not already fully paid.
    const active = partners.filter((p) => {
      if (!p.name || !p.name.trim()) return false;
      if (p.is_cancelled) return false;
      const due = Math.max(p.amount_due ?? 0, 0);
      const paid = Math.abs(p.amount_paid ?? 0);
      if (due <= 0.01) return false; // nothing owed
      if (paid + 0.01 >= due) return false; // fully paid
      return true;
    });
    if (active.length === 0) return null;
    if (!hasPo)
      return { label: "Waiting for PO", cls: "bg-slate-100 text-slate-700 border-slate-200" };
    // Any partner already partially paid → it's a payout issue, not an outreach one.
    const anyPartial = active.some((p) => {
      const paid = Math.abs(p.amount_paid ?? 0);
      return paid > 0.01;
    });
    if (anyPartial) return { label: "Payout TBD", cls: "bg-sky-100 text-sky-800" };
    // Contact is established either by the manual dropdown or by the email scan —
    // a row must not read "Contact TBD" when an email has demonstrably gone out.
    const contactMade = active.map((p) => {
      const k = `${eventRef}::${partnerKey(p.name)}`;
      const manual = statusMap?.get(k)?.status ?? "not_contacted";
      const emailed = factsMap?.get(k)?.contacted_at != null;
      return manual !== "not_contacted" || emailed;
    });
    if (contactMade.every((c) => !c))
      return { label: "‼️ Contact TBD", cls: "bg-rose-100 text-rose-800" };
    if (contactMade.every((c) => c))
      return { label: "⏳ Contact", cls: "bg-amber-100 text-amber-800 border-amber-200" };
    return null;
  }

  // Providers on the visible rows still missing something. Grouped by address, so a
  // provider on several bookings is contacted once.
  const incompleteTargets = useMemo(
    () =>
      buildTargets(
        filtered.flatMap(({ row: r, partners: ps }) => {
          const ref = r.readable_id ?? r.client_request_id ?? "";
          const hasPo = Boolean(r.purchase_order_number);
          return ps.map((p) => ({
            eventRef: ref,
            eventDate: r.start_date ?? null,
            name: p.name,
            email: p.email,
            country: p.country,
            currency: p.currency,
            amountDue: p.amount_due,
            action: actionFor(ref, p, hasPo),
            isCancelled: p.is_cancelled,
          }));
        }),
      ),
    [filtered, actionFor],
  );

  /**
   * The work, split into one list per action type.
   *
   * The redesign's central move: an event with three outstanding actions belongs
   * to three lists, once per task, instead of collapsing into a single pill that
   * has to stand for all of them. Every predicate here is one of the page's
   * existing verdicts — nothing new is computed about an event, it is only
   * routed differently.
   */
  const listsOf = useCallback(
    (item: Decorated) => {
      const { row: r, partners: ps, invoices: iv } = item;
      const ref = r.readable_id ?? r.client_request_id ?? "";
      const hasPo = hasPurchaseOrder(r);
      const owed = unpaidPartners(ps);

      /** Providers we cannot pay yet because something is missing. */
      const toAsk = owed.filter(({ partner }) => {
        if (!partner.email) return false;
        return needsOf(actionFor(ref, partner, hasPo), partner.country) != null;
      });
      /** Providers we hold everything for — the payout is ours to make. */
      const payable = owed.filter(
        ({ partner }) => actionFor(ref, partner, hasPo).code === "ours_pay",
      );

      const outreach = partnerOutreach(ps, ref, hasPo);
      const awaitingReply = outreach?.label.includes("⏳") === true;
      const invoiceSent = earliestSent(iv) != null;
      const overdue = paymentStatus(r, iv).variant === "overdue";

      const keys = new Set<ListKey>();
      if (hasPo && toAsk.length > 0) keys.add("ask");
      if (hasPo && payable.length > 0) keys.add("pay");
      if (hasPo && !invoiceSent) keys.add("invoice");
      if (overdue) keys.add("chase");
      if (hasPo && awaitingReply) keys.add("waiting");

      return {
        keys,
        toAsk,
        payable,
        owed,
        invoiceSent,
        // Units the headline counts: partners for the partner lists, events for
        // the client ones.
        units: {
          ask: toAsk.length,
          pay: payable.length,
          invoice: 1,
          chase: 1,
          waiting: owed.length,
        } as Record<ListKey, number>,
        amounts: {
          ask: toAsk.reduce((t, u) => t + u.remaining, 0),
          pay: payable.reduce((t, u) => t + u.remaining, 0),
          invoice: stillToInvoice(r),
          chase: Math.max(r.client_reste_a_encaisser_ttc ?? 0, 0),
          waiting: owed.reduce((t, u) => t + u.remaining, 0),
        } as Record<ListKey, number>,
      };
    },
    [actionFor, partnerOutreach],
  );

  const listed = useMemo(
    () => filtered.map((item) => ({ item, lists: listsOf(item) })),
    [filtered, listsOf],
  );

  /** One row per action list, in the order the overview shows them. */
  const actionLists = useMemo(() => {
    return LIST_ORDER.map((key) => {
      const meta = LIST_META[key];
      const members = listed.filter(({ lists }) => lists.keys.has(key));
      const units = members.reduce((total, { lists }) => total + lists.units[key], 0);
      const byCcy = new Map<string, number>();
      members.forEach(({ item, lists }) => {
        const ccy = item.row.currency || "CAD";
        byCcy.set(ccy, (byCcy.get(ccy) ?? 0) + lists.amounts[key]);
      });
      return {
        key,
        meta,
        events: members.length,
        units,
        byCcy,
        title: meta.title(units),
        detail: meta.detail(members),
      };
    });
  }, [listed]);

  /** The four disjoint slices of the portfolio, and their total. */
  const portfolio = useMemo(() => {
    let toCollect = 0;
    let toPartners = 0;
    let notInvoiced = 0;
    let overdue = 0;
    let needsMove = 0;
    let breached = 0;
    for (const { item, lists } of listed) {
      const out = Math.max(item.row.client_reste_a_encaisser_ttc ?? 0, 0);
      // Overdue is carved out of what the client owes rather than counted twice,
      // so the four segments add up to the headline figure.
      if (paymentStatus(item.row, item.invoices).variant === "overdue") overdue += out;
      else toCollect += out;
      toPartners += Math.max(item.row.partner_reste_a_decaisser_ttc ?? 0, 0);
      notInvoiced += lists.invoiceSent ? 0 : stillToInvoice(item.row);
      if (lists.keys.size > 0) needsMove += 1;
      const breach =
        invoicingSla(item.row, item.invoices).variant === "overdue" ||
        payoutSla(item.row, item.partners).variant === "overdue" ||
        paymentStatus(item.row, item.invoices).variant === "overdue";
      if (breach) breached += 1;
    }
    const total = toCollect + toPartners + notInvoiced + overdue;
    return { toCollect, toPartners, notInvoiced, overdue, total, needsMove, breached };
  }, [listed]);

  /**
   * The service record over the last 90 days — how well the two SLAs were
   * actually held, not how much is outstanding today.
   *
   * "Payouts inside 24 h" is measured against the payout FX date, the only
   * timestamp we hold per partner leg, so it counts legs that were actually
   * paid; legs still open are in "Open breaches" instead.
   */
  const slaRail = useMemo(() => {
    const cutoff = Date.now() - 90 * 86_400_000;
    const recent = decorated.filter(({ row }) => {
      const t = Date.parse(row.booking_date ?? row.booking_created_at ?? "");
      return !Number.isNaN(t) && t >= cutoff;
    });

    const sent = recent.filter(({ invoices }) => earliestSent(invoices) != null);
    const onTime = sent.filter(
      ({ row, invoices }) => invoicingSla(row, invoices).variant === "paid",
    ).length;

    const days = recent
      .map(({ row }) => row.days_booking_to_first_emission)
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);
    const median =
      days.length === 0
        ? null
        : days.length % 2 === 1
          ? days[(days.length - 1) / 2]
          : (days[days.length / 2 - 1] + days[days.length / 2]) / 2;

    let legs = 0;
    let inTime = 0;
    for (const { row, partners } of recent) {
      const po = row.purchase_order_date ? Date.parse(row.purchase_order_date) : NaN;
      if (Number.isNaN(po)) continue;
      for (const p of partners) {
        if (p.is_cancelled || !p.payout_fx_date) continue;
        const paidAt = Date.parse(p.payout_fx_date);
        if (Number.isNaN(paidAt)) continue;
        legs += 1;
        if (paidAt <= po + 86_400_000) inTime += 1;
      }
    }

    return [
      {
        label: "Invoices sent on time",
        value: sent.length === 0 ? "—" : `${Math.round((onTime / sent.length) * 100)}%`,
      },
      {
        label: "Median days to invoice",
        value: median == null ? "—" : median.toFixed(1).replace(".", ","),
      },
      {
        label: "Payouts inside 24 h",
        value: legs === 0 ? "—" : `${Math.round((inTime / legs) * 100)}%`,
      },
      {
        label: "Open breaches",
        value: String(portfolio.breached),
        alert: portfolio.breached > 0,
      },
    ];
  }, [decorated, portfolio.breached]);

  useRegisterTrackerActions(
    {
      onRefresh: () => refetch(),
      isFetching,
      exports: [
        {
          label: "Export unpaid partners",
          onClick: () => exportUnpaidPartners(decorated),
          disabled: isLoading || decorated.length === 0,
        },
        {
          label: "Export contact to-do",
          onClick: () => exportContactToBeDone(decorated, statusMap),
          disabled: isLoading || decorated.length === 0,
        },
      ],
      search: {
        placeholder: "Event code, PO, partner, invoice",
        onOpen: () => setPaletteOpen(true),
      },
      status: {
        text: isFetching ? "Syncing…" : `Synced ${syncedLabel}`,
        action: { label: "Refresh", onClick: () => refetch() },
      },
    },
    [isFetching, isLoading, decorated.length, syncedLabel],
  );

  /**
   * The rows of the open action list.
   *
   * A list about partners has one row per partner — the unit the overview
   * counted — and a list about the client has one row per event. Every sentence
   * is built from a verdict the page already computes; nothing here decides
   * anything new about an event.
   */
  const listRows = useMemo<PaperRow[]>(() => {
    if (!activeList) return [];
    const out: PaperRow[] = [];
    for (const { item, lists } of listed) {
      if (!lists.keys.has(activeList)) continue;
      const r = item.row;
      const ref = r.readable_id ?? r.client_request_id ?? "";
      const hasPo = hasPurchaseOrder(r);
      const meta = metaLine(r, item.partners);
      const clientOut = Math.max(r.client_reste_a_encaisser_ttc ?? 0, 0);
      const payout = payoutSla(r, item.partners);
      const breach = payout.variant === "overdue" ? payout.label : null;
      const ccy = r.currency ?? "CAD";

      if (activeList === "ask" || activeList === "waiting") {
        const source = activeList === "ask" ? lists.toAsk : lists.owed;
        for (const { partner, remaining } of source) {
          const key = partnerKey(partner.name ?? partner.email ?? "");
          const action = actionFor(ref, partner, hasPo);
          const facts = factsMap?.get(`${ref}::${key}`);
          const state = partnerState(facts, action, breach);
          if (activeList === "ask") {
            const needs = needsOf(action, partner.country);
            if (!needs) continue;
            out.push({
              id: `${ref}::${key}`,
              ref,
              lead: "Ask",
              strong: partnerLabel(partner),
              tail: askTail(action, needs),
              meta,
              state: state.text,
              stateAlert: state.alert,
              a: fmtPaper(remaining),
              b: fmtPaper(clientOut),
              trail: daysLabel(facts?.contacted_at),
              trailAlert: state.alert,
              target: incompleteTargets.find(
                (t) =>
                  t.eventRef === ref &&
                  t.address === (partner.email ?? "").trim().toLowerCase() &&
                  t.partnerName === (partner.name ?? partner.email ?? ""),
              ),
            });
          } else {
            out.push({
              id: `${ref}::${key}`,
              ref,
              lead: "Wait on",
              strong: partnerLabel(partner),
              tail: "— the ask is with them",
              meta,
              state: state.text,
              stateAlert: state.alert,
              a: fmtPaper(remaining),
              b: fmtPaper(clientOut),
              trail: daysLabel(facts?.contacted_at),
            });
          }
        }
        continue;
      }

      if (activeList === "pay") {
        for (const { partner, remaining } of lists.payable) {
          const key = partnerKey(partner.name ?? partner.email ?? "");
          const action = actionFor(ref, partner, hasPo);
          const byCard = action.payableBy === "card";
          out.push({
            id: `${ref}::${key}`,
            ref,
            lead: "Pay",
            strong: partnerLabel(partner),
            tail: `${fmtCurrency(remaining, partner.currency ?? ccy)} ${
              byCard ? "on the approved card" : "by transfer"
            }`,
            meta,
            state: breach
              ? `${breach} · everything needed is on file`
              : "Everything needed is on file · the payout is due 24 h after the PO",
            stateAlert: breach != null,
            a: fmtPaper(remaining),
            b: fmtPaper(clientOut),
            trail: daysLabel(r.purchase_order_date),
            trailAlert: breach != null,
          });
        }
        continue;
      }

      if (activeList === "invoice") {
        const sla = invoicingSla(r, item.invoices);
        const late = sla.variant === "overdue" || sla.variant === "partial";
        out.push({
          id: ref,
          ref,
          lead: "Invoice",
          strong: r.company_name ?? "L'Oréal Canada",
          tail: `for the ${(r.event_type || "event").replaceAll("_", " ").toLowerCase()}`,
          meta,
          state: `${sla.label} · invoices must be sent 3 days after the event ends`,
          stateAlert: late,
          a: fmtPaper(stillToInvoice(r)),
          b: fmtPaper(clientOut),
          trail: daysLabel(r.end_date ?? r.start_date),
          trailAlert: late,
          aAlert: late,
        });
        continue;
      }

      // chase
      const pay = paymentStatus(r, item.invoices);
      const sentAt = earliestSent(item.invoices);
      out.push({
        id: ref,
        ref,
        lead: "Chase",
        strong: r.company_name ?? "L'Oréal Canada",
        tail: `for ${fmtCurrency(clientOut, ccy)} still open`,
        meta,
        state: `${pay.label} · sent ${daysLabel(sentAt)} ago · payment terms are 60 days`,
        stateAlert: pay.variant === "overdue",
        a: fmtPaper(clientOut),
        b: fmtPaper(r.client_invoiced_ttc ?? 0),
        trail: daysLabel(sentAt),
        trailAlert: pay.variant === "overdue",
        aAlert: pay.variant === "overdue",
      });
    }
    return out;
  }, [activeList, listed, actionFor, factsMap, incompleteTargets]);

  /** Rows for a headline figure the user clicked: the events behind the number. */
  const statRows = useMemo<PaperRow[]>(() => {
    const stat = statFilter ? STATS.find((s) => s.key === statFilter) : null;
    if (!stat) return [];
    return filtered
      .filter((item) => stat.test(item))
      .map((item) => {
        const r = item.row;
        const ref = r.readable_id ?? r.client_request_id ?? "";
        const status = INVOICE_STATUS_META[invoiceStatusOf(item.invoices)].label;
        return {
          id: ref,
          ref,
          lead: "",
          strong: (r.event_type || "event").replaceAll("_", " ").toLowerCase(),
          tail: `for ${r.company_name ?? "L'Oréal Canada"}`,
          meta: metaLine(r, item.partners),
          state: `${status} · ${
            hasPurchaseOrder(r)
              ? `PO received ${fmtDate(r.purchase_order_date)}`
              : "no purchase order yet"
          }`,
          a: fmtPaper(stat.amount(item)),
          b: fmtPaper(Math.max(r.client_reste_a_encaisser_ttc ?? 0, 0)),
          trail: daysLabel(r.booking_date),
        } satisfies PaperRow;
      });
  }, [statFilter, filtered]);

  /**
   * ⌘K. Three groups, in the order the design shows them: the events that match,
   * the partners on them, then invoices. Matching is deliberately loose — a
   * partial code (`0847`) is how anyone actually remembers a reference.
   */
  /**
   * Everything searchable about an event, precomputed once. Rebuilding this per
   * keystroke is what pushes a search into feeling slow.
   */
  const searchIndex = useMemo(
    () =>
      decorated.map((item) => ({
        item,
        ref: item.row.readable_id ?? item.row.client_request_id ?? "",
        hay: haystack([
          item.row.readable_id,
          item.row.client_request_id,
          item.row.purchase_order_number,
          item.row.company_name,
          item.row.event_type,
          item.row.billing_entity,
          item.row.country_iso_code,
          ...item.partners.map((p) => `${p.name ?? ""} ${p.email ?? ""}`),
          ...item.invoices.map((i) => i.invoice_ref ?? ""),
        ]),
      })),
    [decorated],
  );

  /**
   * ⌘K. Three groups, in the order the design shows them: the events that match,
   * the partners on them, then invoices. Matching is deliberately loose — a
   * partial code (`0847`) is how anyone actually remembers a reference.
   *
   * It searches **every** event, not the filtered list: a filter is a statement
   * about a list, never about what can be found. The cap exists only so the
   * panel stays readable, and it says what it left out.
   */
  const paletteGroups = useMemo<PaletteGroup[]>(() => {
    const q = paletteQuery.trim().toLowerCase();
    if (!q) return [];
    const LIMIT = 25;
    const open = (ref: string) => {
      setSelectedRef(ref);
      setPaletteOpen(false);
    };

    const matches = matching(searchIndex, q).map(({ item }) => item);

    const eventItems = matches.slice(0, LIMIT).map(({ row: r, partners, invoices }) => {
      const ref = r.readable_id ?? r.client_request_id ?? "";
      const member = listed.find(({ item }) => item.row === r);
      const moves = member ? member.lists.keys.size : 0;
      return {
        id: `event-${ref}`,
        title: `${ref} · ${(r.event_type || "event").replaceAll("_", " ").toLowerCase()}`,
        meta: [
          r.company_name,
          r.country_iso_code,
          r.purchase_order_number ? `PO ${r.purchase_order_number}` : "no PO",
          `${partners.filter((p) => !p.is_cancelled).length} partners`,
          `${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`,
        ]
          .filter(Boolean)
          .join(" · "),
        amount: fmtPaper(Math.max(r.client_reste_a_encaisser_ttc ?? 0, 0)),
        amountLabel: "client outstanding",
        note: moves > 0 ? `${moves} move${moves === 1 ? "" : "s"} waiting` : null,
        onPick: () => open(ref),
      };
    });

    // A partner named in the query is worth listing on every event they are on;
    // a single matching event lists all of its partners instead.
    const partnerHits = matches.flatMap(({ row: r, partners }) => {
      const ref = r.readable_id ?? r.client_request_id ?? "";
      const hasPo = hasPurchaseOrder(r);
      return partners
        .filter((p) => !p.is_cancelled)
        .filter(
          (p) =>
            matches.length === 1 || `${p.name ?? ""} ${p.email ?? ""}`.toLowerCase().includes(q),
        )
        .map((p) => {
          const action = actionFor(ref, p, hasPo);
          const facts = factsMap?.get(`${ref}::${partnerKey(p.name ?? p.email ?? "")}`);
          const state = partnerState(facts, action, null);
          return {
            id: `partner-${ref}-${partnerKey(p.name ?? p.email ?? "")}`,
            title: partnerLabel(p),
            meta: `${state.text} · ${ref}`,
            metaAlert: state.alert,
            amount: fmtPaper(Math.max(p.amount_due ?? 0, 0)),
            onPick: () => open(ref),
          };
        });
    });

    const invoiceHits = matches.flatMap(({ row: r, invoices }) => {
      const ref = r.readable_id ?? r.client_request_id ?? "";
      return invoices
        .filter((i) => matches.length === 1 || (i.invoice_ref ?? "").toLowerCase().includes(q))
        .map((i) => ({
          id: `invoice-${ref}-${i.invoice_ref ?? i.emission_date ?? ""}`,
          title: i.invoice_ref ?? "—",
          meta: `${isSent(i) ? `Sent ${fmtDate(i.first_sent_at)}` : "Issued, not sent"} · due ${fmtDate(
            i.due_date,
          )} · ${ref}`,
          amount: fmtPaper(i.amount_ttc ?? 0),
          onPick: () => open(ref),
        }));
    });

    return [
      {
        label: "Event",
        items: eventItems,
        overflow: overflowNote(matches.length, LIMIT, "events"),
      },
      {
        label: "Partners on this event",
        items: partnerHits.slice(0, LIMIT),
        overflow: overflowNote(partnerHits.length, LIMIT, "partners"),
      },
      {
        label: "Invoice",
        items: invoiceHits.slice(0, LIMIT),
        overflow: overflowNote(invoiceHits.length, LIMIT, "invoices"),
      },
    ];
  }, [paletteQuery, searchIndex, listed, actionFor, factsMap]);

  /**
   * The open event, looked up across every event rather than the filtered list.
   * A filter narrows a list; it must not decide what can be opened, or a search
   * result — or a pasted link — lands on nothing.
   */
  const selected = useMemo(() => {
    if (!selectedRef) return null;
    const hit = decorated.find(
      (x) => (x.row.readable_id ?? x.row.client_request_id ?? "") === selectedRef,
    );
    if (!hit) return null;
    return { ...hit, toPay: hasPurchaseOrder(hit.row) ? unpaidPartners(hit.partners) : [] };
  }, [decorated, selectedRef]);

  const sel = selected?.row ?? null;
  const selPartners = selected?.partners ?? [];
  const selInvoices = selected?.invoices ?? [];
  const selRef = sel ? (sel.readable_id ?? sel.client_request_id ?? "") : "";

  const selLists = useMemo(() => (selected ? listsOf(selected) : null), [selected, listsOf]);

  /**
   * Everything the open event's screen needs, in the order the design reads it:
   * the figures, what can be done next, the partners, the invoices and the
   * trail. Each piece is a rendering of a verdict computed above.
   */
  const eventScreen = useMemo(() => {
    if (!sel || !selLists) return null;
    const hasPo = hasPurchaseOrder(sel);
    const inv = invoicingSla(sel, selInvoices);
    const pay = paymentStatus(sel, selInvoices);
    const payout = payoutSla(sel, selPartners);
    const breach = payout.variant === "overdue" ? payout.label : null;
    const ccy = sel.currency ?? "CAD";

    const stats = [
      {
        label: "Client outstanding",
        value: fmtCurrency(sel.client_reste_a_encaisser_ttc, ccy),
        alert: pay.variant === "overdue",
      },
      {
        label: "Owed to partners",
        value: fmtCurrency(sel.partner_reste_a_decaisser_ttc, ccy),
        alert: breach != null,
      },
      { label: "Invoicing SLA", value: inv.label, alert: inv.variant === "overdue" },
      { label: "Client payment", value: pay.label, alert: pay.variant === "overdue" },
    ];

    const moves: EventMove[] = [];
    for (const { partner, remaining } of selLists.toAsk) {
      const key = partnerKey(partner.name ?? partner.email ?? "");
      const action = actionFor(selRef, partner, hasPo);
      const needs = needsOf(action, partner.country);
      if (!needs) continue;
      const facts = factsMap?.get(`${selRef}::${key}`);
      const state = partnerState(facts, action, breach);
      const mine = incompleteTargets.filter(
        (t) => t.eventRef === selRef && t.address === (partner.email ?? "").trim().toLowerCase(),
      );
      moves.push({
        id: `ask-${key}`,
        lead: "Ask",
        strong: partnerLabel(partner),
        tail: askTail(action, needs),
        reason: state.text,
        reasonAlert: state.alert,
        action:
          gmailConnection?.connected && mine.length > 0
            ? { label: "Review & send", primary: true, onClick: () => requestDialog.open(mine) }
            : undefined,
      });
      void remaining;
    }
    for (const { partner, remaining } of selLists.payable) {
      const key = partnerKey(partner.name ?? partner.email ?? "");
      moves.push({
        id: `pay-${key}`,
        lead: "Pay",
        strong: partnerLabel(partner),
        tail: `${fmtCurrency(remaining, partner.currency ?? ccy)} by transfer`,
        reason: breach ?? "Everything needed is on file. The payout is due 24 h after the PO.",
        reasonAlert: breach != null,
        action: {
          label: "Mark as paid",
          onClick: () =>
            setStatus.mutate({
              event_ref: selRef,
              partner_name: partner.name ?? partner.email ?? "",
              status: "fully_paid",
            }),
        },
      });
    }
    if (selLists.keys.has("invoice")) {
      moves.push({
        id: "invoice",
        lead: "Invoice",
        strong: sel.company_name ?? "L'Oréal Canada",
        tail: `for ${fmtCurrency(stillToInvoice(sel), ccy)}`,
        reason: `${inv.label} · invoices must be sent 3 days after the event ends`,
        reasonAlert: inv.variant === "overdue",
        action: sel.booking_url
          ? {
              label: "Open the back office",
              onClick: () => window.open(sel.booking_url as string, "_blank"),
            }
          : undefined,
      });
    }
    if (selLists.keys.has("chase")) {
      moves.push({
        id: "chase",
        lead: "Chase",
        strong: sel.company_name ?? "L'Oréal Canada",
        tail: `for ${fmtCurrency(Math.max(sel.client_reste_a_encaisser_ttc ?? 0, 0), ccy)}`,
        reason: `${pay.label} · payment terms are 60 days from the day the invoice was sent`,
        reasonAlert: pay.variant === "overdue",
      });
    }

    const partnerRows: EventPartnerRow[] = selPartners
      .filter((p) => !p.is_cancelled)
      .map((p) => {
        const key = partnerKey(p.name ?? p.email ?? "");
        const action = actionFor(selRef, p, hasPo);
        const facts = factsMap?.get(`${selRef}::${key}`);
        const due = Math.max((p.amount_due ?? 0) - Math.abs(p.amount_paid ?? 0), 0);
        const paid = Math.abs(p.amount_paid ?? 0);
        const state = partnerState(facts, action, due > 0.01 ? breach : null);
        const manual = statusMap?.get(`${selRef}::${key}`)?.status;
        const onStatement = () => {
          const entry = supplierStatement(statementEvent(sel), {
            name: partnerLabel(p),
            email: p.email,
            currency: p.currency ?? ccy,
            payable: p.net_payable_ttc,
            due,
            paid,
          });
          openStatement(entry);
        };
        return {
          key,
          name: partnerLabel(p),
          contact:
            [p.email, p.phone, p.country].filter(Boolean).join(" · ") || "no contact on file",
          state:
            due <= 0.01
              ? `Paid in full${p.payout_fx_date ? ` on ${fmtDate(p.payout_fx_date)}` : ""}. Nothing left to do.`
              : state.text,
          stateAlert: due > 0.01 && state.alert,
          muted: due <= 0.01,
          figures: [
            { label: "Due", value: fmtCurrency(due, p.currency ?? ccy) },
            { label: "Paid", value: fmtCurrency(paid, p.currency ?? ccy) },
          ],
          links: (
            <>
              <DownloadLink onClick={onStatement} className="text-[12.5px]">
                Supplier statement · {partnerLabel(p)}, this event
              </DownloadLink>
              <label className="inline-flex items-center gap-1.5 text-[12.5px] text-paper-muted">
                <span className="sr-only">Status of {partnerLabel(p)}</span>
                <select
                  value={manual ?? "not_contacted"}
                  onChange={(e) =>
                    setStatus.mutate({
                      event_ref: selRef,
                      partner_name: p.name ?? p.email ?? "",
                      status: e.target.value as PartnerStatusValue,
                    })
                  }
                  className="border-b border-paper-rule-strong bg-transparent pb-0.5 text-[12.5px] text-paper-muted outline-none"
                >
                  {PARTNER_STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ),
        } satisfies EventPartnerRow;
      });

    const invoiceRows = selInvoices.map((i, n) => ({
      id: `${i.invoice_ref ?? n}`,
      ref: i.invoice_ref ?? "—",
      prose: [
        `Emitted ${fmtDate(i.emission_date)}`,
        isSent(i) ? `sent by email ${fmtDate(i.first_sent_at)}` : "not sent yet",
        `payment due ${fmtDate(i.due_date)}`,
      ].join(", "),
      amount: fmtCurrency(i.amount_ttc, i.currency ?? ccy),
    }));

    // The trail: what happened on this event, newest first.
    const history: Array<{ id: string; title: string; meta: string; at: string }> = [];
    if (sel.purchase_order_number && sel.purchase_order_date) {
      history.push({
        id: "po",
        title: `Purchase order ${sel.purchase_order_number} received`,
        meta: fmtDate(sel.purchase_order_date),
        at: sel.purchase_order_date,
      });
    }
    for (const p of selPartners) {
      const key = partnerKey(p.name ?? p.email ?? "");
      const facts = factsMap?.get(`${selRef}::${key}`);
      if (!facts) continue;
      const who = facts.scanned_by ? ` · found in ${facts.scanned_by.split("@")[0]}'s mailbox` : "";
      if (facts.bank_received_at) {
        history.push({
          id: `bank-${key}`,
          title: `Bank details received from ${partnerLabel(p)}`,
          meta: `${fmtDate(facts.bank_received_at)}${who}`,
          at: facts.bank_received_at,
        });
      }
      if (facts.tax_received_at) {
        history.push({
          id: `tax-${key}`,
          title: `Tax numbers received from ${partnerLabel(p)}`,
          meta: `${fmtDate(facts.tax_received_at)}${who}`,
          at: facts.tax_received_at,
        });
      }
      if (facts.contacted_at) {
        history.push({
          id: `asked-${key}`,
          title: `${partnerLabel(p)} asked for what was missing`,
          meta: `${fmtDate(facts.contacted_at)}${
            facts.contacted_by ? ` · by ${facts.contacted_by.split("@")[0]}` : ""
          }`,
          at: facts.contacted_at,
        });
      }
      if (facts.card_payment === "accepted" && facts.card_decided_at) {
        history.push({
          id: `card-${key}`,
          title: `${partnerLabel(p)} accepts a card`,
          meta: fmtDate(facts.card_decided_at),
          at: facts.card_decided_at,
        });
      }
    }
    for (const i of selInvoices) {
      if (!i.first_sent_at) continue;
      history.push({
        id: `inv-${i.invoice_ref ?? i.first_sent_at}`,
        title: `Invoice ${i.invoice_ref ?? ""} sent to ${sel.company_name ?? "the client"}`.trim(),
        meta: `${fmtDate(i.first_sent_at)} · payment due ${fmtDate(i.due_date)}`,
        at: i.first_sent_at,
      });
    }
    history.sort((a, b) => (a.at < b.at ? 1 : -1));

    return { stats, moves, partnerRows, invoiceRows, history: history.slice(0, 6) };
  }, [
    sel,
    selLists,
    selRef,
    selPartners,
    selInvoices,
    actionFor,
    factsMap,
    statusMap,
    incompleteTargets,
    gmailConnection,
    requestDialog,
    setStatus,
  ]);

  /**
   * The filters that were always here, kept where they belong on a list screen:
   * behind one control, so the rows stay the loudest thing on the page.
   */
  const filtersPopover = (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-2 text-paper-body underline-offset-[3px] hover:underline"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.6} aria-hidden="true" />
          Filters
          {(kindFilter !== "no_turnkey" ||
            tagFilter.length > 0 ||
            invoiceFilter !== "all" ||
            statusFilter !== "all" ||
            search.trim() !== "") && (
            <span className="font-paper-mono text-[11px] text-paper-label">on</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] space-y-2.5">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Narrow to a ref, partner or invoice…"
          aria-label="Narrow the list"
          className="h-8 text-[12px]"
        />
        <Select value={kindFilter} onValueChange={setKindFilter}>
          <SelectTrigger className="h-8 w-full text-[12px]">
            <SelectValue placeholder="Transaction kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="no_turnkey">Hors turnkey</SelectItem>
            <SelectItem value="all">Tous les types</SelectItem>
            <SelectItem value="PORTAGE">Portage</SelectItem>
            <SelectItem value="VENUE_FINDING">Venue finding</SelectItem>
            <SelectItem value="TURNKEY">Turnkey seulement</SelectItem>
          </SelectContent>
        </Select>
        <TagFilterSelect groups={TAG_FILTER_GROUPS} selected={tagFilter} onChange={setTagFilter} />
        <Select
          value={invoiceFilter}
          onValueChange={(v) => setInvoiceFilter(v as InvoiceStatus | "all")}
        >
          <SelectTrigger className="h-8 w-full text-[12px]">
            <SelectValue placeholder="Invoicing status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All invoicing statuses</SelectItem>
            {INVOICE_STATUS_ORDER.map((s) => (
              <SelectItem key={s} value={s}>
                {INVOICE_STATUS_META[s].label} ({invoiceStatusCounts[s]})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-full text-[12px]">
            <SelectValue placeholder="Filter" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All events</SelectItem>
            <SelectItem value="invoicing_breached">Invoicing SLA breached</SelectItem>
            <SelectItem value="payout_breached">Payout SLA breached</SelectItem>
            <SelectItem value="partner_outstanding">Partner outstanding</SelectItem>
          </SelectContent>
        </Select>
      </PopoverContent>
    </Popover>
  );

  /** Each of these is one navigation, so the back button walks the trail. */
  const goToOverview = useCallback(() => {
    setPanel(null);
    navigate({ search: {} });
  }, [navigate]);

  const openList = useCallback((key: ListKey) => navigate({ search: { list: key } }), [navigate]);

  const openFigure = useCallback(
    (key: StatKey) => navigate({ search: { figure: key } }),
    [navigate],
  );

  /**
   * A rail link that opens a panel has to take you there — a panel appearing
   * below the fold with no movement reads as a link that does nothing.
   */
  const openPanel = useCallback((which: "emails" | "docs") => {
    setPanel((prev) => (prev === which ? null : which));
    requestAnimationFrame(() =>
      document
        .getElementById("event-panel")
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  }, []);

  usePaletteShortcut(useCallback(() => setPaletteOpen(true), []));

  /**
   * A list opens with everything ticked: the point of the screen is to clear the
   * list, so unticking is the exception. Re-ticking as the rows change would
   * fight the user, so this only runs when the list itself changes.
   */
  useEffect(() => {
    setSelection(new Set(listRows.filter((r) => r.target).map((r) => r.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeList]);

  const selectedTargets = useMemo(
    () =>
      listRows.filter((r) => r.target && selection.has(r.id)).map((r) => r.target as RequestTarget),
    [listRows, selection],
  );

  /** Every statement for the open event, as one archive. */
  const downloadEventStatements = useCallback(() => {
    if (!selected) return;
    const entries = [
      ...supplierStatementsFor(selected),
      clientStatementFor({ row: selected.row, invoices: selected.invoices }),
    ];
    download(
      new Blob([zipStored(entries)], { type: "application/zip" }),
      `${(selected.row.readable_id ?? "event").replace(/[^\w-]/g, "-")}-account-statement.zip`,
    );
  }, [selected]);

  /** "Download this list" — the rows exactly as they are on screen. */
  const exportListCsv = useCallback(
    (rows: PaperRow[], name: string, columns: [string, string, string]) => {
      download(
        new Blob([listCsv(rows, columns)], { type: "text/csv;charset=utf-8;" }),
        listFileName(name, new Date().toISOString().slice(0, 10)),
      );
    },
    [],
  );

  /** The refs of the list we came from, so ← Previous / Next → can walk it. */
  const walk = useMemo(() => {
    const source = activeList ? listRows : statFilter ? statRows : [];
    const refs: string[] = [];
    for (const row of source) if (!refs.includes(row.ref)) refs.push(row.ref);
    const at = refs.indexOf(selRef);
    return {
      prev: at > 0 ? refs[at - 1] : null,
      next: at >= 0 && at < refs.length - 1 ? refs[at + 1] : null,
    };
  }, [activeList, statFilter, listRows, statRows, selRef]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      {error != null && (
        <div
          role="alert"
          className="flex-none border-b border-rose-200 bg-rose-50 px-5 py-2.5 text-sm text-rose-800"
        >
          Failed to load data: {String((error as Error).message ?? error)}
        </div>
      )}
      {factsError != null && (
        <div
          role="alert"
          className="flex-none border-b border-rose-200 bg-rose-50 px-5 py-1.5 text-xs text-rose-800"
        >
          Pastilles email non chargées : {String((factsError as Error).message ?? factsError)}
        </div>
      )}
      {(scanProgress.running || scanProgress.error) && (
        <div
          role="status"
          className={`flex-none border-b px-5 py-1.5 text-xs ${
            scanProgress.error
              ? "border-rose-200 bg-rose-50 text-rose-800"
              : "border-border bg-slate-50 text-slate-600"
          }`}
        >
          {scanProgress.error
            ? `Recherche interrompue : ${scanProgress.error}`
            : `Analyse de vos emails — ${scanProgress.done}/${scanProgress.total} événements, ${scanProgress.matched} partenaires rapprochés.`}
        </div>
      )}

      {/* ── Screens ───────────────────────────────────────────────────────
          Overview → list → event, each one narrowing the last. An open event
          wins over the list it came from, and ⌘K can jump straight to one. */}
      {sel != null && eventScreen != null ? (
        <EventScreen
          crumbs={[
            { label: "Overview", onClick: goToOverview },
            ...(activeList
              ? [{ label: LIST_META[activeList].name, onClick: () => setSelectedRef("") }]
              : statFilter
                ? [
                    {
                      label: STATS.find((x) => x.key === statFilter)?.label ?? "Figure",
                      onClick: () => setSelectedRef(""),
                    },
                  ]
                : []),
            { label: selRef },
          ]}
          onPrev={walk.prev ? () => setSelectedRef(walk.prev as string) : undefined}
          onNext={walk.next ? () => setSelectedRef(walk.next as string) : undefined}
          statement={{
            label: "Account statement · this event",
            onClick: downloadEventStatements,
          }}
          backOffice={sel.booking_url}
          eventLabel={(sel.event_type || "event").replaceAll("_", " ").toLowerCase()}
          reference={selRef}
          po={sel.purchase_order_number ? String(sel.purchase_order_number) : null}
          meta={[
            sel.company_name,
            sel.country_iso_code,
            sel.billing_entity,
            sel.start_date
              ? `${fmtDate(sel.start_date)}${sel.end_date ? ` → ${fmtDateShort(sel.end_date)}` : ""}`
              : null,
            sel.booking_date ? `booked ${daysLabel(sel.booking_date)} ago` : null,
            `${selPartners.filter((p) => !p.is_cancelled).length} partners`,
          ]
            .filter(Boolean)
            .join(" · ")}
          stats={eventScreen.stats}
          moves={eventScreen.moves}
          partners={eventScreen.partnerRows}
          invoices={eventScreen.invoiceRows}
          onClientStatement={() => {
            const entry = clientStatementFor({ row: sel, invoices: selInvoices });
            openStatement(entry);
          }}
          clientStatementLabel={`Client statement · ${sel.company_name ?? "the client"}, this event`}
          clientAlert={paymentStatus(sel, selInvoices).variant === "overdue"}
          clientNote={
            (sel.client_reste_a_encaisser_ttc ?? 0) > 0.01
              ? `${fmtCurrency(sel.client_reste_a_encaisser_ttc, sel.currency)} of this is still to come in.`
              : null
          }
          history={eventScreen.history}
          notes={<EventNotes eventRef={selRef} />}
          rail={[
            {
              id: "emails",
              label: gmailConnection?.connected
                ? `Emails with partners — ${
                    selPartners.filter((p) => !p.is_cancelled && p.email).length
                  } addresses`
                : "Emails with partners — Gmail not connected",
              onClick: () => openPanel("emails"),
              active: panel === "emails",
            },
            {
              id: "docs",
              // The links are signed and expire in 15 minutes, so the panel
              // fetches on demand — the count cannot be known before that.
              label: "Partner invoices — load the PDFs",
              onClick: () => openPanel("docs"),
              active: panel === "docs",
            },
            {
              id: "all",
              label: `All ${eventScreen.partnerRows.length + 1} account statements for this event`,
              onClick: () => downloadEventStatements(),
              download: true,
            },
          ]}
          panelTitle={panel === "emails" ? "Emails with partners" : "Partner invoices — PDFs"}
          onClosePanel={() => setPanel(null)}
          panel={
            panel === "emails" ? (
              gmailConnection?.connected ? (
                <PartnerEmails
                  eventRef={selRef}
                  partners={selPartners
                    .filter((p) => !p.is_cancelled && p.email)
                    .map((p) => ({
                      name: p.name,
                      email: p.email,
                      owed:
                        p.amount_due != null
                          ? fmtCurrency(p.amount_due, p.currency ?? sel.currency)
                          : null,
                    }))}
                />
              ) : (
                <p className="text-[13.5px] text-paper-muted">
                  Connect Gmail from your account menu to see the threads with these partners.
                </p>
              )
            ) : panel === "docs" ? (
              <PartnerInvoicePdfs clientRequestId={sel.client_request_id} />
            ) : undefined
          }
        />
      ) : activeList !== null ? (
        <ListScreen
          crumb={LIST_META[activeList].name}
          title={actionLists.find((l) => l.key === activeList)?.title ?? LIST_META[activeList].name}
          explanation={LIST_META[activeList].explanation}
          columns={LIST_META[activeList].columns}
          unitNoun={LIST_META[activeList].unitNoun}
          rows={listRows}
          selected={selection}
          onToggle={(id) =>
            setSelection((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          primary={
            activeList === "ask" && gmailConnection?.connected
              ? {
                  label: `Review & send ${selectedTargets.length}`,
                  disabled: selectedTargets.length === 0,
                  onClick: () => requestDialog.open(selectedTargets),
                }
              : undefined
          }
          secondary={
            activeList === "ask" && gmailConnection?.connected
              ? {
                  label: "Create drafts",
                  disabled: selectedTargets.length === 0,
                  onClick: () => requestDialog.open(selectedTargets),
                }
              : undefined
          }
          siblings={actionLists
            .filter((l) => l.key !== activeList && l.events > 0)
            .map((l) => ({
              key: l.key,
              label: l.meta.name,
              count: l.units,
              onClick: () => openList(l.key),
            }))}
          filters={filtersPopover}
          isLoading={isLoading}
          onBack={goToOverview}
          onDownload={() =>
            exportListCsv(listRows, LIST_META[activeList].name, LIST_META[activeList].columns)
          }
          onOpen={(ref) => setSelectedRef(ref)}
        />
      ) : statFilter !== null ? (
        <ListScreen
          crumb={STATS.find((x) => x.key === statFilter)?.label ?? "Figure"}
          title={`${statRows.length} event${statRows.length === 1 ? "" : "s"} · ${
            STATS.find((x) => x.key === statFilter)?.label ?? ""
          }`}
          explanation={`${STATS.find((x) => x.key === statFilter)?.hint ?? ""}. This is the same population the figure counts, so the total on the overview and the rows here can never disagree.`}
          columns={[
            STATS.find((x) => x.key === statFilter)?.label ?? "Amount",
            "Client outstanding",
            "Booked",
          ]}
          unitNoun="events"
          rows={statRows}
          selected={selection}
          onToggle={() => {}}
          siblings={STATS.filter((x) => x.key !== statFilter).map((x) => ({
            key: x.key,
            label: x.label,
            count: statTotals.get(x.key)?.count ?? 0,
            onClick: () => openFigure(x.key),
          }))}
          filters={filtersPopover}
          isLoading={isLoading}
          onBack={goToOverview}
          onDownload={() =>
            exportListCsv(statRows, STATS.find((x) => x.key === statFilter)?.label ?? "figure", [
              STATS.find((x) => x.key === statFilter)?.label ?? "Amount",
              "Client outstanding",
              "Booked",
            ])
          }
          onOpen={(ref) => setSelectedRef(ref)}
        />
      ) : (
        <OverviewScreen
          portfolio={portfolio}
          lists={actionLists}
          isLoading={isLoading}
          totalEvents={listed.length}
          sla={slaRail}
          figures={STATS.map((stat) => ({
            key: stat.key,
            label: stat.label,
            hint: stat.hint,
            count: statTotals.get(stat.key)?.count ?? 0,
            amount: fmtMulti(statTotals.get(stat.key)?.byCcy ?? new Map()),
            onOpen: () => openFigure(stat.key),
          }))}
          statements={{
            suppliers: filtered.reduce((n, d) => n + supplierStatementsFor(d).length, 0),
            clients: filtered.length,
            onSuppliers: () => {
              const entries = filtered.flatMap((d) => supplierStatementsFor(d));
              download(
                new Blob([zipStored(entries)], { type: "application/zip" }),
                archiveName("supplier", new Date().toISOString().slice(0, 10)),
              );
            },
            onClients: () => {
              const entries = filtered.map((d) => clientStatementFor(d));
              download(
                new Blob([zipStored(entries)], { type: "application/zip" }),
                archiveName("client", new Date().toISOString().slice(0, 10)),
              );
            },
            onContactTodo: () => exportContactToBeDone(decorated, statusMap),
          }}
          noPoCount={listed.filter(({ item }) => !hasPurchaseOrder(item.row)).length}
          onOpen={openList}
          onSend={
            gmailConnection?.connected && incompleteTargets.length > 0
              ? () => requestDialog.open(incompleteTargets)
              : undefined
          }
          onOpenNoPo={() => openFigure("invoices_no_po")}
          gmail={gmailConnection}
          scanning={scanProgress.running}
          onScan={() =>
            startScan(
              filtered
                .filter(({ row: r, partners: ps }) =>
                  eventNeedsScan(
                    r.readable_id ?? r.client_request_id ?? "",
                    ps,
                    Boolean(r.purchase_order_number),
                  ),
                )
                .map(({ row: r, partners: ps }) => ({
                  event_ref: r.readable_id ?? r.client_request_id ?? "",
                  partners: ps
                    .filter(
                      (p) =>
                        !p.is_cancelled &&
                        actionFor(
                          r.readable_id ?? r.client_request_id ?? "",
                          p,
                          Boolean(r.purchase_order_number),
                        ).scanUseful,
                    )
                    .map((p) => ({ name: p.name ?? "", email: p.email })),
                })),
            )
          }
        />
      )}

      <CommandPalette
        open={paletteOpen}
        query={paletteQuery}
        onQuery={setPaletteQuery}
        onClose={() => setPaletteOpen(false)}
        groups={paletteGroups}
        placeholder="Event code, PO, partner, invoice"
        intro="Type an event code, a PO number, a partner name or an invoice reference. Picking a result opens that event, with every figure, partner, invoice and note on it."
        hint="Partial codes work: 0847, CA-2411, 45012773"
        cursor={paletteCursor}
        onCursor={setPaletteCursor}
      />

      {requestDialog.targets && (
        <RequestInfoDialog targets={requestDialog.targets} onClose={requestDialog.close} />
      )}
    </div>
  );
}

/** Figures on the overview are plain: no currency symbol, grouped thousands. */
/** "34 d", or "—" when nothing has been asked yet. */
function daysLabel(from: string | null | undefined): string {
  const d = daysSince(from);
  return d == null ? "—" : `${d} d`;
}

/** "14 May" — the mono meta line drops the year, the ref already dates it. */
function dayMonth(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return fmtDate(value);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
}

/** `CA-2411-0847 · PO 4501277318 · master class · booked 14 May, 94 d · 3 partners` */
function metaLine(row: SlaRow, partners: PartnerLine[]): string {
  const parts = [
    row.readable_id ?? row.client_request_id ?? "—",
    row.purchase_order_number ? `PO ${row.purchase_order_number}` : "no PO",
    (row.event_type || "—").replaceAll("_", " ").toLowerCase(),
  ];
  const booked = row.booking_date;
  if (booked) {
    const age = daysSince(booked);
    parts.push(`booked ${dayMonth(booked)}${age == null ? "" : `, ${age} d`}`);
  }
  const live = partners.filter((p) => !p.is_cancelled).length;
  parts.push(`${live} partner${live === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** What we are asking this partner for, as the end of a sentence. */
function askTail(action: PartnerAction, needs: Needs): string {
  if (action.code === "ask_card") return "to confirm the card payment";
  if (needs.bank && needs.tax) return "for bank details and tax numbers";
  if (needs.bank) return "for bank details";
  return "for tax numbers";
}

/**
 * What is already known about this partner, in one line: what we hold, when we
 * last asked, and whether a payout has breached. A breach wins the line — it is
 * the only thing here that is not just context.
 */
function partnerState(
  facts: PartnerFacts | undefined,
  action: PartnerAction,
  breach: string | null,
): { text: string; alert: boolean } {
  if (breach) {
    const held = facts?.bank_received_at
      ? `bank details received ${dayMonth(facts.bank_received_at)}`
      : facts?.contacted_at
        ? `asked ${daysLabel(facts.contacted_at)} ago, no reply`
        : "never contacted";
    return { text: `${breach} · ${held}`, alert: true };
  }
  const bits: string[] = [];
  if (action.code === "ask_card" || action.payableBy === "card") {
    bits.push("Accepted a card, so no IBAN needed");
  }
  if (facts?.bank_received_at)
    bits.push(`Bank details received ${dayMonth(facts.bank_received_at)}`);
  if (facts?.tax_received_at) bits.push("Tax numbers already on file");
  if (!facts?.contacted_at && bits.length === 0) bits.push("Never contacted");
  if (facts?.contacted_at) {
    const who = facts.contacted_by ? ` by ${facts.contacted_by.split("@")[0]}` : "";
    bits.push(
      facts.replied_at
        ? `replied ${daysLabel(facts.replied_at)} ago`
        : `asked ${daysLabel(facts.contacted_at)} ago${who}, no reply`,
    );
  }
  return { text: bits.join(" · "), alert: false };
}

/**
 * The overview.
 *
 * One headline figure, the composition behind it, then the work ranked as one
 * list per action type. Colour is spent only where something has breached; the
 * lime carries the single primary action.
 */
function OverviewScreen({
  portfolio,
  lists,
  isLoading,
  totalEvents,
  noPoCount,
  sla,
  figures,
  statements,
  onOpen,
  onSend,
  onOpenNoPo,
  gmail,
  scanning,
  onScan,
}: {
  portfolio: {
    toCollect: number;
    toPartners: number;
    notInvoiced: number;
    overdue: number;
    total: number;
    needsMove: number;
    breached: number;
  };
  lists: Array<{
    key: ListKey;
    meta: (typeof LIST_META)[ListKey];
    events: number;
    units: number;
    byCcy: Map<string, number>;
    title: string;
    detail: string;
  }>;
  isLoading: boolean;
  totalEvents: number;
  noPoCount: number;
  /** The 90-day service record, as label/value rows. */
  sla: Array<{ label: string; value: string; alert?: boolean }>;
  /** The six headline figures, each one opening the events behind it. */
  figures: Array<{
    key: StatKey;
    label: string;
    hint: string;
    count: number;
    amount: string;
    onOpen: () => void;
  }>;
  statements: {
    suppliers: number;
    clients: number;
    onSuppliers: () => void;
    onClients: () => void;
    onContactTodo: () => void;
  };
  onOpen: (key: ListKey) => void;
  /** The lime row's own action: open the review dialog for the whole list. */
  onSend?: (key: ListKey) => void;
  onOpenNoPo: () => void;
  gmail: { connected?: boolean; email?: string | null } | undefined;
  scanning: boolean;
  onScan: () => void;
}) {
  const share = (value: number) =>
    portfolio.total > 0 ? `${Math.max((value / portfolio.total) * 100, 0)}%` : "0%";
  const segments = [
    { value: portfolio.toCollect, fill: "bg-paper-ink" },
    { value: portfolio.toPartners, fill: "bg-paper-faint" },
    { value: portfolio.notInvoiced, fill: "bg-paper-rule-strong" },
    { value: portfolio.overdue, fill: "bg-paper-alert" },
  ];
  const composition = [
    { label: "Client to collect", value: portfolio.toCollect, alert: false },
    { label: "Owed to partners", value: portfolio.toPartners, alert: false },
    { label: "Not yet invoiced", value: portfolio.notInvoiced, alert: false },
    { label: "Overdue", value: portfolio.overdue, alert: true },
  ];

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto bg-paper-canvas font-paper text-paper-ink lg:grid-cols-[1fr_380px]">
      <div className="border-paper-rule px-10 pb-10 pt-11 lg:border-r">
        <SectionLabel>L'Oréal Canada · portfolio in flight</SectionLabel>
        <div className="mt-[18px] flex items-end gap-[18px] whitespace-nowrap">
          <span className="font-paper-display text-[84px] leading-[0.9] tracking-[-0.02em] tabular-nums">
            {isLoading ? "…" : fmtPaper(portfolio.total)}
          </span>
          <span className="pb-2 font-paper-display text-[22px] text-paper-muted">$CA</span>
        </div>
        <p className="mt-3.5 max-w-[640px] text-[14px] leading-relaxed text-paper-body [text-wrap:pretty]">
          {isLoading
            ? "Loading data from BigQuery…"
            : `Across ${totalEvents} ${eventsLabel(portfolio)}`}
        </p>

        <div className="mt-8 flex h-[6px] border border-paper-rule-strong">
          {segments.map((s, i) => (
            <span key={i} className={s.fill} style={{ width: share(s.value) }} />
          ))}
        </div>
        <div className="mt-px grid grid-cols-2 gap-px md:grid-cols-4">
          {composition.map((f) => (
            <div key={f.label} className="pt-3.5">
              <div
                className={`text-[10.5px] uppercase tracking-[0.16em] ${
                  f.alert ? "text-paper-alert" : "text-paper-label"
                }`}
              >
                {f.label}
              </div>
              <div
                className={`mt-1.5 text-[19px] tabular-nums ${f.alert ? "text-paper-alert" : ""}`}
              >
                {isLoading ? "…" : fmtPaper(f.value)}
              </div>
            </div>
          ))}
        </div>

        {/* The six figures the finance team asks for, each one opening the
            events behind it — a total that cannot be taken apart is a claim,
            not a figure. */}
        <div className="mt-11 flex items-baseline gap-3">
          <span className="font-paper-display text-[26px]">Where the money is</span>
          <span className="text-[12.5px] text-paper-label">
            six figures — open one to see the events behind it
          </span>
        </div>
        <div className="mt-4 grid grid-cols-1 border-t border-paper-rule sm:grid-cols-2 lg:grid-cols-3">
          {figures.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={f.onOpen}
              className="border-b border-paper-hairline py-3.5 pr-6 text-left hover:bg-paper-row"
            >
              <span className="block text-[10.5px] uppercase tracking-[0.16em] text-paper-label">
                {f.label} <span className="font-paper-mono tracking-normal">{f.count}</span>
              </span>
              <span className="mt-1.5 block text-[19px] tabular-nums">
                {isLoading ? "…" : f.amount}
              </span>
              <span className="mt-1 block text-[11.5px] text-paper-label">{f.hint}</span>
            </button>
          ))}
        </div>

        <div className="mt-12 flex items-baseline gap-3">
          <span className="font-paper-display text-[26px]">What needs a move</span>
          <span className="text-[12.5px] text-paper-label">
            {lists.filter((l) => l.events > 0).length} list
            {lists.filter((l) => l.events > 0).length === 1 ? "" : "s"}, one per action — open one
            and clear it
          </span>
        </div>

        <div className="mt-5">
          {lists.map((list, i) => {
            const empty = list.events === 0;
            // The row opens the list; the lime button on the one sending list
            // opens the review dialog for the whole list, as the design has it.
            const sends = list.meta.primary && onSend != null && !empty;
            return (
              <div
                key={list.key}
                className={`flex w-full items-center gap-6 border-t border-paper-rule ${
                  i === lists.length - 1 ? "border-b" : ""
                } ${empty ? "opacity-45" : "hover:bg-paper-row"}`}
              >
                <button
                  type="button"
                  disabled={empty}
                  onClick={() => onOpen(list.key)}
                  className="flex min-w-0 flex-1 items-center gap-6 py-[22px] text-left"
                >
                  <span className="w-[26px] flex-none font-paper-mono text-[13px] text-paper-label">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[19px] leading-[1.35]">
                      {empty ? `Nothing to ${LIST_META[list.key].name.toLowerCase()}` : list.title}
                    </span>
                    <span className="mt-[5px] block text-[12.5px] text-paper-muted">
                      {list.detail}
                    </span>
                  </span>
                  <span className="w-[150px] flex-none text-right">
                    <span className="block text-[17px] tabular-nums">
                      {list.byCcy.size === 0 ? "—" : fmtMulti(list.byCcy)}
                    </span>
                    <span className="mt-[3px] block text-[11px] uppercase tracking-[0.14em] text-paper-label">
                      {list.meta.unit}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  disabled={empty}
                  onClick={() => (sends ? onSend(list.key) : onOpen(list.key))}
                  className={`my-[22px] inline-flex h-[34px] flex-none items-center justify-center px-4 text-[13px] ${
                    empty
                      ? "text-paper-faint"
                      : list.meta.primary
                        ? "bg-naboo text-paper-ink hover:bg-naboo-hover"
                        : list.meta.quiet
                          ? "text-paper-body"
                          : "border border-paper-ink hover:bg-paper-canvas"
                  }`}
                >
                  {sends
                    ? `Review & send ${list.units}`
                    : list.meta.primary
                      ? "Review & send"
                      : "Open list"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <aside className="px-8 pb-10 pt-11">
        <div className="text-[10.5px] uppercase tracking-[0.2em] text-paper-label">
          Blocked elsewhere
        </div>
        <p className="mt-[18px] text-[14px] leading-relaxed text-paper-body">
          {noPoCount === 0
            ? "Every event has a purchase order."
            : `${noPoCount} event${noPoCount === 1 ? " has" : "s have"} no purchase order yet. Nothing can be invoiced or paid until L'Oréal issues one.`}
        </p>
        {noPoCount > 0 && (
          <button
            type="button"
            onClick={onOpenNoPo}
            className="mt-3.5 inline-block border-b border-paper-ink pb-0.5 text-[13px]"
          >
            See the {noPoCount} event{noPoCount === 1 ? "" : "s"}
          </button>
        )}

        <RailBlock title="SLA, last 90 days">
          <RailRows rows={sla} />
        </RailBlock>

        <div className="mt-9 border-t border-paper-rule pt-6 text-[10.5px] uppercase tracking-[0.2em] text-paper-label">
          Account statements
        </div>
        <p className="mt-3.5 text-[13px] leading-relaxed text-paper-body">
          One statement per supplier per event, and one per client per event. Download them on the
          event, or take the whole filtered set — {totalEvents} event
          {totalEvents === 1 ? "" : "s"}, {statements.suppliers + statements.clients} statements.
        </p>
        <div className="mt-3.5 flex flex-col gap-2">
          <button
            type="button"
            disabled={statements.suppliers === 0}
            onClick={statements.onSuppliers}
            className="flex h-9 items-center gap-2.5 border border-paper-ink px-3 text-[13px] disabled:border-paper-rule-strong disabled:text-paper-faint"
          >
            <Download className="h-3.5 w-3.5 flex-none" strokeWidth={1.6} aria-hidden="true" />
            All supplier statements
            <span className="ml-auto font-paper-mono text-[11px] text-paper-label">
              {statements.suppliers} · zip
            </span>
          </button>
          <button
            type="button"
            disabled={statements.clients === 0}
            onClick={statements.onClients}
            className="flex h-9 items-center gap-2.5 border border-paper-ink px-3 text-[13px] disabled:border-paper-rule-strong disabled:text-paper-faint"
          >
            <Download className="h-3.5 w-3.5 flex-none" strokeWidth={1.6} aria-hidden="true" />
            All client statements
            <span className="ml-auto font-paper-mono text-[11px] text-paper-label">
              {statements.clients} · zip
            </span>
          </button>
          <button
            type="button"
            onClick={statements.onContactTodo}
            className="flex h-9 items-center gap-2.5 border border-paper-rule-strong px-3 text-[13px] text-paper-body"
          >
            <Download className="h-3.5 w-3.5 flex-none" strokeWidth={1.6} aria-hidden="true" />
            Unpaid partners · contact to-do
          </button>
        </div>

        <div className="mt-9 border-t border-paper-rule pt-6 text-[10.5px] uppercase tracking-[0.2em] text-paper-label">
          Mailbox
        </div>
        <p className="mt-4 text-[13.5px] leading-relaxed text-paper-body">
          {gmail?.connected
            ? `Gmail connected as ${gmail.email ?? "your account"}.`
            : "Gmail is not connected, so email history and sending are unavailable."}
        </p>
        {gmail?.connected && (
          <button
            type="button"
            disabled={scanning}
            onClick={onScan}
            className="mt-3 inline-block border-b border-paper-ink pb-0.5 text-[13px] disabled:border-paper-rule-strong disabled:text-paper-faint"
          >
            {scanning ? "Scanning…" : "Scan again"}
          </button>
        )}
      </aside>
    </div>
  );
}

/** "34 open events. 12 need a move; 3 have breached an SLA." */
function eventsLabel(p: { needsMove: number; breached: number }): string {
  const move = `${p.needsMove} ${p.needsMove === 1 ? "is" : "are"} waiting on something we can do today`;
  const breach =
    p.breached === 0
      ? "nothing has breached an SLA"
      : `${p.breached} ${p.breached === 1 ? "has" : "have"} already breached an SLA`;
  return `open events. ${move}; ${breach}.`;
}
