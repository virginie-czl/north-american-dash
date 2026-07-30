import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SummaryStrip,
  useRegisterTrackerActions,
} from "@/components/tracker-chrome";
import { EventStickers, PartnerStickers } from "@/components/partner-fact-stickers";
import { PartnerEmails } from "@/components/partner-emails";
import { RequestInfoDialog, useRequestDialog } from "@/components/request-info-dialog";
import { buildTargets, needsOf, describeNeeds } from "@/lib/partner-requests";
import {
  NaCommissionRequestDialog,
  useNaCommissionRequestDialog,
  type NaCommissionTarget,
} from "@/components/na-commission-request-dialog";
import {
  partnerClawback,
  rowClawbackSplit,
  naContactFor,
  composeNaCommissionRequest,
  composeNaRefundRequest,
  composeNaCombinedRequest,
} from "@/lib/na-commission-requests";
import {
  fetchNaFinancialSummaries,
  generateNaFinancialSummary,
  type NaFinancialSummary,
} from "@/lib/na-financial-summary.functions";
import { partnerKey } from "@/lib/annotations.functions";
import { useActionIndex } from "@/lib/use-partner-actions";
import { useGmailConnection, useFactScan } from "@/lib/use-gmail";
import {
  useAddComment,
  useCommentSummaries,
  useCurrentUser,
  useDeleteComment,
  useEventComments,
  type EventCommentSummary,
} from "@/lib/use-annotations";
import { Fragment, useMemo, useState } from "react";
import { Mail } from "lucide-react";
import {
  getNaRows,
  parseNaPartners,
  sumPartners,
  type NaRow,
  type NaPartnerLine,
} from "@/lib/na.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user-avatar";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronDown, ChevronRight, RefreshCw, Lock, ArrowUpDown, MessageSquare, Banknote } from "lucide-react";

export const Route = createFileRoute("/_authenticated/tracking-north-america")({
  // Presentation aside, the data query refuses too (requireTracker).
  beforeLoad: ({ context }) => {
    const allowed = (context as { allowedTrackers?: string[] }).allowedTrackers ?? [];
    if (!allowed.includes("na")) {
      const fallback = allowed.includes("loreal")
        ? "/"
        : allowed.includes("veolia")
          ? "/veolia"
          : allowed.includes("na")
            ? "/tracking-north-america"
            : null;
      throw redirect(fallback ? { to: fallback } : { to: "/auth", search: { status: "no-tracker" } });
    }
  },
  head: () => ({
    meta: [
      { title: "Tracking North America" },
      { name: "description", content: "North America deals tracker — bookings and partner payouts." },
    ],
  }),
  component: NaPage,
});

const CCY_SYMBOL: Record<string, string> = {
  EUR: "€",
  USD: "$US",
  CAD: "$CA",
  GBP: "£",
};

function ccyLabel(ccy: string | null | undefined) {
  if (!ccy) return "";
  return CCY_SYMBOL[ccy] ?? ccy;
}

function fmtAmount(value: number | null | undefined) {
  if (value == null) return null;
  try {
    // Always two decimals: these figures get reconciled against the back office
    // and against partner invoices, where the cents matter.
    return new Intl.NumberFormat("fr-FR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return value.toFixed(2);
  }
}

function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  return v.slice(0, 10);
}

function abbrevPerson(name: string | null | undefined) {
  if (!name) return "";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const lastInitial = parts[parts.length - 1][0];
  return `${first} ${lastInitial}.`;
}

type MoneyKind = "neutral" | "danger" | "muted";

function Money({
  value,
  currency,
  showCcy = true,
  kind = "neutral",
  align = "right",
}: {
  value: number | null | undefined;
  currency: string | null | undefined;
  showCcy?: boolean;
  kind?: MoneyKind;
  align?: "right" | "left";
}) {
  const alignCls = align === "right" ? "justify-end text-right" : "justify-start text-left";
  const isEmpty = value == null;
  const isZero = !isEmpty && Math.abs(value) < 0.005;
  if (isEmpty) {
    return <span className={`block tabular-nums text-text-muted ${alignCls}`}>—</span>;
  }
  const formatted = fmtAmount(value);
  const dangerCls =
    kind === "danger" && !isZero
      ? value < 0
        ? "text-emerald-600 font-medium"
        : "text-text-danger font-medium"
      : "";
  const mutedCls = kind === "muted" ? "text-text-secondary" : "";
  const emptyCls = isZero ? "text-text-muted" : "text-text-primary";
  return (
    <span className={`inline-flex items-baseline gap-1 tabular-nums ${alignCls} ${dangerCls || mutedCls || emptyCls}`}>
      <span>{formatted}</span>
      {showCcy && currency && (
        <span className="text-[10px] text-text-muted">{ccyLabel(currency)}</span>
      )}
    </span>
  );
}

function MultiMoney({
  map,
  field,
  kind = "neutral",
}: {
  map: Map<string, { gmv: number; paid: number; outstanding: number; payable: number; payableToDate: number; commission: number }>;
  field: "gmv" | "paid" | "outstanding" | "payable" | "payableToDate" | "commission";
  kind?: MoneyKind;
}) {
  const entries = Array.from(map.entries()).filter(([, v]) => Math.abs(v[field]) > 0.005);
  if (entries.length === 0) {
    return <span className="block text-right tabular-nums text-text-muted">—</span>;
  }
  return (
    <span className="flex flex-col items-end gap-0.5 tabular-nums">
      {entries.map(([c, v]) => (
        <Money key={c} value={v[field]} currency={c} kind={kind} />
      ))}
    </span>
  );
}


type SortKey =
  | "start_date"
  | "readable_id"
  | "company_name"
  | "sales_referent"
  | "em_referent"
  | "days_before_start"
  | "gmv_client_ccy"
  | "invoiced_ccy"
  | "paid_ccy"
  | "balance_ccy"
  | "status";

