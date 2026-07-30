import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, useEffect, Fragment } from "react";
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
  const poTs = row.purchase_order_updated_at
    ? new Date(row.purchase_order_updated_at).getTime()
    : null;
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
  const poTs = row.purchase_order_updated_at
    ? new Date(row.purchase_order_updated_at).getTime()
    : null;
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
  decorated.forEach(({ row, partners }) => {
    if (!row.purchase_order_number || !String(row.purchase_order_number).trim()) return;
    partners.forEach((p) => {
      if (!p.name || !p.name.trim()) return;
      if (p.is_cancelled) return;
      const due = Math.max(p.amount_due ?? 0, 0);
      const paid = Math.abs(p.amount_paid ?? 0);
      if (due <= 0.01) return; // nothing owed
      if (paid + 0.01 >= due) return; // fully paid
      const remaining = +(due - paid).toFixed(2);
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
  // Turnkey is out by default (Naboo runs those end to end) but can be brought back.
  const [kindFilter, setKindFilter] = useState<string>("no_turnkey");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
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
      const entry = poDates.get(ref);
      if (!entry || entry.po !== po) return r;
      return { ...r, purchase_order_updated_at: entry.emitted_at };
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

  const filtered = useMemo(() => {
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
        if (statusFilter === "not_invoiced") return !x.first_income_invoice_emission_date;
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
  }, [
    decorated,
    search,
    statusFilter,
    kindFilter,
    tagFilter,
    sortKey,
    sortDir,
    colFilters,
    actionFor,
    factsMap,
    cardApprovedCodes,
  ]);

  // KPIs
  const kpis = useMemo(() => {
    const total = rows.length;
    const invoiceSent = decorated.filter(({ invoices: iv }) =>
      iv.some((i) => i.is_sent || !!i.first_sent_at),
    ).length;
    const invoiceIssuedNotSent = decorated.filter(
      ({ invoices: iv }) => iv.length > 0 && !iv.some((i) => i.is_sent || !!i.first_sent_at),
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
      else if (invoices.length === 0) bucket = "notInvoiced";
      else if (invoices.every((i) => i.is_sent || !!i.first_sent_at)) bucket = "invoiceSent";
      else bucket = "invoiceIssuedNotSent";
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
  const selected = useMemo(() => {
    if (filtered.length === 0) return null;
    const hit = filtered.find(
      (x) => (x.row.client_request_id ?? x.row.readable_id ?? "") === selectedId,
    );
    return hit ?? filtered[0];
  }, [filtered, selectedId]);

  const groups = useMemo(() => {
    const buckets: Array<{
      key: string;
      title: string;
      dot: string;
      rows: typeof filtered;
    }> = [
      { key: "breached", title: "Breached", dot: "#dc2626", rows: [] },
      { key: "todo", title: "Contact to do", dot: "#f59e0b", rows: [] },
      { key: "waiting", title: "Waiting on partner", dot: "#0ea5e9", rows: [] },
      { key: "ours", title: "Ours to close", dot: "#6366f1", rows: [] },
      { key: "done", title: "Nothing to do", dot: "#9ca3af", rows: [] },
    ];
    const put = (k: string, item: (typeof filtered)[number]) =>
      buckets.find((b) => b.key === k)!.rows.push(item);

    for (const item of filtered) {
      const { row: r, partners: ps, invoices: iv } = item;
      const isBreached =
        paymentStatus(r, iv).variant === "overdue" ||
        payoutSla(r, ps).variant === "overdue" ||
        invoicingSla(r, iv).variant === "overdue";
      if (isBreached) {
        put("breached", item);
        continue;
      }
      const ref = r.readable_id ?? r.client_request_id ?? "";
      const out = partnerOutreach(ps, ref, Boolean(r.purchase_order_number));
      if (out?.label.includes("Contact TBD")) put("todo", item);
      else if (out?.label.includes("Contact")) put("waiting", item);
      else if (out?.label.includes("Payout")) put("ours", item);
      else put("done", item);
    }
    return buckets.filter((b) => b.rows.length > 0);
  }, [filtered, statusMap, factsMap]);

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
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="h-8 w-full text-[12px]">
                      <SelectValue placeholder="Filter" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All events</SelectItem>
                      <SelectItem value="not_invoiced">Not invoiced</SelectItem>
                      <SelectItem value="invoicing_breached">Invoicing SLA breached</SelectItem>
                      <SelectItem value="payout_breached">Payout SLA breached</SelectItem>
                      <SelectItem value="partner_outstanding">Partner outstanding</SelectItem>
                    </SelectContent>
                  </Select>
                </PopoverContent>
              </Popover>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="rounded-full bg-slate-100 px-2.5 py-[3px] text-[11.5px] text-slate-600">
                {filtered.length} / {rows.length} events
              </span>
              {breached.length > 0 && (
                <span className="rounded-full bg-rose-100 px-2.5 py-[3px] text-[11.5px] font-semibold text-rose-800">
                  {breached.length} breached
                </span>
              )}
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
            {!isLoading && filtered.length === 0 && (
              <div className="flex flex-col items-center gap-2.5 px-12 py-16 text-center">
                <SearchX className="h-6 w-6 text-slate-400" aria-hidden="true" />
                <span className="font-display text-base font-bold">
                  {search ? `Nothing matches “${search}”` : "Nothing to show"}
                </span>
                <span className="text-[12.5px] leading-relaxed text-slate-600">
                  Search covers event refs, event types, partner names and invoice refs.
                </span>
                {search && (
                  <Button variant="outline" size="sm" className="h-7" onClick={() => setSearch("")}>
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
                    const out = partnerOutreach(
                      item.partners,
                      ref,
                      Boolean(r.purchase_order_number),
                    );
                    const owed = r.partner_reste_a_decaisser_ttc ?? 0;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setSelectedId(id)}
                        className={`flex w-full gap-2.5 border-b border-slate-100 px-4 py-2.5 text-left ${
                          isSel ? "bg-naboo/25" : "hover:bg-slate-50"
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
                          <span className="mt-1 flex flex-wrap gap-1">
                            {out && <span className={`pill ${out.cls}`}>{out.label}</span>}
                            {!r.purchase_order_number && (
                              <span className="pill bg-slate-100 text-slate-600">No PO</span>
                            )}
                          </span>
                        </span>
                        <span className="flex-none whitespace-nowrap text-right">
                          <span className="block cell-mono text-[13px] font-semibold">
                            {owed > 0.01 ? fmtCurrency(owed, r.currency) : "—"}
                          </span>
                          <span className="block text-[10.5px] text-slate-400">owed</span>
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
                        {sel.purchase_order_number ? `PO ${sel.purchase_order_number}` : "No PO"}
                      </span>
                    </div>
                    <div className="mt-1 text-[13px] text-slate-500">
                      {sel.company_name ?? "—"} · {sel.country_iso_code ?? "—"} ·{" "}
                      {sel.billing_entity ?? "—"} · booked {fmtDate(sel.booking_date)}
                      {sel.end_date ? ` · ends ${fmtDate(sel.end_date)}` : ""}
                    </div>
                  </div>
                  <div className="ml-auto flex flex-none gap-2">
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

      {requestDialog.targets && (
        <RequestInfoDialog targets={requestDialog.targets} onClose={requestDialog.close} />
      )}
    </div>
  );
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
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div>
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Truck className="h-3.5 w-3.5" />
          Partners ({partners.length})
        </div>
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

      <div>
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

      <div className="md:col-span-2">
        <PartnerEmails
          eventRef={eventRef}
          partners={partners.map((p) => ({
            name: p.name,
            email: p.email,
            owed: fmtCurrency(p.amount_due, p.currency),
          }))}
        />
      </div>

      <div className="md:col-span-2">
        <PartnerInvoicePdfs clientRequestId={row.client_request_id} />
      </div>

      <div className="md:col-span-2">
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
