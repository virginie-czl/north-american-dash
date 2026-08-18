import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState, useEffect, Fragment } from "react";
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

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TagFilterSelect } from "@/components/tag-filter-select";
import {
  GROUP_META,
  GROUP_ORDER,
  MOVE_PILL,
  isRecover,
  needsAMove,
  type Move,
  type MoveGroup,
} from "@/lib/tracker-move";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SummaryStrip, useRegisterTrackerActions } from "@/components/tracker-chrome";
import { PartnerEmails } from "@/components/partner-emails";
import { PartnerInvoicePdfs } from "@/components/partner-invoice-pdfs";
import { EventStickers, PartnerStickers } from "@/components/partner-fact-stickers";
import { RequestInfoDialog, useRequestDialog } from "@/components/request-info-dialog";
import { buildTargets, describeNeeds, needsOf } from "@/lib/partner-requests";
import { UserAvatar } from "@/components/user-avatar";
import { useActionIndex, tagsForEvent, TAG_FILTER_GROUPS } from "@/lib/use-partner-actions";
import { useFactScan, useGmailConnection, usePartnerFacts } from "@/lib/use-gmail";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import {
  Mail,
  AlertTriangle,
  Clock,
  CheckCircle2,
  Receipt,
  Users,
  Wallet,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  FileText,
  Truck,
  BadgeDollarSign,
  TrendingUp,
  ExternalLink,
  Search,
  SearchX,
  Send,
  SlidersHorizontal,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/")({
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

function PaymentBadge({ status }: { status: ReturnType<typeof paymentStatus> }) {
  const map: Record<string, string> = {
    paid: "bg-emerald-100 text-emerald-800",
    partial: "bg-sky-100 text-sky-800",
    due: "bg-violet-100 text-violet-800",
    overdue: "bg-rose-100 text-rose-800",
    muted: "bg-slate-100 text-slate-600",
  };
  return <span className={`pill ${map[status.variant]}`}>{status.label}</span>;
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
    primary: true,
  },
  pay: {
    name: "Pay partners",
    title: (n) => `Pay ${n} partner${n === 1 ? "" : "s"} whose PO has landed`,
    detail: () => "Everything needed is on file · payout is due 24h after the PO",
    unit: "to pay out",
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
  },
  chase: {
    name: "Chase clients",
    title: (n) => `Chase ${n} overdue client invoice${n === 1 ? "" : "s"}`,
    detail: () => "Payment terms are 60 days from the day the invoice was sent",
    unit: "overdue",
  },
  waiting: {
    name: "Waiting",
    title: (n) => `Wait on ${n} partner repl${n === 1 ? "y" : "ies"}`,
    detail: () => "Nothing to do until they answer",
    unit: "on hold",
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

function CommentersChip({ summary }: { summary: EventCommentSummary | undefined }) {
  if (!summary || summary.count === 0) return null;
  const shown = summary.commenters.slice(0, 3);
  const extra = summary.commenters.length - shown.length;
  return (
    <span
      className="ml-2 inline-flex items-center gap-1.5 align-middle"
      title={`${summary.count} comment${summary.count > 1 ? "s" : ""} from ${summary.commenters
        .map((c) => c.user_name || c.user_email)
        .join(", ")}`}
    >
      <span className="flex -space-x-2">
        {shown.map((c) => (
          <UserAvatar
            key={c.user_id}
            name={c.user_name}
            email={c.user_email}
            picture={c.user_avatar_url}
            className="h-7 w-7 border-2 border-white shadow-sm"
            fallbackClassName="bg-slate-300 text-slate-700"
          />
        ))}
        {extra > 0 && (
          <span className="flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-white bg-slate-200 px-1.5 text-[11px] font-semibold text-slate-700 shadow-sm">
            +{extra}
          </span>
        )}
      </span>
      <span className="text-xs font-semibold text-slate-700">{summary.count}</span>
    </span>
  );
}

function SlaPage() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["sla-rows"],
    queryFn: () => getSlaRows(),
    staleTime: 60_000,
  });

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [invoiceFilter, setInvoiceFilter] = useState<InvoiceStatus | "all">("all");
  // Turnkey is out by default (Naboo runs those end to end) but can be brought back.
  const [kindFilter, setKindFilter] = useState<string>("no_turnkey");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [scope, setScope] = useState<"move" | "to_pay" | "breached" | "all">("move");
  // Which action list is open, or the overview. The redesign lands on the
  // overview and every list is one click from it.
  const [activeList, setActiveList] = useState<ListKey | null>(null);
  // A headline figure the user clicked, narrowing the list to its own events.
  const [statFilter, setStatFilter] = useState<StatKey | null>(null);
  const [sortKey, setSortKey] = useState<string>("booking_created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const setCol = (k: string, v: string) =>
    setColFilters((prev) => {
      const next = { ...prev };
      if (!v || v === "all") delete next[k];
      else next[k] = v;
      return next;
    });

  const rawRows = data ?? [];
  const poDates = usePoEmissionDates(rawRows);
  const { data: statusMap } = usePartnerStatuses();
  const { data: commentSummaries } = useCommentSummaries();
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

  const pickStat = (key: StatKey) => {
    setStatFilter((prev) => (prev === key ? null : key));
    // The move groups would hide most of what the figure just counted.
    setScope("all");
  };

  // KPIs
  const kpis = useMemo(() => {
    const total = rows.length;
    const invoiceSent = decorated.filter(
      ({ invoices: iv }) => invoiceStatusOf(iv) === "issued_sent",
    ).length;
    const invoiceIssuedNotSent = decorated.filter(
      ({ invoices: iv }) => invoiceStatusOf(iv) === "issued_not_sent",
    ).length;
    const notInvoiced = total - invoiceSent - invoiceIssuedNotSent;
    const overdueReceivables = decorated.filter(
      ({ row: r, invoices: iv }) => paymentStatus(r, iv).variant === "overdue",
    ).length;

    // Partner outstanding: split into buckets by PO presence, partner naming,
    // and outreach status (not contacted vs waiting bank details).
    const partnerBuckets = {
      toContact: new Map<string, number>(), // PO + named partner, not contacted yet
      waitingBank: new Map<string, number>(), // PO + named partner, already contacted
      withPoNoName: new Map<string, number>(), // PO + partner has no name
      noPo: new Map<string, number>(), // no PO
    };
    const partnerCounts = { toContact: 0, waitingBank: 0, withPoNoName: 0, noPo: 0 };
    decorated.forEach(({ row, partners }) => {
      const hasPo = !!(row.purchase_order_number && String(row.purchase_order_number).trim());
      const flags = { toContact: false, waitingBank: false, withPoNoName: false, noPo: false };
      partners.forEach((p) => {
        if (p.is_cancelled) return;
        const due = Math.max(p.amount_due ?? 0, 0);
        const paid = Math.abs(p.amount_paid ?? 0);
        const remaining = Math.max(due - paid, 0);
        if (remaining <= 0.01) return;
        const ccy = p.currency || "EUR";
        const hasName = !!(p.name && p.name.trim());
        let bucket: keyof typeof partnerBuckets;
        if (!hasPo) bucket = "noPo";
        else if (!hasName) bucket = "withPoNoName";
        else {
          const k = `${row.readable_id ?? row.client_request_id ?? ""}::${partnerKey(p.name)}`;
          const status = statusMap?.get(k)?.status ?? "not_contacted";
          bucket = status === "not_contacted" ? "toContact" : "waitingBank";
        }
        partnerBuckets[bucket].set(ccy, (partnerBuckets[bucket].get(ccy) ?? 0) + remaining);
        flags[bucket] = true;
      });
      (Object.keys(flags) as Array<keyof typeof flags>).forEach((k) => {
        if (flags[k]) partnerCounts[k]++;
      });
    });
    const partnerByCcy = new Map<string, number>();
    [
      partnerBuckets.toContact,
      partnerBuckets.waitingBank,
      partnerBuckets.withPoNoName,
      partnerBuckets.noPo,
    ].forEach((m) => m.forEach((v, k) => partnerByCcy.set(k, (partnerByCcy.get(k) ?? 0) + v)));
    const partnerOutstandingCount =
      partnerCounts.toContact +
      partnerCounts.waitingBank +
      partnerCounts.withPoNoName +
      partnerCounts.noPo;

    // Client outstanding: split per event by PO + named partner presence,
    // and within PO+partner by invoice status (sent vs issued-not-sent vs not invoiced).
    const clientBuckets = {
      invoiceSent: new Map<string, number>(),
      invoiceIssuedNotSent: new Map<string, number>(),
      notInvoiced: new Map<string, number>(),
      withPoNoPartner: new Map<string, number>(),
      noPo: new Map<string, number>(),
    };
    const clientCounts = {
      invoiceSent: 0,
      invoiceIssuedNotSent: 0,
      notInvoiced: 0,
      withPoNoPartner: 0,
      noPo: 0,
    };
    decorated.forEach(({ row, partners, invoices }) => {
      const v = row.client_reste_a_encaisser_ttc ?? 0;
      if (v <= 0.01) return;
      const ccy = row.currency || "EUR";
      const hasPo = !!(row.purchase_order_number && String(row.purchase_order_number).trim());
      const hasNamedPartner = partners.some((p) => !p.is_cancelled && p.name && p.name.trim());
      let bucket: keyof typeof clientBuckets;
      if (!hasPo) bucket = "noPo";
      else if (!hasNamedPartner) bucket = "withPoNoPartner";
      else {
        const status = invoiceStatusOf(invoices);
        bucket =
          status === "not_issued"
            ? "notInvoiced"
            : status === "issued_sent"
              ? "invoiceSent"
              : "invoiceIssuedNotSent";
      }
      clientBuckets[bucket].set(ccy, (clientBuckets[bucket].get(ccy) ?? 0) + v);
      clientCounts[bucket]++;
    });
    const clientByCcy = new Map<string, number>();
    Object.values(clientBuckets).forEach((m) =>
      m.forEach((v, k) => clientByCcy.set(k, (clientByCcy.get(k) ?? 0) + v)),
    );

    // Already collected from clients & service fees generated (invoiced - partner net).
    const collectedByCcy = new Map<string, number>();
    const serviceFeesByCcy = new Map<string, number>();
    decorated.forEach(({ row }) => {
      const ccy = row.currency || "EUR";
      const collected = row.client_collected_total ?? 0;
      if (collected) collectedByCcy.set(ccy, (collectedByCcy.get(ccy) ?? 0) + collected);
      const fee = (row.client_invoiced_ttc ?? 0) - (row.partner_net_a_payer_ttc ?? 0);
      if (fee) serviceFeesByCcy.set(ccy, (serviceFeesByCcy.get(ccy) ?? 0) + fee);
    });

    const avgDaysToInvoice = (() => {
      const vals = rows
        .map((r) => r.days_booking_to_first_emission)
        .filter((v): v is number => typeof v === "number");
      if (!vals.length) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    })();
    return {
      total,
      invoiceSent,
      invoiceIssuedNotSent,
      notInvoiced,
      overdueReceivables,
      partnerOutstandingCount,
      partnerByCcy,
      partnerBuckets,
      partnerCounts,
      clientByCcy,
      clientBuckets,
      clientCounts,
      collectedByCcy,
      serviceFeesByCcy,
      avgDaysToInvoice,
    };
  }, [rows, decorated, statusMap]);

  const fmtMultiCcy = (m: Map<string, number>) => {
    if (m.size === 0) return fmtCurrency(0, "EUR");
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([ccy, v]) => fmtCurrency(v, ccy))
      .join(" · ");
  };

  // Per-event partner payout breakdown (fully/partial/not paid).
  const partnerBreakdown = (partners: PartnerLine[]) => {
    let fully = 0,
      partial = 0,
      notPaid = 0;
    partners.forEach((p) => {
      if (p.is_cancelled) return;
      const due = Math.max(p.amount_due ?? 0, 0);
      const paid = Math.abs(p.amount_paid ?? 0);
      if (due <= 0.01 && paid <= 0.01) return;
      if (due <= 0.01) {
        fully++;
        return;
      }
      if (paid > 0.01 && paid + 0.01 >= due) fully++;
      else if (paid > 0.01) partial++;
      else notPaid++;
    });
    return { fully, partial, notPaid };
  };

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

  const byInvoicingStatus = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r) => {
      const k = r.invoicing_sla_status || "UNKNOWN";
      m.set(k, (m.get(k) ?? 0) + 1);
    });
    return Array.from(m, ([name, value]) => ({ name, value }));
  }, [rows]);

  const byEventType = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r) => {
      const k = (r.event_type || "UNKNOWN").replaceAll("_", " ");
      m.set(k, (m.get(k) ?? 0) + 1);
    });
    return Array.from(m, ([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [rows]);

  const PIE_COLORS = ["#10b981", "#f59e0b", "#ef4444", "#6366f1", "#06b6d4", "#a855f7", "#64748b"];

  const breached = filtered.filter(
    ({ row: r, partners: ps, invoices: iv }) =>
      paymentStatus(r, iv).variant === "overdue" ||
      payoutSla(r, ps).variant === "overdue" ||
      invoicingSla(r, iv).variant === "overdue",
  );

  const toggle = (id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] }));
  const expandAll = () => {
    const all: Record<string, boolean> = {};
    filtered.forEach((x) => {
      const id = x.row.client_request_id ?? x.row.readable_id ?? "";
      if (id) all[id] = true;
    });
    setExpanded(all);
  };
  const collapseAll = () => setExpanded({});

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
    },
    [isFetching, isLoading, decorated.length],
  );

  // ── Split view ────────────────────────────────────────────────────────────
  // Presentation only: every figure, tag and email action below comes from the
  // same hooks and helpers as before. The list groups rows by the outreach state
  // that partnerOutreach already computes; nothing is recomputed here.
  // The shared move model, L'Oreal flavour. Same precedence as Marketplace NA —
  // blocked → ours → partner → waiting → client → done — expressed against this
  // page's own signals (PO presence, the two SLAs, the outreach state).
  const moveFor = useCallback(
    (r: SlaRow, ps: PartnerLine[], iv: InvoiceLine[]): Move => {
      const ref = r.readable_id ?? r.client_request_id ?? "";
      const owed = r.partner_reste_a_decaisser_ttc ?? 0;
      const clientOut = r.client_reste_a_encaisser_ttc ?? 0;
      const money = (v: number) => fmtCurrency(v, r.currency);

      if (!r.purchase_order_number) {
        return {
          group: "blocked",
          label: "Blocked — no PO",
          headline: owed > 0.01 ? money(owed) : "—",
          headlineLabel: "not invoiced",
        };
      }

      const out = partnerOutreach(ps, ref, true);
      const label = out?.label ?? "";

      if (owed > 0.01 && label.includes("Payout")) {
        return {
          group: "ours",
          label: "Pay the partner",
          headline: money(owed),
          headlineLabel: "partner to pay",
        };
      }
      if (label.includes("Contact TBD")) {
        return {
          group: "partner",
          label: "Ask for details",
          headline: owed > 0.01 ? money(owed) : "—",
          headlineLabel: "partner to pay",
        };
      }
      if (label.includes("Contact")) {
        return {
          group: "waiting",
          label: "Waiting on a reply",
          headline: owed > 0.01 ? money(owed) : "—",
          headlineLabel: "partner to pay",
        };
      }
      if (clientOut > 0.01) {
        return {
          group: "client",
          label: "Client to pay",
          headline: money(clientOut),
          headlineLabel: "client outstanding",
        };
      }
      return {
        group: "done",
        label: "Nothing to do",
        headline: "—",
        headlineLabel: "settled",
      };
    },
    [statusMap, factsMap],
  );

  /** Either SLA breached — drives the scope chip and the extra list pill. */
  const breachOf = useCallback((r: SlaRow, ps: PartnerLine[], iv: InvoiceLine[]): string | null => {
    const inv = invoicingSla(r, iv);
    if (inv.variant === "overdue") return inv.label;
    const po = payoutSla(r, ps);
    if (po.variant === "overdue") return po.label;
    const pay = paymentStatus(r, iv);
    if (pay.variant === "overdue") return pay.label;
    return null;
  }, []);

  const withMove = useMemo(
    () =>
      filtered.map((item) => ({
        ...item,
        move: moveFor(item.row, item.partners, item.invoices),
        breach: breachOf(item.row, item.partners, item.invoices),
        // Only a PO makes a provider payable, so an event without one has
        // nobody to pay yet however much it still owes.
        toPay: hasPurchaseOrder(item.row) ? unpaidPartners(item.partners) : [],
      })),
    [filtered, moveFor, breachOf],
  );

  const scoped = useMemo(() => {
    const stat = statFilter ? STATS.find((s) => s.key === statFilter) : null;
    let base = stat ? withMove.filter((x) => stat.test(x)) : withMove;
    if (activeList) {
      const inList = new Set(
        listed.filter(({ lists }) => lists.keys.has(activeList)).map(({ item }) => item.row),
      );
      base = base.filter((x) => inList.has(x.row));
    }
    if (scope === "breached") return base.filter((x) => x.breach != null);
    if (scope === "to_pay") return base.filter((x) => x.toPay.length > 0);
    if (scope === "move") return base.filter((x) => needsAMove(x.move.group));
    return base;
  }, [withMove, scope, statFilter, activeList, listed]);

  const scopeCounts = useMemo(
    () => ({
      move: withMove.filter((x) => needsAMove(x.move.group)).length,
      toPay: withMove.filter((x) => x.toPay.length > 0).length,
      breached: withMove.filter((x) => x.breach != null).length,
      all: withMove.length,
    }),
    [withMove],
  );

  const groups = useMemo(() => {
    const byGroup = new Map<MoveGroup, typeof scoped>();
    for (const item of scoped) {
      const list = byGroup.get(item.move.group) ?? [];
      list.push(item);
      byGroup.set(item.move.group, list);
    }
    return GROUP_ORDER.filter((g) => (byGroup.get(g)?.length ?? 0) > 0).map((g) => ({
      key: g,
      title: g === "blocked" ? "Blocked — no PO" : GROUP_META[g].title,
      dot: GROUP_META[g].dot,
      rows: byGroup.get(g)!,
    }));
  }, [scoped]);

  const selected = useMemo(() => {
    if (scoped.length === 0) return null;
    const hit = scoped.find(
      (x) => (x.row.client_request_id ?? x.row.readable_id ?? "") === selectedId,
    );
    return hit ?? scoped[0];
  }, [scoped, selectedId]);

  const sel = selected?.row ?? null;
  const selPartners = selected?.partners ?? [];
  const selInvoices = selected?.invoices ?? [];
  const selRef = sel ? (sel.readable_id ?? sel.client_request_id ?? "") : "";

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

      {/* ── Overview ──────────────────────────────────────────────────────
          Land, see the size of the portfolio, pick a list to clear. */}
      {activeList === null ? (
        <OverviewScreen
          portfolio={portfolio}
          lists={actionLists}
          isLoading={isLoading}
          totalEvents={listed.length}
          noPoCount={listed.filter(({ item }) => !hasPurchaseOrder(item.row)).length}
          onOpen={(key) => {
            setActiveList(key);
            setScope("all");
            setStatFilter(null);
          }}
          onOpenNoPo={() => {
            setActiveList(null);
            setScope("all");
            setStatFilter("invoices_no_po");
          }}
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
      ) : (
        <>
          <div className="flex flex-none items-center gap-3 border-b border-paper-rule bg-paper-canvas px-8 py-3.5 font-paper text-[13px]">
            <button
              type="button"
              onClick={() => setActiveList(null)}
              className="text-paper-label underline-offset-[3px] hover:underline"
            >
              Overview
            </button>
            <span className="text-paper-faint">/</span>
            <span className="text-paper-ink">{LIST_META[activeList].name}</span>
            <span className="ml-auto flex flex-wrap items-center gap-5 text-[12.5px]">
              {actionLists
                .filter((l) => l.key !== activeList && l.events > 0)
                .map((l) => (
                  <button
                    key={l.key}
                    type="button"
                    onClick={() => setActiveList(l.key)}
                    className="text-paper-body underline-offset-[3px] hover:underline"
                  >
                    {l.meta.name}{" "}
                    <span className="font-paper-mono text-[11.5px] text-paper-label">
                      {l.units}
                    </span>
                  </button>
                ))}
            </span>
          </div>

          {/* ── Headline figures ──────────────────────────────────────────────
          Each one opens its own events in the list, so a number can always be
          taken apart into the events behind it. */}
          <div className="flex-none border-b border-border bg-[#fafaf8] px-4 py-2.5">
            <div className="flex flex-wrap items-stretch gap-1.5">
              {STATS.map((stat, i) => {
                const totals = statTotals.get(stat.key);
                const active = statFilter === stat.key;
                const previous = STATS[i - 1];
                return (
                  <Fragment key={stat.key}>
                    {previous && previous.band !== stat.band && (
                      <span
                        className="mx-1 w-px flex-none self-stretch bg-border"
                        aria-hidden="true"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => pickStat(stat.key)}
                      aria-pressed={active}
                      title={`${stat.hint} — click to list them`}
                      className={`min-w-[132px] flex-1 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                        active
                          ? "border-navy bg-white shadow-[0_0_0_1px_#101f34]"
                          : "border-border bg-white hover:border-navy"
                      }`}
                    >
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-[9.5px] font-bold uppercase tracking-[0.07em] text-slate-500">
                          {stat.label}
                        </span>
                        <span className="text-[10.5px] font-semibold text-slate-400">
                          {isLoading ? "" : totals ? totals.count : 0}
                        </span>
                      </span>
                      <span className="mt-0.5 block cell-mono truncate text-[13px] font-semibold">
                        {isLoading ? "…" : fmtMulti(totals?.byCcy ?? new Map())}
                      </span>
                    </button>
                  </Fragment>
                );
              })}
            </div>
            {statFilter && (
              <button
                type="button"
                onClick={() => setStatFilter(null)}
                className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-navy px-2.5 py-[3px] text-[11.5px] font-semibold text-white"
              >
                {STATS.find((s) => s.key === statFilter)?.label} only — clear
                <span aria-hidden="true">×</span>
              </button>
            )}
          </div>

          <div className="flex min-h-0 flex-1 overflow-x-auto">
            {/* ── List column ───────────────────────────────────────────────── */}
            <div className="flex w-[470px] flex-none flex-col border-r border-border bg-white">
              <div className="flex-none border-b border-border px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 flex-1 items-center gap-2 rounded-md border border-input bg-white px-2.5">
                    <Search className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search ref, event, partner, invoice…"
                      aria-label="Search"
                      className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] outline-none"
                    />
                  </span>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[12px]">
                        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                        Filters
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-[320px] space-y-2.5">
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
                      <TagFilterSelect
                        groups={TAG_FILTER_GROUPS}
                        selected={tagFilter}
                        onChange={setTagFilter}
                      />
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
                </div>

                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      { key: "move" as const, label: "Needs a move", count: scopeCounts.move },
                      {
                        key: "to_pay" as const,
                        label: "Partners to pay",
                        count: scopeCounts.toPay,
                      },
                      { key: "breached" as const, label: "Breached", count: scopeCounts.breached },
                      { key: "all" as const, label: "All", count: scopeCounts.all },
                    ] as const
                  ).map((s) => {
                    const active = scope === s.key;
                    return (
                      <button
                        key={s.key}
                        type="button"
                        onClick={() => setScope(s.key)}
                        className={`inline-flex h-[26px] items-center rounded-full px-2.5 text-[11.5px] ${
                          active
                            ? "bg-navy font-semibold text-white"
                            : "bg-[#F3F4F6] font-medium text-[#4B5563]"
                        }`}
                      >
                        {s.label} {s.count}
                      </button>
                    );
                  })}
                  {gmailConnection?.connected && incompleteTargets.length > 0 && (
                    <button
                      type="button"
                      onClick={() => requestDialog.open(incompleteTargets)}
                      className="rounded-full bg-naboo px-2.5 py-[3px] text-[11.5px] font-semibold text-navy"
                    >
                      Demander les infos ({incompleteTargets.length})
                    </button>
                  )}
                  {gmailConnection?.connected && (
                    <button
                      type="button"
                      disabled={scanProgress.running}
                      onClick={() =>
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
                      className="rounded-full border border-border px-2.5 py-[3px] text-[11.5px] text-slate-600 disabled:opacity-50"
                    >
                      {scanProgress.running ? "Recherche…" : "Scanner mes emails"}
                    </button>
                  )}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto">
                {isLoading && (
                  <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                    Loading data from BigQuery…
                  </p>
                )}
                {!isLoading && scoped.length === 0 && (
                  <div className="flex flex-col items-center gap-2.5 px-12 py-16 text-center">
                    <SearchX className="h-6 w-6 text-slate-400" aria-hidden="true" />
                    <span className="font-display text-base font-bold">
                      {search ? `Nothing matches “${search}”` : "Nothing to show"}
                    </span>
                    <span className="text-[12.5px] leading-relaxed text-slate-600">
                      Search covers event refs, event types, partner names and invoice refs.
                    </span>
                    {search && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={() => setSearch("")}
                      >
                        Clear the search
                      </Button>
                    )}
                  </div>
                )}
                {!isLoading &&
                  groups.map((g) => (
                    <Fragment key={g.key}>
                      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-slate-100 bg-[#fafaf8] px-4 py-2">
                        <span
                          className="h-[7px] w-[7px] flex-none rounded-full"
                          style={{ background: g.dot }}
                        />
                        <span className="text-[11px] font-bold uppercase tracking-[0.07em] text-slate-600">
                          {g.title}
                        </span>
                        <span className="text-[11px] text-slate-400">{g.rows.length}</span>
                      </div>
                      {g.rows.map((item) => {
                        const r = item.row;
                        const id = r.client_request_id ?? r.readable_id ?? "";
                        const ref = r.readable_id ?? id;
                        const isSel = selRef === ref;
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => setSelectedId(id)}
                            className={`flex w-full gap-2.5 border-b border-slate-100 px-4 py-2.5 text-left ${
                              isSel ? "bg-[#fafaf8]" : "hover:bg-[#fafaf8]"
                            }`}
                            style={{ borderLeft: `3px solid ${isSel ? "#101f34" : "transparent"}` }}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-[13px] font-medium">
                                  {(r.event_type || "—").replaceAll("_", " ").toLowerCase()}
                                </span>
                                <span className="cell-mono flex-none text-[10.5px] text-slate-400">
                                  {ref}
                                </span>
                              </span>
                              <span className="mt-0.5 block text-[11.5px] text-slate-500">
                                {r.country_iso_code ?? "—"} · {r.billing_entity ?? "—"} ·{" "}
                                {item.partners.length} partner
                                {item.partners.length === 1 ? "" : "s"}
                              </span>
                              {/* Who is actually owed money — the PO is in, these are not paid. */}
                              {item.toPay.length > 0 && (
                                <span className="mt-0.5 block truncate text-[11.5px] text-slate-700">
                                  To pay:{" "}
                                  {item.toPay
                                    .slice(0, 2)
                                    .map(
                                      ({ partner, remaining }) =>
                                        `${partnerLabel(partner)} ${fmtCurrency(
                                          remaining,
                                          partner.currency ?? r.currency,
                                        )}`,
                                    )
                                    .join(" · ")}
                                  {item.toPay.length > 2 ? ` · +${item.toPay.length - 2}` : ""}
                                </span>
                              )}
                              <span className="mt-[5px] flex flex-wrap gap-1">
                                <span
                                  className={`rounded-full px-2 py-[2px] text-[10.5px] font-semibold ${
                                    MOVE_PILL[item.move.group]
                                  }`}
                                >
                                  {item.move.label}
                                </span>
                                {item.breach && (
                                  <span className="rounded-full bg-[#FEE2E2] px-2 py-[2px] text-[10.5px] font-semibold text-[#991B1B]">
                                    {item.breach}
                                  </span>
                                )}
                              </span>
                            </span>
                            <span className="flex-none whitespace-nowrap text-right">
                              <span className="block cell-mono text-[13px] font-semibold">
                                {item.move.headline}
                              </span>
                              <span className="block text-[10.5px] text-slate-400">
                                {item.move.headlineLabel}
                              </span>
                              <span className="mt-1.5 block text-[10.5px] text-slate-400">
                                {fmtDate(r.booking_date)}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </Fragment>
                  ))}
              </div>
            </div>

            {/* ── Detail pane ───────────────────────────────────────────────── */}
            <div className="flex min-w-[780px] flex-1 flex-col bg-[#fafaf8]">
              {sel == null ? (
                <div className="flex flex-1 items-center justify-center px-10 text-center">
                  <span className="text-sm text-slate-500">
                    Select an event on the left to see its detail.
                  </span>
                </div>
              ) : (
                <>
                  <div className="flex-none border-b border-border bg-white px-6 pb-3.5 pt-4">
                    <div className="flex items-start gap-3.5">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2.5">
                          <h1 className="font-display text-2xl font-bold tracking-tight">
                            {(sel.event_type || "—").replaceAll("_", " ").toLowerCase()}
                          </h1>
                          {sel.booking_url ? (
                            <a
                              href={sel.booking_url}
                              target="_blank"
                              rel="noreferrer"
                              className="cell-mono border-b border-dotted border-slate-400 text-[12.5px] no-underline"
                            >
                              {selRef}
                            </a>
                          ) : (
                            <span className="cell-mono text-[12.5px]">{selRef}</span>
                          )}
                          <span
                            className={`pill ${
                              sel.purchase_order_number
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-rose-100 text-rose-800"
                            }`}
                          >
                            {sel.purchase_order_number
                              ? `PO ${sel.purchase_order_number}${
                                  sel.purchase_order_date
                                    ? ` · since ${fmtDate(sel.purchase_order_date)}`
                                    : ""
                                }`
                              : "No PO"}
                          </span>
                          {(() => {
                            const s = INVOICE_STATUS_META[invoiceStatusOf(selInvoices)];
                            return <span className={`pill ${s.cls}`}>{s.label}</span>;
                          })()}
                        </div>
                        <div className="mt-1 text-[13px] text-slate-500">
                          {sel.company_name ?? "—"} · {sel.country_iso_code ?? "—"} ·{" "}
                          {sel.billing_entity ?? "—"} · booked {fmtDate(sel.booking_date)}
                          {sel.end_date ? ` · ends ${fmtDate(sel.end_date)}` : ""}
                        </div>
                      </div>
                      <div className="ml-auto flex flex-none items-center gap-2">
                        {sel.booking_url && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5 text-[12.5px]"
                            asChild
                          >
                            <a href={sel.booking_url} target="_blank" rel="noreferrer">
                              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                              Back office
                            </a>
                          </Button>
                        )}
                        {/* Same targets as the list-level button, narrowed to this event. */}
                        {(() => {
                          if (!gmailConnection?.connected) return null;
                          const mine = incompleteTargets.filter((t) => t.eventRef === selRef);
                          if (mine.length === 0) return null;
                          return (
                            <Button
                              size="sm"
                              className="h-8 gap-1.5 border-0 bg-naboo text-[12.5px] font-bold text-navy shadow-none hover:bg-naboo-hover"
                              onClick={() => requestDialog.open(mine)}
                            >
                              <Send className="h-3.5 w-3.5" aria-hidden="true" />
                              Ask {mine.length} partner{mine.length > 1 ? "s" : ""} for details
                            </Button>
                          );
                        })()}
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-5">
                      {(() => {
                        const pay = paymentStatus(sel, selInvoices);
                        const inv = invoicingSla(sel, selInvoices);
                        const po = payoutSla(sel, selPartners);
                        const stats: Array<{ label: string; value: string; tone?: string }> = [
                          {
                            label: "Client outstanding",
                            value: fmtCurrency(sel.client_reste_a_encaisser_ttc, sel.currency),
                            tone:
                              (sel.client_reste_a_encaisser_ttc ?? 0) > 0.01
                                ? "text-rose-700"
                                : undefined,
                          },
                          {
                            label: "Owed to partners",
                            value: fmtCurrency(sel.partner_reste_a_decaisser_ttc, sel.currency),
                            tone:
                              (sel.partner_reste_a_decaisser_ttc ?? 0) > 0.01
                                ? "text-rose-700"
                                : undefined,
                          },
                          { label: "Invoicing SLA", value: inv.label },
                          { label: "Payment", value: pay.label },
                          { label: "Payout SLA", value: po.label },
                        ];
                        return stats.map((s) => (
                          <div key={s.label} className="bg-white px-3 py-2.5">
                            <div className="text-[9.5px] font-bold uppercase tracking-[0.08em] text-slate-500">
                              {s.label}
                            </div>
                            <div
                              className={`mt-0.5 cell-mono whitespace-nowrap text-base font-semibold ${s.tone ?? ""}`}
                            >
                              {s.value}
                            </div>
                          </div>
                        ));
                      })()}
                    </div>
                  </div>

                  <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
                    <EventDetails partners={selPartners} invoices={selInvoices} row={sel} />
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {requestDialog.targets && (
        <RequestInfoDialog targets={requestDialog.targets} onClose={requestDialog.close} />
      )}
    </div>
  );
}

/** Figures on the overview are plain: no currency symbol, grouped thousands. */
function fmtPaper(value: number): string {
  return new Intl.NumberFormat("fr-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
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
  onOpen,
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
  onOpen: (key: ListKey) => void;
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
  const figures = [
    { label: "Client to collect", value: portfolio.toCollect, alert: false },
    { label: "Owed to partners", value: portfolio.toPartners, alert: false },
    { label: "Not yet invoiced", value: portfolio.notInvoiced, alert: false },
    { label: "Overdue", value: portfolio.overdue, alert: true },
  ];

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto bg-paper-canvas font-paper text-paper-ink lg:grid-cols-[1fr_380px]">
      <div className="border-paper-rule px-10 pb-10 pt-11 lg:border-r">
        <div className="text-[10.5px] uppercase tracking-[0.2em] text-paper-label">
          L'Oréal Canada · portfolio in flight
        </div>
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
          {figures.map((f) => (
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
            return (
              <button
                key={list.key}
                type="button"
                disabled={empty}
                onClick={() => onOpen(list.key)}
                className={`flex w-full items-center gap-6 border-t border-paper-rule py-[22px] text-left ${
                  i === lists.length - 1 ? "border-b" : ""
                } ${empty ? "opacity-45" : "hover:bg-paper-row"}`}
              >
                <span className="w-[26px] font-paper-mono text-[13px] text-paper-label">
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
                <span
                  className={`inline-flex h-[34px] flex-none items-center justify-center px-4 text-[13px] ${
                    empty
                      ? "text-paper-faint"
                      : list.meta.primary
                        ? "bg-naboo text-paper-ink"
                        : list.meta.quiet
                          ? "text-paper-body"
                          : "border border-paper-ink"
                  }`}
                >
                  {list.meta.primary ? "Review & send" : "Open list"}
                </span>
              </button>
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

function EventDetails({
  partners,
  invoices,
  row,
}: {
  partners: PartnerLine[];
  invoices: InvoiceLine[];
  row: SlaRow;
}) {
  const eventRef = row.readable_id ?? row.client_request_id ?? "";
  const bookingUrl = row.booking_url ?? null;
  const { data: statusMap } = usePartnerStatuses();
  const { factsMap, actionFor, cardApprovedCodes } = useActionIndex();
  const { data: gmailConnection } = useGmailConnection();
  const requestDialog = useRequestDialog();
  const setStatus = useSetPartnerStatus();
  const { data: commentSummaries } = useCommentSummaries();
  const [tab, setTab] = useState<"partners" | "invoices" | "emails" | "docs" | "comments">(
    "partners",
  );

  const tabs = [
    { key: "partners" as const, label: "Partners", count: partners.length },
    { key: "invoices" as const, label: "Client invoicing", count: invoices.length },
    {
      key: "emails" as const,
      label: "Emails",
      count: partners.filter((p) => p.email).length,
    },
    { key: "docs" as const, label: "Documents", count: null },
    {
      key: "comments" as const,
      label: "Comments",
      count: commentSummaries?.get(eventRef)?.count ?? null,
    },
  ];

  return (
    <div className="flex flex-col">
      {/* Tab bar — counts come from the same data each panel renders. */}
      <div className="-mx-6 -mt-5 mb-5 flex flex-none gap-[18px] border-b border-border bg-white px-6">
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`inline-flex h-10 items-center gap-1.5 whitespace-nowrap border-b-2 bg-transparent p-0 text-[13px] ${
                active
                  ? "border-navy font-semibold text-navy"
                  : "border-transparent font-normal text-slate-600"
              }`}
            >
              {t.label}
              {t.count != null && <span className="font-normal text-slate-400">{t.count}</span>}
            </button>
          );
        })}
      </div>

      <div hidden={tab !== "partners"}>
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Truck className="h-3.5 w-3.5" />
          Partners ({partners.length})
        </div>
        {/* Answers "who do I have to pay on this event?" before the table does. */}
        {(() => {
          const unpaid = unpaidPartners(partners);
          if (unpaid.length === 0) {
            return partners.length === 0 ? null : (
              <div className="mb-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                Every provider on this event is paid.
              </div>
            );
          }
          if (!hasPurchaseOrder(row)) {
            return (
              <div className="mb-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                {unpaid.length} provider{unpaid.length > 1 ? "s" : ""} still owed{" "}
                {fmtMulti(totalByCurrency(unpaid, row.currency))}, but no PO has been received —
                nothing can be paid yet.
              </div>
            );
          }
          return (
            <div className="mb-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <span className="font-semibold">
                {unpaid.length} provider{unpaid.length > 1 ? "s" : ""} to pay —{" "}
                {fmtMulti(totalByCurrency(unpaid, row.currency))}
              </span>
              <ul className="mt-1 space-y-0.5">
                {unpaid.map(({ partner, remaining }, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="truncate">{partnerLabel(partner)}</span>
                    <span className="flex-none tabular-nums">
                      {fmtCurrency(remaining, partner.currency ?? row.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}
        {partners.length === 0 ? (
          <div className="rounded border border-dashed bg-white px-3 py-4 text-xs text-muted-foreground">
            No partners on this event.
          </div>
        ) : (
          <div className="overflow-hidden rounded border bg-white">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5">Partner</th>
                  <th className="px-2 py-1.5">Contact</th>
                  <th className="px-2 py-1.5 text-right">Due</th>
                  <th className="px-2 py-1.5 text-right">Paid</th>
                  <th className="px-2 py-1.5 text-right">Remaining</th>
                  <th className="px-2 py-1.5">Manual status</th>
                </tr>
              </thead>
              <tbody>
                {partners.map((p, i) => {
                  const due = Math.max(p.amount_due ?? 0, 0);
                  const paidRaw = p.amount_paid ?? 0;
                  // Paid is stored as a negative (cash outflow) in the source;
                  // normalize to a positive magnitude for status logic.
                  const paid = Math.abs(paidRaw);

                  const pname = p.name ?? "";
                  const key = `${eventRef}::${partnerKey(pname)}`;
                  const stored = statusMap?.get(key)?.status;

                  // Derive status from amounts when any payment exists.
                  let derived: PartnerStatusValue | null = null;
                  if (due <= 0.01) derived = "fully_paid";
                  else if (paid > 0.01 && paid + 0.01 >= due) derived = "fully_paid";
                  else if (paid > 0.01) derived = "partially_paid";

                  const current: PartnerStatusValue = derived ?? stored ?? "not_contacted";
                  const opt = PARTNER_STATUS_OPTIONS.find((o) => o.value === current)!;
                  const manualOptions = PARTNER_STATUS_OPTIONS.filter(
                    (o) => o.value === "not_contacted" || o.value === "waiting_bank",
                  );
                  return (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-1.5 font-medium">
                        {pname || "—"}
                        {p.is_cancelled && (
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            (cancelled)
                          </span>
                        )}
                        <PartnerStickers
                          action={actionFor(eventRef, p, Boolean(row.purchase_order_number))}
                          facts={factsMap?.get(key)}
                          partner={p}
                          cardApprovedInSlack={
                            p.owner_code != null &&
                            cardApprovedCodes?.has(p.owner_code.toUpperCase()) === true
                          }
                        />
                        {(() => {
                          if (!gmailConnection?.connected || !p.email) return null;
                          const action = actionFor(eventRef, p, Boolean(row.purchase_order_number));
                          const needs = needsOf(action, p.country);
                          if (!needs) return null;
                          return (
                            <button
                              type="button"
                              onClick={() =>
                                requestDialog.open(
                                  buildTargets([
                                    {
                                      eventRef,
                                      eventDate: row.start_date ?? null,
                                      name: p.name,
                                      email: p.email,
                                      country: p.country,
                                      currency: p.currency,
                                      amountDue: p.amount_due,
                                      action,
                                      isCancelled: p.is_cancelled,
                                    },
                                  ]),
                                )
                              }
                              className="mt-1 block text-[10.5px] text-sky-800 underline-offset-2 hover:underline"
                            >
                              Demander {describeNeeds(needs)}
                            </button>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        <div>{p.email || "—"}</div>
                        <div>{p.phone || ""}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {fmtCurrency(due, p.currency)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {fmtCurrency(p.amount_paid, p.currency)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {p.is_cancelled || due - paid <= 0.01 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className="font-semibold text-rose-700">
                            {fmtCurrency(+(due - paid).toFixed(2), p.currency)}
                          </span>
                        )}
                      </td>

                      <td className="px-2 py-1.5">
                        {derived ? (
                          <span className={`pill ${opt.cls}`} title="Derived from amounts">
                            {opt.label}
                          </span>
                        ) : (
                          <select
                            value={current}
                            disabled={!pname || !eventRef || setStatus.isPending}
                            onChange={(e) =>
                              setStatus.mutate({
                                event_ref: eventRef,
                                partner_name: pname,
                                status: e.target.value as PartnerStatusValue,
                              })
                            }
                            className={`rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${opt.cls} focus:outline-none focus:ring-1 focus:ring-slate-300`}
                          >
                            {manualOptions.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div hidden={tab !== "invoices"}>
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <FileText className="h-3.5 w-3.5" />
          Invoices ({invoices.length})
        </div>
        {invoices.length === 0 ? (
          <div className="rounded border border-dashed bg-white px-3 py-4 text-xs text-muted-foreground">
            No invoices issued yet for this event.
          </div>
        ) : (
          <div className="overflow-hidden rounded border bg-white">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5">Ref</th>
                  <th className="px-2 py-1.5">Dir.</th>
                  <th className="px-2 py-1.5">Emitted</th>
                  <th className="px-2 py-1.5">Due</th>
                  <th className="px-2 py-1.5 text-right">Amount TTC</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5">Sent</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1.5 font-mono text-[11px]">{inv.invoice_ref || "—"}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {inv.direction === "INCOME" ? "client" : "partner"}
                    </td>
                    <td className="px-2 py-1.5">{fmtDate(inv.emission_date)}</td>
                    <td className="px-2 py-1.5">
                      {fmtDate(inv.due_date)}
                      {inv.days_overdue && inv.days_overdue > 0 ? (
                        <span className="ml-1 text-[10px] text-rose-700">+{inv.days_overdue}d</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {fmtCurrency(inv.amount_ttc, inv.currency)}
                    </td>
                    <td className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      {(inv.status ?? "—").toLowerCase()}
                    </td>
                    <td className="px-2 py-1.5">
                      {inv.is_sent ? (
                        <span className="text-emerald-700">{inv.send_method || "yes"}</span>
                      ) : (
                        <span className="text-muted-foreground">not sent</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(() => {
          const firstActive = invoices
            .filter((i) => i.emission_date)
            .sort((a, b) => (a.emission_date ?? "").localeCompare(b.emission_date ?? ""))[0];
          if (!firstActive?.emission_date) return null;
          return (
            <div className="mt-2 text-[11px] text-muted-foreground">
              First invoice emitted {fmtDate(firstActive.emission_date)} · payment due{" "}
              {new Date(new Date(firstActive.emission_date).getTime() + 60 * 86_400_000)
                .toISOString()
                .slice(0, 10)}{" "}
              (60d)
            </div>
          );
        })()}
      </div>

      <div hidden={tab !== "emails"}>
        <PartnerEmails
          eventRef={eventRef}
          partners={partners.map((p) => ({
            name: p.name,
            email: p.email,
            owed: fmtCurrency(p.amount_due, p.currency),
          }))}
        />
      </div>

      <div hidden={tab !== "docs"}>
        <PartnerInvoicePdfs clientRequestId={row.client_request_id} />
      </div>

      <div hidden={tab !== "comments"}>
        <EventComments eventRef={eventRef} />
      </div>

      {requestDialog.targets && (
        <RequestInfoDialog targets={requestDialog.targets} onClose={requestDialog.close} />
      )}
    </div>
  );
}

function EventComments({ eventRef }: { eventRef: string }) {
  const { data: user } = useCurrentUser();
  const { data: comments, isLoading } = useEventComments(eventRef);
  const addComment = useAddComment(eventRef);
  const deleteComment = useDeleteComment(eventRef);
  const [body, setBody] = useState("");

  const fmtWhen = (iso: string) => {
    try {
      return new Date(iso).toLocaleString("fr-FR", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  const submit = () => {
    const text = body.trim();
    if (!text || addComment.isPending) return;
    addComment.mutate(text, { onSuccess: () => setBody("") });
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <FileText className="h-3.5 w-3.5" />
        Comments ({comments?.length ?? 0})
      </div>
      <div className="rounded border bg-white">
        <div className="divide-y">
          {isLoading && <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>}
          {!isLoading && (comments?.length ?? 0) === 0 && (
            <div className="px-3 py-3 text-xs text-muted-foreground">No comments yet.</div>
          )}
          {comments?.map((c) => (
            <div key={c.id} className="flex gap-3 px-3 py-2.5">
              <UserAvatar
                name={c.user_name}
                email={c.user_email}
                picture={c.user_avatar_url}
                className="h-6 w-6"
                fallbackClassName="bg-slate-200 text-slate-700"
                textClassName="text-[10px]"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-slate-800">{c.user_name || c.user_email}</span>
                  <span>·</span>
                  <span>{fmtWhen(c.created_at)}</span>
                  {user?.id === c.user_id && (
                    <button
                      type="button"
                      onClick={() => deleteComment.mutate(c.id)}
                      className="ml-auto text-[11px] text-rose-600 hover:underline disabled:opacity-50"
                      disabled={deleteComment.isPending}
                    >
                      Delete
                    </button>
                  )}
                </div>
                <div className="comment-body mt-0.5 whitespace-pre-wrap text-slate-800">
                  {c.body}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-end gap-2 border-t bg-slate-50/60 px-3 py-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={user ? "Add a comment… (⌘/Ctrl+Enter to send)" : "Sign in to comment"}
            disabled={!user || addComment.isPending}
            rows={2}
            className="min-h-[36px] flex-1 resize-y rounded-md border bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-slate-300"
          />
          <Button
            size="sm"
            onClick={submit}
            disabled={!user || !body.trim() || addComment.isPending}
          >
            {addComment.isPending ? "Posting…" : "Post"}
          </Button>
        </div>
        {addComment.isError && (
          <div
            role="alert"
            className="border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
          >
            Comment not saved: {String((addComment.error as Error)?.message ?? addComment.error)}
          </div>
        )}
        {deleteComment.isError && (
          <div
            role="alert"
            className="border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
          >
            Comment not deleted:{" "}
            {String((deleteComment.error as Error)?.message ?? deleteComment.error)}
          </div>
        )}
      </div>
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="mt-1 font-display text-[28px] font-bold leading-tight tracking-tight">
          {value}
        </div>
        {sub != null &&
          (typeof sub === "string" ? (
            <div className="text-xs text-muted-foreground">{sub}</div>
          ) : (
            <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
          ))}
      </CardContent>
    </Card>
  );
}

function BreakdownCard({
  icon,
  label,
  total,
  rows,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  total: string;
  accent: "indigo" | "sky";
  rows: { label: string; hint: string; amount: string; count: number }[];
}) {
  const accentBg = accent === "indigo" ? "bg-indigo-50" : "bg-sky-50";
  const accentText = accent === "indigo" ? "text-indigo-700" : "text-sky-700";
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            {icon}
            {label}
          </div>
          <div className="font-display text-[22px] font-bold tracking-tight">{total}</div>
        </div>
        <div className="mt-3 divide-y rounded-md border">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span
                    className={`inline-flex h-5 min-w-[1.5rem] items-center justify-center rounded px-1.5 text-[11px] font-semibold ${accentBg} ${accentText}`}
                  >
                    {r.count}
                  </span>
                  <span className="truncate">{r.label}</span>
                </div>
                <div className="text-[11px] text-muted-foreground">{r.hint}</div>
              </div>
              <div className="whitespace-nowrap text-sm font-semibold tabular-nums">
                {r.amount || "—"}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ColFilter({
  value,
  onChange,
  options,
  placeholder = "All",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  const active = value !== "all";
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      className={`h-[22px] w-full max-w-[92px] rounded border px-1 text-[10.5px] font-normal ${
        active
          ? "border-slate-400 bg-white text-slate-900"
          : "border-slate-200 bg-white/60 text-muted-foreground"
      }`}
    >
      <option value="all">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