function partnerToBePaidTotals(
  totals: Map<string, { gmv: number; paid: number; outstanding: number; payable: number; payableToDate: number; commission: number }>,
  partners: Array<{ payment_method: string | null; is_provision: boolean | null; currency: string | null; outstanding: number | null }>,
): Map<string, number> {
  // sumPartners already excludes provisions. Also subtract virtual-card legs.
  const out = new Map<string, number>();
  for (const [c, v] of totals) {
    if (v.outstanding > 0.01) out.set(c, v.outstanding);
  }
  for (const p of partners) {
    if (p.is_provision) continue;
    if ((p.payment_method ?? "").toUpperCase() !== "CREDIT_CARD") continue;
    const c = p.currency ?? "—";
    const cur = out.get(c);
    if (cur == null) continue;
    const remain = cur - (p.outstanding ?? 0);
    if (remain > 0.01) out.set(c, remain);
    else out.delete(c);
  }
  return out;
}

function rowPartnerToPay(row: NaRow, partners: ReturnType<typeof parseNaPartners>): Map<string, number> {
  const clientBal = row.balance_ccy ?? 0;
  if (clientBal > 0.01) return new Map();
  const totals = sumPartners(partners);
  return partnerToBePaidTotals(totals, partners);
}

// partnerClawback / rowClawbackSplit moved to na-commission-requests.ts —
// the commission/refund request emails need the same math.

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportCsv(rows: Array<{ row: NaRow; partners: ReturnType<typeof parseNaPartners> }>) {
  const headers = [
    "Start date",
    "End date",
    "Booking",
    "Company",
    "Billing entity",
    "Event name",
    "Event type",
    "Sales",
    "EM",
    "Days before start",
    "Client currency",
    "Client GMV",
    "Client invoiced",
    "Client paid",
    "Client outstanding",
    "Partner name",
    "Partner email",
    "Partner currency",
    "Partner GMV",
    "Partner payable (event)",
    "Partner payable to date",
    "Partner paid",
    "Partner outstanding",
    "Commission to recover",
    "Refund to ask",
    "Partner locked by admin",
    "Partner locked by client",
  ];
  const lines: string[] = [headers.join(",")];
  for (const { row, partners } of rows) {
    const base = [
      row.start_date ?? "",
      row.end_date ?? "",
      row.readable_id ?? "",
      row.company_name ?? "",
      row.billing_entity ?? "",
      row.event_name ?? "",
      row.event_type ?? "",
      row.sales_referent ?? "",
      row.em_referent ?? "",
      row.days_before_start ?? "",
      row.currency_client ?? "",
      row.gmv_client_ccy ?? "",
      row.invoiced_ccy ?? "",
      row.paid_ccy ?? "",
      row.balance_ccy ?? "",
    ];
    if (partners.length === 0) {
      lines.push([...base, "", "", "", "", "", "", "", "", "", "", ""].map(csvEscape).join(","));
    } else {
      for (const p of partners) {
        const cb = partnerClawback(p);
        lines.push(
          [
            ...base,
            p.name ?? "",
            p.email ?? "",
            p.currency ?? "",
            p.gmv_ttc ?? "",
            p.payable ?? "",
            p.payable_to_date ?? "",
            p.paid ?? "",
            p.outstanding ?? "",
            cb.commission > 0.01 ? cb.commission.toFixed(2) : "",
            cb.refund > 0.01 ? cb.refund.toFixed(2) : "",
            p.locked_by_admin ? "yes" : "",
            p.locked_by_client ? "yes" : "",
          ]
            .map(csvEscape)
            .join(","),
        );
      }
    }
  }
  downloadCsv(lines, `tracking-north-america-${new Date().toISOString().slice(0, 10)}.csv`);
}

