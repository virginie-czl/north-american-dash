import { createFileRoute } from "@tanstack/react-router";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  SummaryStrip,
  useRegisterTrackerActions,
} from "@/components/tracker-chrome";
import { PartnerEmails } from "@/components/partner-emails";
import { EventStickers, PartnerStickers } from "@/components/partner-fact-stickers";
import { useActionIndex } from "@/lib/use-partner-actions";
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
} from "lucide-react";


export const Route = createFileRoute("/_authenticated/")({
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
  const poTs = row.purchase_order_updated_at ? new Date(row.purchase_order_updated_at).getTime() : null;
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
    partners && partners.length > 0 &&
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
  const poTs = row.purchase_order_updated_at ? new Date(row.purchase_order_updated_at).getTime() : null;
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
  return (
    <span className={`pill ${map[status.variant]}`}>
      {status.label}
    </span>
  );
}


const PARTNER_STATUS_OPTIONS: { value: PartnerStatusValue; label: string; cls: string }[] = [
  { value: "not_contacted", label: "Not contacted", cls: "bg-slate-100 text-slate-700 border-slate-200" },
  { value: "waiting_bank", label: "Waiting bank details", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  { value: "partially_paid", label: "Partially paid", cls: "bg-sky-100 text-sky-800 border-sky-200" },
  { value: "fully_paid", label: "Fully paid", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
];


function csvEscape(v: string): string {
  if (/[",\n;]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function exportUnpaidPartners(
  decorated: { row: SlaRow; partners: PartnerLine[] }[],
) {
  const rows: string[][] = [
    ["Event date", "Event ref", "Company", "Partner name", "Partner email", "Currency", "Amount due", "Amount paid", "Remaining"],
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
    ["Event date", "Event ref", "Company", "Partner name", "Partner email", "Currency", "Amount due", "Outreach status"],
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
  const initials = (name?: string | null, email?: string | null) => {
    const src = (name || email || "?").trim();
    const parts = src.split(/\s+/);
    return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || src[0]?.toUpperCase() || "?";
  };
  return (
    <span
      className="ml-2 inline-flex items-center gap-1.5 align-middle"
      title={`${summary.count} comment${summary.count > 1 ? "s" : ""} from ${summary.commenters
        .map((c) => c.user_name || c.user_email)
        .join(", ")}`}
    >
      <span className="flex -space-x-2">
        {shown.map((c) =>
          c.user_avatar_url ? (
            <img
              key={c.user_id}
              src={c.user_avatar_url}
              alt={c.user_name ?? c.user_email}
              referrerPolicy="no-referrer"
              className="h-7 w-7 rounded-full border-2 border-white object-cover shadow-sm"
            />
          ) : (
            <span
              key={c.user_id}
              className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-slate-300 text-[11px] font-semibold text-slate-700 shadow-sm"
            >
              {initials(c.user_name, c.user_email)}
            </span>
          ),
        )}
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
  const { factsMap, factsError, actionFor, eventNeedsScan } = useActionIndex();
  const { data: gmailConnection, error: gmailError } = useGmailConnection();
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
          r.payout_sla_status === "FULLY_PAID" ||
          (r.partner_reste_a_decaisser_ttc ?? 0) === 0;
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
    () => Array.from(new Set(decorated.map((d) => d.row.event_type).filter((v): v is string => !!v))).sort(),
    [decorated],
  );
  const distinctCountries = useMemo(
    () => Array.from(new Set(decorated.map((d) => d.row.country_iso_code).filter((v): v is string => !!v))).sort(),
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
            (p) =>
              p.name?.toLowerCase().includes(q) ||
              p.email?.toLowerCase().includes(q),
          ) ||
          x.invoices.some((i) => i.invoice_ref?.toLowerCase().includes(q)),
      );
    }
    if (statusFilter !== "all") {
      r = r.filter(({ row: x, partners: ps, invoices: iv }) => {
        if (statusFilter === "invoicing_breached") return invoicingSla(x, iv).variant === "overdue";
        if (statusFilter === "payout_breached") return payoutSla(x, ps).variant === "overdue";
        if (statusFilter === "receivable_overdue") return paymentStatus(x, iv).variant === "overdue";
        if (statusFilter === "not_invoiced")
          return !x.first_income_invoice_emission_date;
        if (statusFilter === "partner_outstanding")
          return (x.partner_reste_a_decaisser_ttc ?? 0) > 0;
        return true;
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
  }, [decorated, search, statusFilter, sortKey, sortDir, colFilters]);


  // KPIs
  const kpis = useMemo(() => {
    const total = rows.length;
    const invoiceSent = decorated.filter(({ invoices: iv }) =>
      iv.some((i) => i.is_sent || !!i.first_sent_at),
    ).length;
    const invoiceIssuedNotSent = decorated.filter(({ invoices: iv }) =>
      iv.length > 0 && !iv.some((i) => i.is_sent || !!i.first_sent_at),
    ).length;
    const notInvoiced = total - invoiceSent - invoiceIssuedNotSent;
    const overdueReceivables = decorated.filter(({ row: r, invoices: iv }) => paymentStatus(r, iv).variant === "overdue").length;

    // Partner outstanding: split into buckets by PO presence, partner naming,
    // and outreach status (not contacted vs waiting bank details).
    const partnerBuckets = {
      toContact: new Map<string, number>(),    // PO + named partner, not contacted yet
      waitingBank: new Map<string, number>(),  // PO + named partner, already contacted
      withPoNoName: new Map<string, number>(), // PO + partner has no name
      noPo: new Map<string, number>(),         // no PO
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
    [partnerBuckets.toContact, partnerBuckets.waitingBank, partnerBuckets.withPoNoName, partnerBuckets.noPo].forEach((m) =>
      m.forEach((v, k) => partnerByCcy.set(k, (partnerByCcy.get(k) ?? 0) + v)),
    );
    const partnerOutstandingCount =
      partnerCounts.toContact + partnerCounts.waitingBank + partnerCounts.withPoNoName + partnerCounts.noPo;

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
      const hasNamedPartner = partners.some(
        (p) => !p.is_cancelled && p.name && p.name.trim(),
      );
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
    Object.values(clientBuckets).forEach(
      (m) => m.forEach((v, k) => clientByCcy.set(k, (clientByCcy.get(k) ?? 0) + v)),
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
    let fully = 0, partial = 0, notPaid = 0;
    partners.forEach((p) => {
      if (p.is_cancelled) return;
      const due = Math.max(p.amount_due ?? 0, 0);
      const paid = Math.abs(p.amount_paid ?? 0);
      if (due <= 0.01 && paid <= 0.01) return;
      if (due <= 0.01) { fully++; return; }
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
    if (anyPartial)
      return { label: "Payout to do", cls: "bg-sky-100 text-sky-800" };
    const statuses = active.map((p) => {
      const k = `${eventRef}::${partnerKey(p.name)}`;
      return statusMap?.get(k)?.status ?? "not_contacted";
    });
    if (statuses.every((s) => s === "not_contacted"))
      return { label: "Contact asap", cls: "bg-rose-100 text-rose-800" };
    if (statuses.every((s) => s !== "not_contacted"))
      return { label: "Contacted — Bank details pending", cls: "bg-amber-100 text-amber-800 border-amber-200" };
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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <SummaryStrip
        title="L'Oréal Canada"
        stats={[
          { label: "Events", value: isLoading ? "…" : String(kpis.total) },
          {
            label: "Not sent",
            value: isLoading
              ? "…"
              : String(kpis.invoiceIssuedNotSent + kpis.notInvoiced),
          },
          {
            label: "Client outstanding",
            value: isLoading ? "…" : fmtMultiCcy(kpis.clientByCcy),
          },
          {
            label: "Owed to partners",
            value: isLoading ? "…" : fmtMultiCcy(kpis.partnerByCcy),
          },
        ]}
        alert={breached.length > 0 ? `${breached.length} breached` : null}
      >
        {/* Summary detail (collapsed by default) */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <KpiCard icon={<Receipt className="h-4 w-4" />} label="Total events" value={isLoading ? "…" : kpis.total.toString()} />
          <KpiCard
            icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />}
            label="Invoice sent"
            value={isLoading ? "…" : kpis.invoiceSent.toString()}
            sub={`${kpis.total ? Math.round((kpis.invoiceSent / kpis.total) * 100) : 0}%`}
          />
          <KpiCard
            icon={<Clock className="h-4 w-4 text-amber-600" />}
            label="Not sent"
            value={isLoading ? "…" : (kpis.invoiceIssuedNotSent + kpis.notInvoiced).toString()}
            sub={`${kpis.invoiceIssuedNotSent} issued · ${kpis.notInvoiced} not invoiced`}
          />
          <KpiCard icon={<AlertTriangle className="h-4 w-4 text-rose-600" />} label="Overdue (60d)" value={isLoading ? "…" : kpis.overdueReceivables.toString()} />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <BreakdownCard
            icon={<Users className="h-4 w-4 text-indigo-600" />}
            label="Still to pay partners"
            total={isLoading ? "…" : fmtMultiCcy(kpis.partnerByCcy)}
            accent="indigo"
            rows={[
              { label: "To contact", hint: "PO + named partner, not contacted yet", amount: fmtMultiCcy(kpis.partnerBuckets.toContact), count: kpis.partnerCounts.toContact },
              { label: "Waiting bank details", hint: "contacted — awaiting info", amount: fmtMultiCcy(kpis.partnerBuckets.waitingBank), count: kpis.partnerCounts.waitingBank },
              { label: "PO, partner name missing", hint: "needs partner info", amount: fmtMultiCcy(kpis.partnerBuckets.withPoNoName), count: kpis.partnerCounts.withPoNoName },
              { label: "No PO", hint: "blocked — awaiting PO", amount: fmtMultiCcy(kpis.partnerBuckets.noPo), count: kpis.partnerCounts.noPo },
            ]}
          />
          <BreakdownCard
            icon={<Wallet className="h-4 w-4 text-sky-600" />}
            label="Client outstanding"
            total={isLoading ? "…" : fmtMultiCcy(kpis.clientByCcy)}
            accent="sky"
            rows={[
              { label: "Invoice sent", hint: "sent — chasing payment", amount: fmtMultiCcy(kpis.clientBuckets.invoiceSent), count: kpis.clientCounts.invoiceSent },
              { label: "Invoice issued, not sent", hint: "needs to be sent", amount: fmtMultiCcy(kpis.clientBuckets.invoiceIssuedNotSent), count: kpis.clientCounts.invoiceIssuedNotSent },
              { label: "Not invoiced yet", hint: "PO + partner ready, no invoice", amount: fmtMultiCcy(kpis.clientBuckets.notInvoiced), count: kpis.clientCounts.notInvoiced },
              { label: "PO, partner name missing", hint: "needs partner info", amount: fmtMultiCcy(kpis.clientBuckets.withPoNoPartner), count: kpis.clientCounts.withPoNoPartner },
              { label: "No PO", hint: "blocked — awaiting PO", amount: fmtMultiCcy(kpis.clientBuckets.noPo), count: kpis.clientCounts.noPo },
            ]}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <KpiCard
            icon={<TrendingUp className="h-4 w-4 text-violet-600" />}
            label="Service fees generated"
            value={isLoading ? "…" : fmtMultiCcy(kpis.serviceFeesByCcy)}
            sub="client invoiced TTC − partner net payable"
          />
        </div>


      </SummaryStrip>

      {error != null && (
        <div
          role="alert"
          className="flex-none border-b border-rose-200 bg-rose-50 px-5 py-2.5 text-sm text-rose-800"
        >
          Failed to load data: {String((error as Error).message ?? error)}
        </div>
      )}

      <Tabs defaultValue="table" className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList className="mx-5 my-1.5 h-8 flex-none self-start">
            <TabsTrigger value="table">Detailed table</TabsTrigger>
            <TabsTrigger value="charts">Breakdown</TabsTrigger>
            <TabsTrigger value="breached">Breached ({breached.length})</TabsTrigger>
          </TabsList>

          <TabsContent
            value="table"
            className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
          >
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border px-5 py-2">
                  <Input
                    placeholder="Search ref, event type, partner name/email, invoice…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="max-w-sm"
                  />
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-[220px]">
                      <SelectValue placeholder="Filter" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All events</SelectItem>
                      <SelectItem value="not_invoiced">Not invoiced</SelectItem>
                      <SelectItem value="invoicing_breached">Invoicing SLA breached</SelectItem>
                      <SelectItem value="payout_breached">Partner payout breached</SelectItem>
                      <SelectItem value="receivable_overdue">Client receivable overdue</SelectItem>
                      <SelectItem value="partner_outstanding">Partner still to pay</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={`${sortKey}:${sortDir}`}
                    onValueChange={(v) => {
                      const [k, d] = v.split(":");
                      setSortKey(k);
                      setSortDir(d as "asc" | "desc");
                    }}
                  >
                    <SelectTrigger className="w-[260px]">
                      <SelectValue placeholder="Sort" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="booking_created_at:desc">Most recently booked</SelectItem>
                      <SelectItem value="booking_created_at:asc">Oldest bookings</SelectItem>
                      <SelectItem value="days_since_booking:desc">Days since booking</SelectItem>
                      <SelectItem value="client_reste_a_encaisser_ttc:desc">Outstanding receivable</SelectItem>
                      <SelectItem value="partner_reste_a_decaisser_ttc:desc">Outstanding payout</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="ghost" size="sm" onClick={expandAll}>
                    Expand all
                  </Button>
                  <Button variant="ghost" size="sm" onClick={collapseAll}>
                    Collapse
                  </Button>
                  {gmailError != null && (
                    <span
                      role="alert"
                      className="inline-flex items-center rounded-md bg-rose-100 px-2 py-1 text-[11px] text-rose-800"
                      title={String((gmailError as Error).message ?? gmailError)}
                    >
                      Recherche email indisponible
                    </span>
                  )}
                  {gmailConnection?.connected === false && (
                    <button
                      type="button"
                      onClick={() => {
                        window.location.href = "/api/gmail/connect";
                      }}
                      className="text-[11.5px] text-slate-600 underline-offset-2 hover:underline"
                    >
                      Connecter Gmail
                    </button>
                  )}
                  {gmailConnection?.connected && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5"
                      disabled={scanProgress.running || filtered.length === 0}
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
                              // Only partners with an open question — a settled or
                              // already-answered partner cannot learn anything new.
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
                      title="Recherche dans vos emails les échanges liés à ces partenaires, puis met à jour les stickers partagés"
                    >
                      <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                      {scanProgress.running
                        ? `Recherche… ${scanProgress.done}/${scanProgress.total}`
                        : `Rechercher dans mes emails (${
                            filtered.filter(({ row: r, partners: ps }) =>
                              eventNeedsScan(
                                r.readable_id ?? r.client_request_id ?? "",
                                ps,
                                Boolean(r.purchase_order_number),
                              ),
                            ).length
                          })`}
                    </Button>
                  )}
                  <div className="ml-auto text-xs text-muted-foreground">
                    {filtered.length} / {rows.length} events
                  </div>
                </div>

                {factsError != null && (
                  <div
                    role="alert"
                    className="flex-none border-b border-rose-200 bg-rose-50 px-5 py-1.5 text-xs text-rose-800"
                  >
                    Pastilles email non chargées :{" "}
                    {String((factsError as Error).message ?? factsError)}
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
                      : `Analyse de vos emails — ${scanProgress.done}/${scanProgress.total} événements, ${scanProgress.matched} partenaires rapprochés. Les contenus ne sont jamais stockés.`}
                  </div>
                )}
                <div className="sla-scroll">
                  <Table className="sla-table">
                    <TableHeader>
                      <TableRow className="border-b-0">
                        <TableHead className="w-8"></TableHead>
                        <TableHead colSpan={5} className="text-center text-[11px] uppercase tracking-wide text-muted-foreground">
                          Event
                        </TableHead>
                        <TableHead colSpan={3} className="border-l-2 border-sky-200 bg-sky-50/60 text-center text-[11px] font-semibold uppercase tracking-wide text-sky-800">
                          Client — invoicing &amp; receivables
                        </TableHead>
                        <TableHead colSpan={3} className="border-l-2 border-indigo-200 bg-indigo-50/60 text-center text-[11px] font-semibold uppercase tracking-wide text-indigo-800">
                          Partner — payout
                        </TableHead>
                      </TableRow>
                      <TableRow>
                        <TableHead className="w-8"></TableHead>
                        <TableHead>Ref</TableHead>
                        <TableHead>Event</TableHead>
                        <TableHead>Booked</TableHead>
                        <TableHead className="whitespace-nowrap text-right">Days</TableHead>
                        <TableHead className="whitespace-nowrap">PO #</TableHead>
                        <TableHead className="border-l-2 border-sky-200 bg-sky-50/60">Invoicing SLA</TableHead>
                        <TableHead className="bg-sky-50/60 text-right">Outstanding</TableHead>
                        <TableHead className="bg-sky-50/60">Payment</TableHead>
                        <TableHead className="border-l-2 border-indigo-200 bg-indigo-50/60">Payout SLA</TableHead>
                        <TableHead className="bg-indigo-50/60">Outreach</TableHead>
                        <TableHead className="bg-indigo-50/60 text-right">Owed</TableHead>
                      </TableRow>
                      <TableRow className="bg-slate-50/70">
                        <TableHead className="w-8"></TableHead>
                        <TableHead></TableHead>
                        <TableHead>
                          <ColFilter
                            value={colFilters.event_type ?? "all"}
                            onChange={(v) => setCol("event_type", v)}
                            options={distinctEventTypes.map((v) => ({
                              value: v,
                              label: v.replaceAll("_", " ").toLowerCase(),
                            }))}
                          />
                          <ColFilter
                            value={colFilters.country ?? "all"}
                            onChange={(v) => setCol("country", v)}
                            options={distinctCountries.map((v) => ({ value: v, label: v }))}
                            placeholder="Country"
                          />
                        </TableHead>
                        <TableHead></TableHead>
                        <TableHead></TableHead>
                        <TableHead>
                          <ColFilter
                            value={colFilters.po ?? "all"}
                            onChange={(v) => setCol("po", v)}
                            options={[
                              { value: "with", label: "Has PO" },
                              { value: "without", label: "No PO" },
                            ]}
                          />
                        </TableHead>
                        <TableHead className="border-l-2 border-sky-200 bg-sky-50/60">
                          <ColFilter
                            value={colFilters.invoicing_sla ?? "all"}
                            onChange={(v) => setCol("invoicing_sla", v)}
                            options={[
                              { value: "paid", label: "On time" },
                              { value: "due", label: "Pending" },
                              { value: "overdue", label: "Breached" },
                              { value: "muted", label: "No PO / N/A" },
                            ]}
                          />
                        </TableHead>
                        <TableHead className="bg-sky-50/60"></TableHead>
                        <TableHead className="bg-sky-50/60">
                          <ColFilter
                            value={colFilters.payment_status ?? "all"}
                            onChange={(v) => setCol("payment_status", v)}
                            options={[
                              { value: "paid", label: "Paid" },
                              { value: "due", label: "Due" },
                              { value: "overdue", label: "Overdue" },
                              { value: "muted", label: "Not sent / N/A" },
                            ]}
                          />
                        </TableHead>
                        <TableHead className="border-l-2 border-indigo-200 bg-indigo-50/60">
                          <ColFilter
                            value={colFilters.payout_sla ?? "all"}
                            onChange={(v) => setCol("payout_sla", v)}
                            options={[
                              { value: "paid", label: "Fully paid" },
                              { value: "due", label: "Pending" },
                              { value: "overdue", label: "Breached" },
                              { value: "muted", label: "No PO / N/A" },
                            ]}
                          />
                        </TableHead>
                        <TableHead className="bg-indigo-50/60">
                          <ColFilter
                            value={colFilters.outreach ?? "all"}
                            onChange={(v) => setCol("outreach", v)}
                            options={distinctOutreach.map((v) => ({ value: v, label: v }))}
                          />
                        </TableHead>
                        <TableHead className="bg-indigo-50/60"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {isLoading && (
                        <TableRow>
                          <TableCell colSpan={12} className="py-12 text-center text-muted-foreground">
                            Loading data from BigQuery…
                          </TableCell>
                        </TableRow>
                      )}
                      {!isLoading &&
                        filtered.map(({ row: r, partners, invoices }) => {
                          const id = r.client_request_id ?? r.readable_id ?? "";
                          const isOpen = !!expanded[id];
                          const pay = paymentStatus(r, invoices);
                          const inv = invoicingSla(r, invoices);
                          const pay2 = payoutSla(r, partners);
                          const childCount = partners.length + invoices.length;
                          return (
                            <Fragment key={id || Math.random()}>
                              <TableRow
                                className="cursor-pointer hover:bg-slate-50"
                                onClick={() => toggle(id)}
                              >
                                <TableCell>
                                  {childCount > 0 ? (
                                    isOpen ? (
                                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                    ) : (
                                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                    )
                                  ) : null}
                                </TableCell>
                                <TableCell className="whitespace-nowrap font-mono font-medium">
                                  {r.readable_id || "—"}
                                  {childCount > 0 && (
                                    <span className="ml-1 text-[9.5px] text-muted-foreground">
                                      ({partners.length}p·{invoices.length}i)
                                    </span>
                                  )}
                                  <CommentersChip summary={commentSummaries?.get(r.readable_id ?? r.client_request_id ?? "")} />
                                </TableCell>
                                <TableCell className="max-w-[150px]">
                                  <div className="truncate font-medium">
                                    {(r.event_type || "—").replaceAll("_", " ").toLowerCase()}
                                  </div>
                                  <div className="cell-sub truncate">
                                    {r.country_iso_code} · {r.billing_entity}
                                  </div>
                                </TableCell>
                                <TableCell className="whitespace-nowrap">
                                  <div>{fmtDate(r.booking_created_at)}</div>
                                  <div className="cell-sub">
                                    {fmtDate(r.booking_date)}
                                    {r.end_date && r.end_date !== r.booking_date
                                      ? ` → ${fmtDateShort(r.end_date)}`
                                      : ""}
                                  </div>
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {r.days_since_booking ?? "—"}
                                </TableCell>
                                <TableCell className="whitespace-nowrap">
                                  {r.purchase_order_number ? (
                                    <>
                                      <div className="cell-mono">{r.purchase_order_number}</div>
                                      <div className="cell-sub">
                                        since {fmtDateShort(r.purchase_order_updated_at)}
                                      </div>
                                    </>
                                  ) : (
                                    <span className="cell-sub">—</span>
                                  )}
                                </TableCell>
                                <TableCell className="border-l-2 border-sky-200 bg-sky-50/40">
                                  <PaymentBadge status={inv} />
                                </TableCell>
                                <TableCell className="bg-sky-50/40 text-right tabular-nums">
                                  {fmtCurrency(r.client_reste_a_encaisser_ttc, r.currency)}
                                </TableCell>
                                <TableCell className="bg-sky-50/40">
                                  <PaymentBadge status={pay} />
                                </TableCell>
                                <TableCell className="border-l-2 border-indigo-200 bg-indigo-50/40">
                                  <PaymentBadge status={pay2} />
                                  {(() => {
                                    const b = partnerBreakdown(partners);
                                    if (b.fully + b.partial + b.notPaid === 0) return null;
                                    return (
                                      <div className="mt-1 flex gap-1 text-[10px]">
                                        {b.fully > 0 && <span className="rounded bg-emerald-100 px-1 text-emerald-800" title="Fully paid">{b.fully}✓</span>}
                                        {b.partial > 0 && <span className="rounded bg-sky-100 px-1 text-sky-800" title="Partially paid">{b.partial}½</span>}
                                        {b.notPaid > 0 && <span className="rounded bg-rose-100 px-1 text-rose-800" title="Not paid">{b.notPaid}✗</span>}
                                      </div>
                                    );
                                  })()}
                                </TableCell>
                                <TableCell className="bg-indigo-50/40">
                                  {(() => {
                                    const hasPo = !!(r.purchase_order_number && String(r.purchase_order_number).trim());
                                    const outreach = partnerOutreach(partners, r.readable_id ?? r.client_request_id ?? "", hasPo);
                                    return (
                                      <>
                                        {outreach ? (
                                          <span className={`pill ${outreach.cls}`}>
                                            {outreach.label}
                                          </span>
                                        ) : (
                                          <span className="cell-sub">—</span>
                                        )}
                                        <EventStickers
                                          eventRef={r.readable_id ?? r.client_request_id ?? ""}
                                          partners={partners}
                                          hasPo={Boolean(r.purchase_order_number)}
                                          factsMap={factsMap}
                                          actionFor={actionFor}
                                        />
                                      </>
                                    );
                                  })()}
                                </TableCell>
                                <TableCell className="bg-indigo-50/40 text-right tabular-nums">
                                  {fmtCurrency(r.partner_reste_a_decaisser_ttc, r.currency)}
                                </TableCell>
                              </TableRow>
                              {isOpen && (
                                <TableRow className="bg-slate-50/60 hover:bg-slate-50/60">
                                  <TableCell></TableCell>
                                  <TableCell colSpan={11} className="py-4">
                                    <EventDetails partners={partners} invoices={invoices} row={r} />
                                  </TableCell>
                                </TableRow>
                              )}
                            </Fragment>
                          );
                        })}
                      {!isLoading && filtered.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={12} className="py-12 text-center text-muted-foreground">
                            No rows match your filters.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="charts" className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Invoicing SLA status</CardTitle>
              </CardHeader>
              <CardContent style={{ height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={byInvoicingStatus} dataKey="value" nameKey="name" outerRadius={110} label>
                      {byInvoicingStatus.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Top event types</CardTitle>
              </CardHeader>
              <CardContent style={{ height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={byEventType} layout="vertical" margin={{ left: 20 }}>
                    <XAxis type="number" />
                    <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="value" fill="#6366f1" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="breached">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Items past SLA — {breached.length} events need action
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ref</TableHead>
                        <TableHead>Event</TableHead>
                        <TableHead>Partners</TableHead>
                        <TableHead>Issue</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {breached.map(({ row: r, partners, invoices }) => {
                        const pay = paymentStatus(r, invoices);
                        const inv = invoicingSla(r, invoices);
                        const pay2 = payoutSla(r, partners);
                        const issues: string[] = [];
                        if (inv.variant === "overdue") issues.push(`Invoicing ${inv.label}`);
                        if (pay.variant === "overdue") issues.push(`Receivable ${pay.label}`);
                        if (pay2.variant === "overdue") issues.push(`Payout ${pay2.label}`);
                        const amount =
                          pay.variant === "overdue"
                            ? r.client_reste_a_encaisser_ttc
                            : r.partner_reste_a_decaisser_ttc;
                        return (
                          <TableRow key={r.client_request_id ?? r.readable_id}>
                            <TableCell className="font-mono text-xs">{r.readable_id}</TableCell>
                            <TableCell>
                              <div className="font-medium">
                                {(r.event_type || "—").replaceAll("_", " ").toLowerCase()}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                booked {fmtDate(r.booking_created_at)}
                              </div>
                            </TableCell>
                            <TableCell className="text-xs">
                              {partners.map((p) => p.name).filter(Boolean).join(", ") || "—"}
                            </TableCell>
                            <TableCell className="space-x-1">
                              {issues.map((i) => (
                                <span
                                  key={i}
                                  className="pill bg-rose-100 text-rose-800"
                                >
                                  {i}
                                </span>
                              ))}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {fmtCurrency(amount, r.currency)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                      {breached.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} className="py-10 text-center text-emerald-700">
                            🎉 No SLA breaches in scope.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
      </Tabs>
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
  const { data: statusMap } = usePartnerStatuses();
  const { factsMap, actionFor } = useActionIndex();
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

                  const current: PartnerStatusValue =
                    derived ?? stored ?? "not_contacted";
                  const opt = PARTNER_STATUS_OPTIONS.find((o) => o.value === current)!;
                  const manualOptions = PARTNER_STATUS_OPTIONS.filter(
                    (o) => o.value === "not_contacted" || o.value === "waiting_bank",
                  );
                  return (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-1.5 font-medium">
                        {pname || "—"}
                        {p.is_cancelled && (
                          <span className="ml-1 text-[10px] text-muted-foreground">(cancelled)</span>
                        )}
                        <PartnerStickers
                          action={actionFor(eventRef, p, Boolean(row.purchase_order_number))}
                          facts={factsMap?.get(key)}
                          partner={p}
                        />
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
                          <span
                            className={`pill ${opt.cls}`}
                            title="Derived from amounts"
                          >
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
              First invoice emitted {fmtDate(firstActive.emission_date)} ·
              payment due {new Date(new Date(firstActive.emission_date).getTime() + 60 * 86_400_000)
                .toISOString()
                .slice(0, 10)} (60d)
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
        <EventComments eventRef={eventRef} />
      </div>
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

  const initials = (name?: string | null, email?: string | null) => {
    const src = (name || email || "?").trim();
    const parts = src.split(/\s+/);
    return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || src[0]?.toUpperCase() || "?";
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
          {isLoading && (
            <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>
          )}
          {!isLoading && (comments?.length ?? 0) === 0 && (
            <div className="px-3 py-3 text-xs text-muted-foreground">No comments yet.</div>
          )}
          {comments?.map((c) => (
            <div key={c.id} className="flex gap-3 px-3 py-2.5">
              {c.user_avatar_url ? (
                <img
                  src={c.user_avatar_url}
                  alt={c.user_name ?? c.user_email}
                  className="h-7 w-7 shrink-0 rounded-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-700">
                  {initials(c.user_name, c.user_email)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-slate-800">
                    {c.user_name || c.user_email}
                  </span>
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
          <div role="alert" className="border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            Comment not saved: {String((addComment.error as Error)?.message ?? addComment.error)}
          </div>
        )}
        {deleteComment.isError && (
          <div role="alert" className="border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            Comment not deleted: {String((deleteComment.error as Error)?.message ?? deleteComment.error)}
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
        <div className="mt-1 font-display text-[28px] font-bold leading-tight tracking-tight">{value}</div>
        {sub != null && (
          typeof sub === "string"
            ? <div className="text-xs text-muted-foreground">{sub}</div>
            : <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
        )}
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
                  <span className={`inline-flex h-5 min-w-[1.5rem] items-center justify-center rounded px-1.5 text-[11px] font-semibold ${accentBg} ${accentText}`}>
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