function downloadCsv(lines: string[], filename: string) {
  const csv = "\uFEFF" + lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportRecoverCsv(rows: Array<{ row: NaRow; partners: ReturnType<typeof parseNaPartners> }>) {
  const headers = [
    "Start date",
    "Booking",
    "Company",
    "Billing entity",
    "Event name",
    "Sales",
    "EM",
    "Partner name",
    "Partner email",
    "Currency",
    "Commission to recover",
    "Refund to ask",
    "Total to recover",
  ];
  const lines: string[] = [headers.join(",")];
  for (const { row, partners } of rows) {
    for (const p of partners) {
      const cb = partnerClawback(p);
      if (cb.commission < 0.01 && cb.refund < 0.01) continue;
      lines.push(
        [
          row.start_date ?? "",
          row.readable_id ?? "",
          row.company_name ?? "",
          row.billing_entity ?? "",
          row.event_name ?? "",
          row.sales_referent ?? "",
          row.em_referent ?? "",
          p.name ?? "",
          p.email ?? "",
          p.currency ?? "",
          cb.commission > 0.01 ? cb.commission.toFixed(2) : "",
          cb.refund > 0.01 ? cb.refund.toFixed(2) : "",
          (cb.commission + cb.refund).toFixed(2),
        ]
          .map(csvEscape)
          .join(","),
      );
    }
  }
  downloadCsv(lines, `na-to-recover-${new Date().toISOString().slice(0, 10)}.csv`);
}

function NaPage() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["na-rows"],
    queryFn: () => getNaRows(),
    staleTime: 60_000,
  });

  const [search, setSearch] = useState("");
  const [eventType, setEventType] = useState<string>("all");
  const [sales, setSales] = useState<string>("all");
  const [em, setEm] = useState<string>("all");
  const [ccy, setCcy] = useState<string>("all");
  const [billing, setBilling] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showAncient, setShowAncient] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("start_date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const rows = useMemo(() => data ?? [], [data]);
  const { data: commentSummaries } = useCommentSummaries();

  const decorated = useMemo(
    () => rows.map((r) => ({ row: r, partners: parseNaPartners(r.partners_json) })),
    [rows],
  );

  const uniq = (fn: (r: NaRow) => string | null | undefined) => {
    const s = new Set<string>();
    rows.forEach((r) => {
      const v = fn(r);
      if (v && v.trim()) s.add(v.trim());
    });
    return Array.from(s).sort();
  };
  const eventTypes = useMemo(() => uniq((r) => r.event_type), [rows]);
  const salesList = useMemo(() => uniq((r) => r.sales_referent), [rows]);
  const emList = useMemo(() => uniq((r) => r.em_referent), [rows]);
  const ccyList = useMemo(() => uniq((r) => r.currency_client), [rows]);
  const billingList = useMemo(() => uniq((r) => r.billing_entity), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const cutoff = Date.now() - 100 * 24 * 3600 * 1000;
    return decorated.filter(({ row, partners }) => {
      const company = (row.company_name ?? "").toLowerCase();
      if (/l['’ ]?or[eé]al|veolia/.test(company)) return false;
      if (!showAncient && row.start_date) {
        const t = Date.parse(row.start_date);
        if (!Number.isNaN(t) && t < cutoff) return false;
      }
      if (eventType !== "all" && (row.event_type ?? "") !== eventType) return false;
      if (sales !== "all" && (row.sales_referent ?? "") !== sales) return false;
      if (em !== "all" && (row.em_referent ?? "") !== em) return false;
      if (ccy !== "all" && (row.currency_client ?? "") !== ccy) return false;
      if (billing.size > 0 && !billing.has((row.billing_entity ?? "").trim())) return false;
      if (statusFilter !== "all") {
        const owed = rowPartnerToPay(row, partners).size > 0;
        const split = rowClawbackSplit(partners);
        const hasCommission = split.commission.size > 0;
        const hasRefund = split.refund.size > 0;
        if (statusFilter === "partner_to_pay" && !owed) return false;
        if (statusFilter === "commission" && !hasCommission) return false;
        if (statusFilter === "refund" && !hasRefund) return false;
        if (statusFilter === "none" && (owed || hasCommission || hasRefund)) return false;
      }
      if (!q) return true;
      const hay = [
        row.readable_id,
        row.company_name,
        row.event_name,
        row.sales_referent,
        row.em_referent,
        row.billing_entity,
        ...partners.map((p) => p.name ?? ""),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [decorated, search, eventType, sales, em, ccy, billing, statusFilter, showAncient]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      if (sortKey === "status") {
        const av = Array.from(rowPartnerToPay(a.row, a.partners).values()).reduce((s, v) => s + v, 0);
        const bv = Array.from(rowPartnerToPay(b.row, b.partners).values()).reduce((s, v) => s + v, 0);
        return (av - bv) * dir;
      }
      const av = a.row[sortKey as Exclude<SortKey, "status">] as unknown;
      const bv = b.row[sortKey as Exclude<SortKey, "status">] as unknown;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  }

  const totals = useMemo(() => {
    let clients = 0;
    let partnerLines = 0;
    filtered.forEach(({ partners }) => (partnerLines += partners.length));
    clients = filtered.length;
    return { clients, partnerLines };
  }, [filtered]);

  const recoverCount = useMemo(
    () =>
      sorted.reduce(
        (n, { partners }) =>
          n +
          partners.reduce((m, p) => {
            const cb = partnerClawback(p);
            return m + (cb.commission > 0.01 || cb.refund > 0.01 ? 1 : 0);
          }, 0),
        0,
      ),
    [sorted],
  );

  const { factsMap, actionFor, eventNeedsScan } = useActionIndex();
  const { data: gmailConnection } = useGmailConnection();
  const { progress: scanProgress, start: startScan } = useFactScan();
  const requestDialog = useRequestDialog();
  const commissionRefundDialog = useNaCommissionRequestDialog();
  const queryClient = useQueryClient();

  const { data: financialSummaries } = useQuery({
    queryKey: ["na-financial-summaries"],
    queryFn: async () => {
      const rows = await fetchNaFinancialSummaries();
      const map = new Map<string, NaFinancialSummary>();
      for (const r of rows) map.set(`${r.event_ref}::${r.partner_key}`, r);
      return map;
    },
    staleTime: 60_000,
  });

  const summarize = useMutation({
    mutationFn: (input: { event_ref: string; partner_name: string; partner_email: string | null }) =>
      generateNaFinancialSummary({ data: input }),
    onSuccess: (result) => {
      queryClient.setQueryData<Map<string, NaFinancialSummary>>(
        ["na-financial-summaries"],
        (prev) => {
          const next = new Map(prev ?? []);
          next.set(`${result.event_ref}::${result.partner_key}`, result);
          return next;
        },
      );
    },
  });

  const incompleteTargets = useMemo(
    () =>
      buildTargets(
        sorted.flatMap(({ row: r, partners: ps }) => {
          const ref = r.readable_id ?? "";
          return ps
            // Overpaid partners are a commission-to-recover / refund case, not a
            // bank-or-tax gap — asking them to send bank details makes no sense
            // when we already paid them too much.
            .filter((p) => !p.is_provision)
            .filter((p) => {
              const cb = partnerClawback(p);
              return cb.commission < 0.01 && cb.refund < 0.01;
            })
            .map((p) => {
              const a = actionFor(ref, { name: p.name, email: p.email, amount_due: p.outstanding, vat_raw: null, tax_identifier: null, country: null, cardOnThisEvent: p.payment_method === "CREDIT_CARD" ? "accepted" : undefined }, true, { taxTracked: false });
              return { eventRef: ref, eventDate: r.start_date ?? null, name: p.name, email: p.email, country: null, currency: p.currency, amountDue: p.outstanding, action: a, isCancelled: p.is_provision, eventClientLabel: r.company_name ?? undefined };
            });
        }),
      ),
    [sorted, actionFor],
  );

  // Overpaid partners: ask for whichever applies — the commission we're owed,
  // a refund beyond that, or both. One email per partner, never combined
  // across different partners on the same booking — a booking can have
  // several unrelated vendors, and a venue should never see a caterer's figures.
  const commissionRefundTargets = useMemo<NaCommissionTarget[]>(() => {
    const targets: NaCommissionTarget[] = [];
    for (const { row: r, partners: ps } of sorted) {
      const eventRef = r.readable_id ?? "";
      for (const p of ps) {
        if (p.is_provision) continue;
        const cb = partnerClawback(p);
        if (cb.commission <= 0.01 && cb.refund <= 0.01) continue;

        const contact = naContactFor(p);
        if (!contact.address) continue;

        if (cb.commission > 0.01 && cb.refund > 0.01) {
          const combined = composeNaCombinedRequest(r, p, contact);
          if (combined) {
            targets.push({ eventRef, partnerName: p.name, address: contact.address, contactName: contact.name, ...combined, mode: "combined" });
          }
        } else if (cb.commission > 0.01) {
          const commission = composeNaCommissionRequest(r, p, contact);
          if (commission) {
            targets.push({ eventRef, partnerName: p.name, address: contact.address, contactName: contact.name, ...commission, mode: "commission" });
          }
        } else {
          const refund = composeNaRefundRequest(r, p, contact);
          if (refund) {
            targets.push({ eventRef, partnerName: p.name, address: contact.address, contactName: contact.name, ...refund, mode: "refund" });
          }
        }
      }
    }
    return targets;
  }, [sorted]);

  useRegisterTrackerActions(
    {
      onRefresh: () => refetch(),
      isFetching,
      exports: [
        { label: "Export CSV", onClick: () => exportCsv(sorted), disabled: sorted.length === 0 },
        {
          label: "Export to recover",
          onClick: () => exportRecoverCsv(sorted),
          disabled: recoverCount === 0,
        },
      ],
    },
    [isFetching, sorted.length, recoverCount],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <SummaryStrip
        title="Marketplace North America"
        stats={[
          { label: "Bookings", value: isLoading ? "…" : String(totals.clients) },
          { label: "Partner lines", value: isLoading ? "…" : String(totals.partnerLines) },
          { label: "Sales referents", value: String(salesList.length) },
          { label: "Currencies", value: String(ccyList.length) },
        ]}
        alert={recoverCount > 0 ? `${recoverCount} to recover` : null}
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi title="Bookings" value={totals.clients.toString()} />
          <Kpi title="Partner lines" value={totals.partnerLines.toString()} />
          <Kpi title="Sales referents" value={salesList.length.toString()} />
          <Kpi title="Currencies" value={ccyList.length.toString()} />
        </div>
      </SummaryStrip>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-none border-b border-border px-5 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mr-auto text-sm font-semibold">Deals</h2>
              <Input
                placeholder="Search booking, company, partner…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-64"
              />
              <FilterSelect label="Type" value={eventType} onChange={setEventType} options={eventTypes} />
              <FilterSelect label="Sales" value={sales} onChange={setSales} options={salesList} />
              <FilterSelect label="EM" value={em} onChange={setEm} options={emList} />
              <FilterSelect label="Ccy" value={ccy} onChange={setCcy} options={ccyList} />
              <MultiFilter
                label="Billing entity"
                selected={billing}
                options={billingList}
                onToggle={(v: string) =>
                  setBilling((prev) => {
                    const n = new Set(prev);
                    if (n.has(v)) n.delete(v);
                    else n.add(v);
                    return n;
                  })
                }
                onClear={() => setBilling(new Set())}
              />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Status: All</SelectItem>
                  <SelectItem value="partner_to_pay">Partner to be paid</SelectItem>
                  <SelectItem value="commission">Commission to recover</SelectItem>
                  <SelectItem value="refund">Refund to ask</SelectItem>
                  <SelectItem value="none">No action</SelectItem>
                </SelectContent>
              </Select>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showAncient}
                  onChange={(e) => setShowAncient(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-input"
                />
                Include bookings &gt; 100d old
              </label>
            </div>
          </div>
          {(gmailConnection?.connected || gmailConnection?.connected === false) && (
            <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border px-5 py-2">
              {gmailConnection.connected ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5"
                    disabled={scanProgress.running || sorted.length === 0}
                    onClick={() =>
                      startScan(
                        sorted
                          .filter(({ row: r, partners: ps }) =>
                            eventNeedsScan(r.readable_id ?? "", ps.map((p) => ({ name: p.name, email: p.email, amount_due: p.outstanding, vat_raw: null, tax_identifier: null, country: null, is_cancelled: p.is_provision, cardOnThisEvent: p.payment_method === "CREDIT_CARD" ? "accepted" : undefined })), true, { taxTracked: false })
                          )
                          .map(({ row: r, partners: ps }) => ({
                            event_ref: r.readable_id ?? "",
                            partners: ps.filter((p) => !p.is_provision).map((p) => ({ name: p.name ?? "", email: p.email })),
                          })),
                      )
                    }
                  >
                    <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                    {scanProgress.running ? `Searching… ${scanProgress.done}/${scanProgress.total}` : "Search my emails"}
                  </Button>
                  {incompleteTargets.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5"
                      onClick={() => requestDialog.open(incompleteTargets)}
                    >
                      <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                      Request missing info ({incompleteTargets.length})
                    </Button>
                  )}
                  {commissionRefundTargets.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5"
                      onClick={() => commissionRefundDialog.open(commissionRefundTargets)}
                    >
                      <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                      Request commission / refund ({commissionRefundTargets.length})
                    </Button>
                  )}
                </>
              ) : (
                <button type="button" onClick={() => { window.location.href = "/api/gmail/connect"; }} className="text-[11.5px] text-slate-600 underline-offset-2 hover:underline">
                  Connect Gmail
                </button>
              )}
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col">
            {isLoading && <div className="p-6 text-sm text-muted-foreground">Loading…</div>}
            {error && (
              <div role="alert" className="p-6 text-sm text-destructive">
                Failed to load data: {(error as Error).message}
              </div>
            )}
            {!isLoading && !error && (
              <div className="sla-scroll px-2">
                <table className="na-table w-full border-collapse text-[12px]">
                  <thead>
                    <tr className="na-group-row">
                      <th className="na-group na-group-event" colSpan={6}>Deal</th>
                      <th className="na-group na-group-client na-col-client" colSpan={4}>Client</th>
                      <th className="na-group na-group-partner na-col-partner" colSpan={4}>Partner</th>
                      <th className="na-group" colSpan={1}>Status</th>
                    </tr>
                    <tr className="na-head-row">
                      <th className="na-cell w-8"></th>
                      <SortTh label="Start" k="start_date" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <SortTh label="Booking" k="readable_id" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <SortTh label="Company / Event" k="company_name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <SortTh label="Sales / EM" k="sales_referent" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <SortTh label="Days" k="days_before_start" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                      <SortTh label="GMV" k="gmv_client_ccy" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" className="na-col-client" />
                      <SortTh label="Invoiced" k="invoiced_ccy" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" className="na-col-client" />
                      <SortTh label="Paid" k="paid_ccy" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" className="na-col-client" />
                      <SortTh label="Outstanding" k="balance_ccy" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" className="na-col-client" />
                      <th className="na-cell na-col-partner text-right">GMV</th>
                      <th className="na-cell na-col-partner text-right">Payable</th>
                      <th className="na-cell na-col-partner text-right">Paid</th>
                      <th className="na-cell na-col-partner text-right">Outstanding</th>
                      <SortTh label="Status" k="status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    </tr>

                  </thead>
                  <tbody>
                    {sorted.map(({ row, partners }, idx) => {
                      const id = row.readable_id ?? "";
                      const isOpen = expanded.has(id);
                      const totals = sumPartners(partners);
                      const zebra = idx % 2 === 1;
                      const ccyClient = row.currency_client;
                      const anyLockedAdmin = partners.some((p) => p.locked_by_admin);
                      const anyLockedClient = partners.some((p) => p.locked_by_client);
                      const anyLocked = partners.some((p) => p.locked);
                      const clawSplit = rowClawbackSplit(partners);
                      return (
                        <Fragment key={id}>
                          <tr
                            className={`na-body-row cursor-pointer ${zebra ? "na-zebra" : ""}`}
                            onClick={() => toggle(id)}
                          >
                            <td className="na-cell">
                              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </td>
                            <td className="na-cell whitespace-nowrap text-text-secondary">{fmtDate(row.start_date)}</td>
                            <td className="na-cell font-mono text-xs">
                              {row.booking_url ? (
                                <a
                                  href={row.booking_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-primary hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {row.readable_id}
                                </a>
                              ) : (
                                row.readable_id
                              )}
                              {ccyClient && (
                                <div className="mt-1 inline-flex rounded border border-border px-1.5 py-0 text-[10px] font-medium text-text-muted">
                                  {ccyLabel(ccyClient)}
                                </div>
                              )}
                              <CommentersChip summary={commentSummaries?.get(id)} />
                              <EventStickers
                                eventRef={id}
                                partners={partners.map((p) => ({ name: p.name, email: p.email, amount_due: p.outstanding, vat_raw: null, tax_identifier: null, country: null, is_cancelled: p.is_provision, cardOnThisEvent: p.payment_method === "CREDIT_CARD" ? "accepted" : undefined }))}
                                hasPo={true}
                                factsMap={factsMap}
                                actionFor={(ref, partner, hasPo) => actionFor(ref, partner, hasPo, { taxTracked: false })}
                                hideTax
                                hideCardPending
                              />
                            </td>
                            <td className="na-cell">
                              <div className="flex items-center gap-2 flex-wrap">
                                <div className="min-w-0">
                                  <div className="truncate font-medium text-text-primary">{row.company_name ?? "—"}</div>
                                  {row.billing_entity && (
                                    <div className="truncate text-[11px] text-text-muted">{row.billing_entity}</div>
                                  )}
                                </div>
                                <LockChip
                                  locked={anyLocked}
                                  admin={anyLockedAdmin}
                                  client={anyLockedClient}
                                  em={row.em_referent}
                                />
                              </div>
                            </td>
                            <td className="na-cell whitespace-nowrap">
                              <div className="text-text-secondary">{abbrevPerson(row.sales_referent) || "—"}</div>
                              <div className="text-[11px] text-text-muted">{abbrevPerson(row.em_referent) || "—"}</div>
                            </td>
                            <td className="na-cell text-right text-text-secondary">
                              {row.days_before_start ?? <span className="text-text-muted">—</span>}
                            </td>
                            <td className="na-cell na-col-client text-right">
                              <Money value={row.gmv_client_ccy} currency={ccyClient} />
                            </td>
                            <td className="na-cell na-col-client text-right">
                              <Money value={row.invoiced_ccy} currency={ccyClient} />
                            </td>
                            <td className="na-cell na-col-client text-right">
                              <Money value={row.paid_ccy} currency={ccyClient} />
                            </td>
                            <td className="na-cell na-col-client text-right">
                              <Money value={row.balance_ccy} currency={ccyClient} kind="danger" />
                            </td>
                            <td className="na-cell na-col-partner text-right">
                              <MultiMoney map={totals} field="gmv" />
                            </td>
                            <td className="na-cell na-col-partner text-right">
                              <MultiMoney map={totals} field="payable" />
                            </td>
                            <td className="na-cell na-col-partner text-right">
                              <MultiMoney map={totals} field="paid" />
                            </td>
                            <td className="na-cell na-col-partner text-right">
                              <PartnerOutstandingCell partners={partners} totals={totals} />
                            </td>
                            <td className="na-cell">
                              <StatusCell owed={rowPartnerToPay(row, partners)} commission={clawSplit.commission} refund={clawSplit.refund} />
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="na-drawer-row">
                              <td colSpan={15} className="p-0">
                                <div className="na-drawer-wrap">
                                  <PartnerSectionCard
                                    id={id}
                                    partners={partners}
                                    totals={totals}
                                    actionFor={actionFor}
                                    factsMap={factsMap}
                                    financialSummaries={financialSummaries}
                                    gmailConnected={gmailConnection?.connected === true}
                                    onSummarize={(input) => summarize.mutate(input)}
                                    summarizing={summarize.isPending ? summarize.variables : null}
                                  />
                                  {gmailConnection?.connected && (
                                    <div className="mt-4">
                                      <PartnerEmails
                                        eventRef={id}
                                        partners={partners
                                          .filter((p) => !p.is_provision && p.email)
                                          .map((p) => ({
                                            name: p.name,
                                            email: p.email,
                                            owed: p.outstanding != null
                                              ? `${p.outstanding.toLocaleString("en-CA", { minimumFractionDigits: 2 })} ${p.currency ?? ""}`
                                              : null,
                                          }))}
                                      />
                                    </div>
                                  )}
                                  <div className="mt-4">
                                    <CommentsSectionCard eventRef={id} />
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {sorted.length === 0 && (
                      <tr>
                        <td colSpan={15} className="na-cell text-center text-sm text-text-muted py-8">
                          No bookings match the current filters.
                        </td>
                      </tr>
                    )}

                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      {requestDialog.targets && (
        <RequestInfoDialog targets={requestDialog.targets} onClose={requestDialog.close} />
      )}
      {commissionRefundDialog.targets && (
        <NaCommissionRequestDialog
          targets={commissionRefundDialog.targets}
          onClose={commissionRefundDialog.close}
        />
      )}
    </div>
  );
}

function Kpi({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}

function MultiFilter({
  label,
  selected,
  options,
  onToggle,
  onClear,
}: {
  label: string;
  selected: Set<string>;
  options: string[];
  onToggle: (v: string) => void;
  onClear: () => void;
}) {
  const count = selected.size;
  const summary = count === 0 ? `${label}: All` : count === 1 ? `${label}: ${[...selected][0]}` : `${label}: ${count}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 justify-between gap-2 min-w-[160px]">
          <span className="truncate">{summary}</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          {count > 0 && (
            <button type="button" onClick={onClear} className="text-xs text-primary hover:underline">
              Clear
            </button>
          )}
        </div>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {options.length === 0 && (
            <div className="px-1 py-2 text-xs text-muted-foreground">No values available.</div>
          )}
          {options.map((o) => (
            <label
              key={o}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
            >
              <Checkbox checked={selected.has(o)} onCheckedChange={() => onToggle(o)} />
              <span className="truncate">{o}</span>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}


function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[140px]">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{label}: All</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SortHead({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
  align = "left",
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sortKey === k;
  return (
    <TableHead className={align === "right" ? "text-right" : ""}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 ${active ? "text-foreground" : "text-muted-foreground"} hover:text-foreground`}
      >
        {label}
        <ArrowUpDown className="h-3 w-3" />
        {active && <span className="text-[10px]">{sortDir === "asc" ? "↑" : "↓"}</span>}
      </button>
    </TableHead>
  );

}

function SortTh({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
  align = "left",
  className = "",
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sortKey === k;
  const alignCls = align === "right" ? "text-right" : "text-left";
  return (
    <th className={`na-cell ${alignCls} ${className}`}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide ${
          active ? "text-text-primary" : "text-text-muted"
        } hover:text-text-primary`}
      >
        {label}
        <ArrowUpDown className="h-3 w-3" />
        {active && <span className="text-[10px]">{sortDir === "asc" ? "↑" : "↓"}</span>}
      </button>
    </th>
  );
}

function LockChip({
  locked,
  admin,
  client,
  em,
}: {
  locked: boolean;
  admin: boolean;
  client: boolean;
  em?: string | null;
}) {
  if (!locked) {
    const emName = (em ?? "").trim();
    const askEm = emName && !/support/i.test(emName);
    if (askEm) {
      return <span className="na-pill na-pill-orange">Not locked · Ask EM</span>;
    }
    return <span className="na-pill na-pill-red">Not locked</span>;
  }
  const label = admin ? "Locked · admin" : client ? "Locked · client" : "Locked";
  return (
    <span className="na-pill na-pill-green">
      <Lock className="h-2.5 w-2.5" /> {label}
    </span>
  );
}

function PartnerLockBadge({ admin, client }: { admin: boolean; client: boolean }) {
  if (!admin && !client) return null;
  const label = admin ? "Locked · admin" : "Locked · client";
  return (
    <span className="na-pill na-pill-green ml-2">
      <Lock className="h-2.5 w-2.5" /> {label}
    </span>
  );
}

function ProvisionPill() {
  return <span className="na-pill na-pill-lavender ml-2">Provision</span>;
}

function PartnerOutstandingCell({
  partners,
  totals,
}: {
  partners: ReturnType<typeof parseNaPartners>;
  totals: ReturnType<typeof sumPartners>;
}) {
  const nonProvOutstanding = Array.from(totals.values()).reduce(
    (s, v) => s + Math.abs(v.outstanding),
    0,
  );
  const provOutstanding = partners
    .filter((p) => p.is_provision)
    .reduce((s, p) => s + Math.abs(p.outstanding ?? 0), 0);
  const provOnly = nonProvOutstanding < 0.005 && provOutstanding >= 0.005;
  if (provOnly) {
    // Build a per-currency map for provision outstanding
    const map = new Map<string, { gmv: number; paid: number; outstanding: number; payable: number; payableToDate: number; commission: number }>();
    for (const p of partners) {
      if (!p.is_provision) continue;
      const c = p.currency ?? "—";
      const cur = map.get(c) ?? { gmv: 0, paid: 0, outstanding: 0, payable: 0, payableToDate: 0, commission: 0 };
      cur.outstanding += p.outstanding ?? 0;
      map.set(c, cur);
    }
    return (
      <span className="flex flex-col items-end gap-1">
        <MultiMoney map={map} field="outstanding" />
        <span className="na-pill na-pill-lavender">Provision only</span>
      </span>
    );
  }
  return <MultiMoney map={totals} field="outstanding" kind="danger" />;
}

function StatusCell({ owed, commission, refund }: { owed: Map<string, number>; commission: Map<string, number>; refund: Map<string, number> }) {
  const fmt = (m: Map<string, number>) =>
    Array.from(m.entries()).map(([c, v]) => `${fmtAmount(v)} ${ccyLabel(c)}`).join(" · ");
  if (owed.size === 0 && commission.size === 0 && refund.size === 0) {
    return <span className="text-text-muted">—</span>;
  }
  return (
    <span className="flex flex-col items-start gap-1">
      {owed.size > 0 && (
        <span className="na-pill na-pill-green inline-flex items-center gap-1 whitespace-nowrap" title="Client paid — partner outstanding">
          <Banknote className="h-3 w-3" />
          Partner to be paid · {fmt(owed)}
        </span>
      )}
      {commission.size > 0 && (
        <span className="na-pill na-pill-amber inline-flex items-center gap-1 whitespace-nowrap" title="Commission fronted to partner — to recover">
          <Banknote className="h-3 w-3" />
          Commission to recover · {fmt(commission)}
        </span>
      )}
      {refund.size > 0 && (
        <span className="na-pill na-pill-red inline-flex items-center gap-1 whitespace-nowrap" title="Partner over-refunded beyond commission — refund to ask">
          <Banknote className="h-3 w-3" />
          Refund to ask · {fmt(refund)}
        </span>
      )}
    </span>
  );
}


function PartnerSectionCard({
  id,
  partners,
  totals,
  actionFor,
  factsMap,
  financialSummaries,
  gmailConnected,
  onSummarize,
  summarizing,
}: {
  id: string;
  partners: ReturnType<typeof parseNaPartners>;
  totals: ReturnType<typeof sumPartners>;
  actionFor: ReturnType<typeof useActionIndex>["actionFor"];
  factsMap: ReturnType<typeof useActionIndex>["factsMap"];
  financialSummaries: Map<string, NaFinancialSummary> | undefined;
  gmailConnected: boolean;
  onSummarize: (input: { event_ref: string; partner_name: string; partner_email: string | null }) => void;
  summarizing: { event_ref: string; partner_name: string; partner_email: string | null } | null;
}) {
  const payableCount = partners.filter((p) => !p.is_provision).length;
  const provisionCount = partners.filter((p) => p.is_provision).length;
  const caption =
    provisionCount > 0
      ? `${payableCount} partner${payableCount === 1 ? "" : "s"} payable · ${provisionCount} provision leg${provisionCount === 1 ? "" : "s"} excluded`
      : `${payableCount} partner${payableCount === 1 ? "" : "s"} payable`;
  return (
    <section className="na-section-card na-section-card-partner">

      <header className="na-section-head">
        <span aria-hidden>👥</span>
        <span>Partners</span>
        <span className="text-text-muted">({partners.length})</span>
      </header>
      <table className="na-sub-table">
        <thead>
          <tr>
            <th>Partner</th>
            <th className="text-right">GMV</th>
            <th className="text-right">Commission</th>
            <th className="text-right" title="Whole event: gross less commission">
              Payable (event)
            </th>
            <th className="text-right" title="Invoiced to the client for this partner, less commission — what is owed right now">
              Payable to date
            </th>
            <th className="text-right">Paid</th>
            <th className="text-right">Outstanding</th>
          </tr>
        </thead>
        <tbody>
          {partners.map((p, i) => {
            const prov = !!p.is_provision;
            return (
              <tr key={`${id}-p-${i}`} className={prov ? "na-sub-provision" : ""}>
                <td>
                  <div className="flex items-center flex-wrap gap-1">
                    <span className="font-medium text-text-primary">{p.name ?? "—"}</span>
                    <PartnerLockBadge admin={!!p.locked_by_admin} client={!!p.locked_by_client} />
                    {prov && <ProvisionPill />}
                    {p.payment_method === "CREDIT_CARD" && (
                      <span className="na-pill na-pill-lavender">Virtual card</span>
                    )}
                  </div>
                  {p.email && (
                    <a
                      href={`mailto:${p.email}`}
                      className="mt-0.5 block text-[11px] text-text-muted hover:text-text-primary hover:underline"
                    >
                      {p.email}
                    </a>
                  )}
                  {!prov && (
                    <>
                      <PartnerStickers
                        action={actionFor(id, { name: p.name, email: p.email, amount_due: p.outstanding, vat_raw: null, tax_identifier: null, country: null, cardOnThisEvent: p.payment_method === "CREDIT_CARD" ? "accepted" : undefined }, true, { taxTracked: false })}
                        facts={factsMap?.get(`${id}::${(p.name ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`)}
                        partner={{ name: p.name, email: p.email, amount_due: p.outstanding, vat_raw: null, tax_identifier: null, country: null }}
                        hideTax
                        hideCardPending
                      />
                      {gmailConnected && (
                        <NaFinancialSummaryBox
                          existing={financialSummaries?.get(`${id}::${partnerKey(p.name ?? p.email ?? "")}`)}
                          loading={
                            summarizing?.event_ref === id &&
                            summarizing?.partner_name === (p.name ?? p.email ?? "")
                          }
                          onSummarize={() =>
                            onSummarize({
                              event_ref: id,
                              partner_name: p.name ?? p.email ?? "",
                              partner_email: p.email,
                            })
                          }
                        />
                      )}
                    </>
                  )}
                </td>
                <td className="text-right">
                  {prov ? <span className="text-text-muted">—</span> : <Money value={p.gmv_ttc} currency={p.currency} />}
                </td>
                <td className="text-right text-text-secondary">
                  {prov || p.commission == null ? <span className="text-text-muted">—</span> : <Money value={p.commission} currency={p.currency} kind="muted" />}
                </td>
                <td className="text-right">
                  {prov ? <span className="text-text-muted">—</span> : <Money value={p.payable} currency={p.currency} />}
                </td>
                <td className="text-right">
                  {prov ? (
                    <span className="text-text-muted">—</span>
                  ) : (
                    <Money value={p.payable_to_date} currency={p.currency} />
                  )}
                </td>
                <td className="text-right">
                  {prov ? <span className="text-text-muted">—</span> : <Money value={p.paid} currency={p.currency} />}
                </td>
                <td className="text-right">
                  {prov ? <span className="text-text-muted">—</span> : <Money value={p.outstanding} currency={p.currency} kind="danger" />}
                </td>
              </tr>
            );
          })}
          <tr className="na-sub-subtotal">
            <td className="text-[10.5px] uppercase tracking-wide text-text-muted">Subtotal</td>
            <td className="text-right"><MultiMoney map={totals} field="gmv" /></td>
            <td className="text-right"><MultiMoney map={totals} field="commission" kind="muted" /></td>
            <td className="text-right"><MultiMoney map={totals} field="payable" kind="muted" /></td>
            <td className="text-right"><MultiMoney map={totals} field="payableToDate" /></td>
            <td className="text-right"><MultiMoney map={totals} field="paid" /></td>
            <td className="text-right"><MultiMoney map={totals} field="outstanding" kind="danger" /></td>
          </tr>
        </tbody>
      </table>
      <div className="na-section-caption px-[14px] pb-3">{caption}</div>
    </section>
  );
}

/** AI-written recap of this partner's email thread — generated on click, shared once saved. */
function NaFinancialSummaryBox({
  existing,
  loading,
  onSummarize,
}: {
  existing: NaFinancialSummary | undefined;
  loading: boolean;
  onSummarize: () => void;
}) {
  return (
    <div className="mt-1.5 rounded-md border border-border bg-slate-50 px-2 py-1.5">
      {existing ? (
        <>
          <p className="text-[11px] leading-relaxed text-text-secondary">{existing.summary}</p>
          <p className="mt-1 text-[10px] text-text-muted">
            {existing.message_count} message{existing.message_count === 1 ? "" : "s"} ·{" "}
            {existing.generated_by ?? "—"}
          </p>
        </>
      ) : (
        <p className="text-[11px] text-text-muted">No financial summary yet.</p>
      )}
      <button
        type="button"
        onClick={onSummarize}
        disabled={loading}
        className="mt-1 inline-flex items-center gap-1 text-[11px] text-sky-800 underline-offset-2 hover:underline disabled:opacity-50"
      >
        {loading ? "Summarizing…" : existing ? "Re-summarize" : "Summarize financials"}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Comments
// ─────────────────────────────────────────────────────────────


function initialsOf(name?: string | null, email?: string | null) {
  const src = (name || email || "?").trim();
  const parts = src.split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || src[0]?.toUpperCase() || "?";
}

function CommentersChip({ summary }: { summary: EventCommentSummary | undefined }) {
  if (!summary || summary.count === 0) return null;
  const shown = summary.commenters.slice(0, 3);
  const extra = summary.commenters.length - shown.length;
  return (
    <span
      className="mt-1.5 inline-flex items-center gap-1.5 align-middle"
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
              className="h-5 w-5 rounded-full border-2 border-background object-cover"
            />
          ) : (
            <span
              key={c.user_id}
              className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-background bg-muted text-[9px] font-semibold text-text-secondary"
            >
              {initialsOf(c.user_name, c.user_email)}
            </span>
          ),
        )}
        {extra > 0 && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-background bg-muted px-1 text-[9px] font-semibold text-text-secondary">
            +{extra}
          </span>
        )}
      </span>
      <span className="text-[10px] font-medium text-text-secondary">{summary.count}</span>
    </span>
  );
}

function CommentsSectionCard({ eventRef }: { eventRef: string }) {
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

  const count = comments?.length ?? 0;

  return (
    <section className="na-section-card">
      <header className="na-section-head">
        <MessageSquare className="h-3.5 w-3.5" />
        <span>Comments</span>
        <span className="text-text-muted">({count})</span>
      </header>
      <div className="divide-y divide-border">
        {isLoading && <div className="px-4 py-3 text-xs text-text-muted">Loading…</div>}
        {!isLoading && count === 0 && (
          <div className="px-4 py-3 text-xs text-text-muted">No comments yet.</div>
        )}
        {comments?.map((c) => (
          <div key={c.id} className="flex gap-3 px-4 py-3">
            <UserAvatar
  name={c.user_name}
  email={c.user_email}
  picture={c.user_avatar_url}
  className="h-6 w-6"
  fallbackClassName="bg-slate-200 text-slate-700"
  textClassName="text-[10px]"
/>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[11px] text-text-muted">
                <span className="font-medium text-text-primary">
                  {c.user_name || c.user_email}
                </span>
                <span>·</span>
                <span>{fmtWhen(c.created_at)}</span>
                {user?.id === c.user_id && (
                  <button
                    type="button"
                    onClick={() => deleteComment.mutate(c.id)}
                    className="ml-auto text-[11px] text-text-danger hover:underline disabled:opacity-50"
                    disabled={deleteComment.isPending}
                  >
                    Delete
                  </button>
                )}
              </div>
              <div className="mt-0.5 whitespace-pre-wrap text-xs text-text-primary">
                {c.body}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-end gap-2 border-t border-border bg-[color:var(--surface-1)]/60 px-3 py-2">
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
          className="min-h-[36px] flex-1 resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
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
    </section>
  );
}