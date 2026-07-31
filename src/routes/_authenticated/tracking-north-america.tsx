import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SummaryStrip, useRegisterTrackerActions } from "@/components/tracker-chrome";
import { EventStickers, PartnerStickers } from "@/components/partner-fact-stickers";
import { PartnerEmails } from "@/components/partner-emails";
import {
  NaCommissionRequestDialog,
  useNaCommissionRequestDialog,
  type NaCommissionTarget,
} from "@/components/na-commission-request-dialog";
import {
  partnerClawback,
  partnerRecoveryAsk,
  rowClawbackSplit,
  naContactFor,
  composeNaCommissionRequest,
  composeNaRefundRequest,
  composeNaCombinedRequest,
} from "@/lib/na-commission-requests";
import { fmtAge } from "@/lib/card-tracking";
import {
  RECOVERY_GRACE_DAYS,
  naClientRecovery,
  naClientContactFor,
  composeNaClientRecovery,
  type NaClientRecovery,
} from "@/lib/na-client-recovery";
import {
  fetchNaFinancialSummaries,
  generateNaFinancialSummary,
  type NaFinancialSummary,
} from "@/lib/na-financial-summary.functions";
import {
  getCommissionDetail,
  indexCommissionDetail,
  commissionDetailKey,
  type NaCommissionDetail,
} from "@/lib/commission-detail.functions";
import { partnerKey } from "@/lib/annotations.functions";
import { useActionIndex } from "@/lib/use-partner-actions";
import { useGmailConnection, useFactScan, useRecoveryLog } from "@/lib/use-gmail";
import { recoveryKey, recoverySentLabel, type RecoverySend } from "@/lib/recovery-log";
import {
  useAddComment,
  useCommentSummaries,
  useCurrentUser,
  useDeleteComment,
  useEventComments,
  type EventCommentSummary,
} from "@/lib/use-annotations";
import { useCallback, Fragment, useMemo, useState } from "react";
import { Mail } from "lucide-react";
import {
  getNaRows,
  parseNaPartners,
  sumPartners,
  type NaRow,
  type NaPartnerLine,
  type NaClientReceipt,
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
import { PartnerInvoicePdfs } from "@/components/partner-invoice-pdfs";
import { syncCardApprovals } from "@/lib/slack-cards.functions";
import { parseNaInvoices, parseNaClientReceipts } from "@/lib/na.functions";
import {
  GROUP_META,
  GROUP_ORDER,
  MOVE_PILL,
  needsAMove,
  type Move,
  type MoveGroup,
} from "@/lib/tracker-move";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ArrowUpDown,
  Banknote,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Lock,
  MessageSquare,
  Printer,
  ReceiptText,
  RefreshCw,
  Search,
  SearchX,
  Send,
  SlidersHorizontal,
} from "lucide-react";

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
      throw redirect(
        fallback ? { to: fallback } : { to: "/auth", search: { status: "no-tracker" } },
      );
    }
  },
  head: () => ({
    meta: [
      { title: "Tracking North America" },
      {
        name: "description",
        content: "North America deals tracker — bookings and partner payouts.",
      },
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
    <span
      className={`inline-flex items-baseline gap-1 tabular-nums ${alignCls} ${dangerCls || mutedCls || emptyCls}`}
    >
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
  map: Map<
    string,
    {
      gmv: number;
      paid: number;
      outstanding: number;
      payable: number;
      payableToDate: number;
      commission: number;
    }
  >;
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
  totals: Map<
    string,
    {
      gmv: number;
      paid: number;
      outstanding: number;
      payable: number;
      payableToDate: number;
      commission: number;
    }
  >,
  partners: Array<{
    payment_method: string | null;
    is_provision: boolean | null;
    currency: string | null;
    outstanding: number | null;
  }>,
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

function rowPartnerToPay(
  row: NaRow,
  partners: ReturnType<typeof parseNaPartners>,
): Map<string, number> {
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
    "Transaction kind",
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
      row.transaction_kind ?? "",
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

function exportRecoverCsv(
  rows: Array<{ row: NaRow; partners: ReturnType<typeof parseNaPartners> }>,
) {
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

/** The client side of the same list: balances aged past both grace periods. */
function exportClientRecoveryCsv(rows: Array<{ row: NaRow; recovery: NaClientRecovery }>) {
  const headers = [
    "Start date",
    "Booking",
    "Company",
    "Billing entity",
    "Event name",
    "Sales",
    "EM",
    "Client contact",
    "Currency",
    "Invoiced",
    "Received",
    "Balance due",
    "Last invoice issued",
    "Days since event",
    "Days since last invoice",
    "Live documents",
  ];
  const lines: string[] = [headers.join(",")];
  for (const { row, recovery } of rows) {
    if (!recovery.eligible) continue;
    lines.push(
      [
        row.start_date ?? "",
        row.readable_id ?? "",
        row.company_name ?? "",
        row.billing_entity ?? "",
        row.event_name ?? "",
        row.sales_referent ?? "",
        row.em_referent ?? "",
        naClientContactFor(row, recovery.docs).address ?? "",
        recovery.currency ?? "",
        recovery.invoiced.toFixed(2),
        recovery.paid.toFixed(2),
        recovery.outstanding.toFixed(2),
        recovery.lastInvoiceDay ?? "",
        recovery.daysSinceEvent ?? "",
        recovery.daysSinceInvoice ?? "",
        recovery.docs.map((d) => d.invoice_ref ?? "").join(" | "),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  downloadCsv(lines, `na-client-recovery-${new Date().toISOString().slice(0, 10)}.csv`);
}

function NaPage() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["na-rows"],
    queryFn: () => getNaRows({ data: { force: false } }),
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
  const [selectedRef, setSelectedRef] = useState<string>("");
  const [scope, setScope] = useState<
    "move" | "commission" | "refund" | "client_refund" | "client_recovery" | "all"
  >("move");
  const [detailTab, setDetailTab] = useState<
    "partners" | "invoices" | "emails" | "docs" | "comments"
  >("partners");

  const rows = useMemo<NaRow[]>(() => data?.rows ?? [], [data]);
  /** How stale the figures are, so the header can say so. */
  const cachedAge = data?.cachedAgeSeconds ?? null;
  const { data: commentSummaries } = useCommentSummaries();

  // Client invoicing and receipts are decoded once per row alongside the partner
  // lines: the recovery position, the list pill, the scope count and the email
  // then all read the same numbers.
  const decorated = useMemo(
    () =>
      rows.map((r) => {
        const invoices = parseNaInvoices(r.invoices_json);
        const receipts = parseNaClientReceipts(r.client_receipts_json);
        return {
          row: r,
          partners: parseNaPartners(r.partners_json),
          invoices,
          receipts,
          recovery: naClientRecovery(r, invoices, receipts),
        };
      }),
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
  // Deal shape (TURNKEY_EM, INVOICE_CARRYING, VENUE_FINDING…) rather than the
  // event category: it is what changes how a booking is invoiced and paid.
  const kinds = useMemo(() => uniq((r) => r.transaction_kind), [rows]);
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
      if (eventType !== "all" && (row.transaction_kind ?? "") !== eventType) return false;
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
        const av = Array.from(rowPartnerToPay(a.row, a.partners).values()).reduce(
          (s, v) => s + v,
          0,
        );
        const bv = Array.from(rowPartnerToPay(b.row, b.partners).values()).reduce(
          (s, v) => s + v,
          0,
        );
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

  const { factsMap, actionFor, eventNeedsScan, cardApprovedCodes, cardsSyncedAgeSeconds } =
    useActionIndex();
  const { data: gmailConnection } = useGmailConnection();
  // What the team has already sent. Every button that opens an email checks it, so
  // nobody is offered a chase a colleague has already made.
  const { data: recoveryLog } = useRecoveryLog();
  const { progress: scanProgress, start: startScan } = useFactScan();
  const commissionRefundDialog = useNaCommissionRequestDialog();
  const queryClient = useQueryClient();
  // Refreshing the mirror is explicit, so a cold instance never pays for Slack.
  const syncCards = useMutation({
    mutationFn: () => syncCardApprovals(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["slack-card-approvals"] }),
    // Refresh here re-syncs the approvals as a side effect of recomputing the page, so
    // there is no button of its own to hang a message off. It must still not fail in
    // silence: the age badge beside the cache indicator shows the mirror standing
    // still, and this puts the reason in the runtime logs. Card tracking NA is where
    // the failure is shown in full.
    onError: (error) => console.error("Card approvals sync failed:", error),
  });

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
    mutationFn: (input: {
      event_ref: string;
      partner_name: string;
      partner_email: string | null;
    }) => generateNaFinancialSummary({ data: input }),
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

  // Marketplace NA deliberately has no bank/tax request path: on this tracker we
  // only ever ask for a commission or a refund. That ask lives in
  // commissionRefundTargets below.

  // Overpaid partners: ask for whichever applies — the commission we're owed,
  // a refund beyond that, or both. One email per partner, never combined
  // across different partners on the same booking — a booking can have
  // several unrelated vendors, and a venue should never see a caterer's figures.
  // Each plan is one email waiting to be written: the booking, the provider and
  // which ask applies. Composing is deferred because the itemised breakdown — what
  // we paid out, which services carry a commission — is no longer in the page
  // payload. It is fetched for the bookings in play when the dialog opens, which is
  // what took a ~109 MB pricing-item scan off every page load.
  type RecoveryPlan = {
    eventRef: string;
    row: NaRow;
    partner: NaPartnerLine;
    contact: { address: string; name: string | null };
    mode: "commission" | "refund" | "combined";
  };

  const recoveryPlans = useMemo<RecoveryPlan[]>(() => {
    const plans: RecoveryPlan[] = [];
    for (const { row: r, partners: ps } of sorted) {
      const eventRef = r.readable_id ?? "";
      for (const p of ps) {
        if (p.is_provision) continue;
        const cb = partnerClawback(p);
        if (cb.commission <= 0.01 && cb.refund <= 0.01) continue;
        const contact = naContactFor(p);
        if (!contact.address) continue;
        plans.push({
          eventRef,
          row: r,
          partner: p,
          contact: { address: contact.address, name: contact.name },
          mode:
            cb.commission > 0.01 && cb.refund > 0.01
              ? "combined"
              : cb.commission > 0.01
                ? "commission"
                : "refund",
        });
      }
    }
    return plans;
  }, [sorted]);

  const composePlan = useCallback(
    (plan: RecoveryPlan, detail: NaCommissionDetail | null): NaCommissionTarget | null => {
      const composed =
        plan.mode === "combined"
          ? composeNaCombinedRequest(plan.row, plan.partner, plan.contact, detail)
          : plan.mode === "commission"
            ? composeNaCommissionRequest(plan.row, plan.partner, plan.contact, detail)
            : composeNaRefundRequest(plan.row, plan.partner, plan.contact, detail);
      if (!composed) return null;
      return {
        eventRef: plan.eventRef,
        partnerName: plan.partner.name,
        address: plan.contact.address,
        contactName: plan.contact.name,
        ...composed,
        mode: plan.mode,
      };
    },
    [],
  );

  // Without the detail: enough to count the asks, show the buttons and check the
  // ledger. The itemisation is added when the dialog opens.
  const commissionRefundTargets = useMemo<NaCommissionTarget[]>(
    () =>
      recoveryPlans
        .map((plan) => composePlan(plan, null))
        .filter((t): t is NaCommissionTarget => t != null),
    [recoveryPlans, composePlan],
  );

  const commissionDetail = useMutation({
    mutationFn: (eventRefs: string[]) => getCommissionDetail({ data: { event_refs: eventRefs } }),
  });

  /**
   * Opens the dialog with the breakdown filled in.
   *
   * The detail is a separate query now, so it is fetched for the bookings the round
   * covers and the emails are composed with it. If that fetch fails the emails
   * still go out — the composers leave the breakdown out rather than the amount.
   */
  const openRecoveryDialog = useCallback(
    async (wanted: NaCommissionTarget[]) => {
      const keys = new Set(
        wanted.map((t) => `${t.eventRef}::${t.address.toLowerCase()}::${t.mode}`),
      );
      const plans = recoveryPlans.filter((plan) =>
        keys.has(`${plan.eventRef}::${plan.contact.address.toLowerCase()}::${plan.mode}`),
      );
      if (plans.length === 0) {
        commissionRefundDialog.open(wanted);
        return;
      }
      let index = new Map<string, NaCommissionDetail>();
      try {
        const rows = await commissionDetail.mutateAsync([...new Set(plans.map((p) => p.eventRef))]);
        index = indexCommissionDetail(rows);
      } catch (error) {
        console.error("commission detail unavailable — composing without the breakdown:", error);
      }
      const composed = plans
        .map((plan) =>
          composePlan(
            plan,
            index.get(commissionDetailKey(plan.eventRef, plan.partner.house_code)) ?? null,
          ),
        )
        .filter((t): t is NaCommissionTarget => t != null);
      commissionRefundDialog.open(composed.length > 0 ? composed : wanted);
    },
    [recoveryPlans, composePlan, commissionDetail, commissionRefundDialog],
  );

  // Client recoveries: one email per booking, to the address its invoices were
  // billed to. A booking with no contact on file is left out rather than sent to
  // whoever happens to be on the brief.
  const clientRecoveryTargets = useMemo<NaCommissionTarget[]>(() => {
    const targets: NaCommissionTarget[] = [];
    for (const { row: r, recovery } of sorted) {
      if (!recovery.eligible) continue;
      const contact = naClientContactFor(r, recovery.docs);
      if (!contact.address) continue;
      const composed = composeNaClientRecovery(r, recovery);
      if (!composed) continue;
      targets.push({
        eventRef: r.readable_id ?? "",
        partnerName: r.company_name,
        address: contact.address,
        contactName: contact.name,
        ...composed,
        mode: "client",
      });
    }
    return targets;
  }, [sorted]);

  const clientRecoveryCount = useMemo(
    () => sorted.filter(({ recovery }) => recovery.eligible).length,
    [sorted],
  );

  // Already sent, by whoever got there first. The targets themselves are kept so
  // the dialog can show the send as evidence; only the buttons count what is left
  // to do, and a target with nothing left turns into a "Sent on … by …" label.
  const sentFor = useCallback(
    (t: NaCommissionTarget): RecoverySend | undefined =>
      recoveryLog?.get(recoveryKey(t.eventRef, t.address, t.mode)),
    [recoveryLog],
  );
  const unsentPartnerTargets = useMemo(
    () => commissionRefundTargets.filter((t) => !sentFor(t)),
    [commissionRefundTargets, sentFor],
  );
  const unsentClientTargets = useMemo(
    () => clientRecoveryTargets.filter((t) => !sentFor(t)),
    [clientRecoveryTargets, sentFor],
  );

  useRegisterTrackerActions(
    {
      // Refresh is the escape hatch from the cache: recompute in BigQuery and
      // re-sync the Slack approvals, then repopulate every dependent query.
      onRefresh: async () => {
        await queryClient.fetchQuery({
          queryKey: ["na-rows"],
          queryFn: () => getNaRows({ data: { force: true } }),
        });
        syncCards.mutate();
      },
      isFetching,
      exports: [
        { label: "Export CSV", onClick: () => exportCsv(sorted), disabled: sorted.length === 0 },
        {
          label: "Export to recover",
          onClick: () => exportRecoverCsv(sorted),
          disabled: recoverCount === 0,
        },
        {
          label: "Export client recovery",
          onClick: () => exportClientRecoveryCsv(sorted),
          disabled: clientRecoveryCount === 0,
        },
      ],
    },
    [isFetching, sorted.length, recoverCount, clientRecoveryCount],
  );

  // ── Split view ────────────────────────────────────────────────────────────
  // Presentation only. Amounts, tags, email actions and the commission/refund
  // dialogs all come from the same hooks and helpers as the previous layout.

  // One move per booking, derived from the same helpers the partner cards use so
  // the pills, the scope counts and the dialog agree.
  const moveFor = useCallback(
    (r: NaRow, ps: ReturnType<typeof parseNaPartners>, recovery: NaClientRecovery): Move => {
      const ccy = ps.find((p) => p.currency)?.currency ?? r.currency_client;
      const fmt = (v: number) => `${fmtAmount(v)} ${ccyLabel(ccy)}`;
      const live = ps.filter((p) => !p.is_provision);

      if (live.length === 0) {
        return {
          group: "blocked",
          label: "No partner line",
          headline: "—",
          headlineLabel: "nothing priced",
        };
      }

      // Commission and refund are two different claims: one is revenue we never
      // collected, the other is cash we paid out by mistake. They go out as
      // different emails to different counterparties, so they are never merged
      // into a single "to recover" figure.
      const claw = rowClawbackSplit(ps);
      const commissionDue = [...claw.commission.values()].reduce((a, b) => a + b, 0);
      const refundDue = [...claw.refund.values()].reduce((a, b) => a + b, 0);
      if (commissionDue > 0.01 || refundDue > 0.01) {
        const both = commissionDue > 0.01 && refundDue > 0.01;
        // Chasing a commission or a refund before the dust settles is premature:
        // amounts still move in the fortnight after an event.
        const age = daysSinceEvent(r);
        if (age != null && age < 14) {
          return {
            group: "waiting",
            label: "Nothing to do yet — pending",
            headline: both
              ? `${fmt(commissionDue)} + ${fmt(refundDue)}`
              : fmt(commissionDue > 0.01 ? commissionDue : refundDue),
            headlineLabel: `pending ${14 - age}d ${ccyLabel(ccy)}`,
          };
        }
        return {
          group: "ours",
          label: both
            ? `Recover ${fmt(commissionDue)} commission + ${fmt(refundDue)} refund`
            : commissionDue > 0.01
              ? `Recover ${fmt(commissionDue)} commission`
              : `Recover ${fmt(refundDue)} refund`,
          headline: both
            ? `${fmt(commissionDue)} + ${fmt(refundDue)}`
            : fmt(commissionDue > 0.01 ? commissionDue : refundDue),
          headlineLabel: both
            ? `commission + refund ${ccyLabel(ccy)}`
            : commissionDue > 0.01
              ? `commission to recover ${ccyLabel(ccy)}`
              : `refund to recover ${ccyLabel(ccy)}`,
        };
      }

      const toPay = rowPartnerToPay(r, ps);
      const payTotal = [...toPay.values()].reduce((a, b) => a + b, 0);
      if (payTotal > 0.01) {
        // Whose move it is depends on whether we can actually pay yet.
        const actions = live.map((p) =>
          actionFor(
            r.readable_id ?? "",
            {
              name: p.name,
              email: p.email,
              amount_due: p.outstanding,
              vat_raw: null,
              tax_identifier: null,
              country: null,
              cardOnThisEvent: p.payment_method === "CREDIT_CARD" ? "accepted" : undefined,
            },
            true,
            { taxTracked: false },
          ),
        );
        // Having the means is not enough: the booking must actually hold enough
        // client cash to settle at least one provider, otherwise the next move is
        // the client's.
        const cash = availableCash(r, live);
        const coversSomeone = live.some(
          (p) => (p.outstanding ?? 0) > 0.01 && cash + 0.01 >= (p.outstanding ?? 0),
        );
        const canPay = actions.some((a) => a.code === "ours_pay") && coversSomeone;
        const waiting = actions.some((a) => a.code === "await_reply");
        if (canPay) {
          return {
            group: "ours",
            label: "Pay the partner",
            headline: fmt(payTotal),
            headlineLabel: `partner to pay ${ccyLabel(ccy)}`,
          };
        }
        if (waiting) {
          return {
            group: "waiting",
            label: "Waiting on a reply",
            headline: fmt(payTotal),
            headlineLabel: `partner to pay ${ccyLabel(ccy)}`,
          };
        }
        // We hold the means but not the cash: nothing moves until the client pays,
        // so this is their move even though a provider is owed.
        if (!coversSomeone) {
          return {
            group: "client",
            label: "Client to pay",
            headline: fmt(payTotal),
            headlineLabel: `partner to pay ${ccyLabel(ccy)}`,
          };
        }
        return {
          group: "partner",
          label: "Ask for details",
          headline: fmt(payTotal),
          headlineLabel: `partner to pay ${ccyLabel(ccy)}`,
        };
      }

      // A client balance that has aged past both grace periods is a recovery we
      // act on, not a wait: the email exists, the figures are settled, someone
      // has to send it. Before that it is just an invoice out in the world.
      if (recovery.eligible) {
        const rc = recovery.currency;
        return {
          group: "client",
          label: `Recover ${fmtAmount(recovery.outstanding)} ${ccyLabel(rc)} from the client`,
          headline: `${fmtAmount(recovery.outstanding)} ${ccyLabel(rc)}`,
          headlineLabel: `client to recover ${ccyLabel(rc)}`,
        };
      }

      if ((r.balance_ccy ?? 0) > 0.01) {
        // Named as pending while the dust settles, so the list never reads as a
        // chase that nobody is sending.
        const waitLeft =
          recovery.outstanding > 0.01 && recovery.daysSinceEvent != null
            ? Math.max(
                RECOVERY_GRACE_DAYS - recovery.daysSinceEvent,
                recovery.daysSinceInvoice != null
                  ? RECOVERY_GRACE_DAYS - recovery.daysSinceInvoice
                  : 0,
              )
            : 0;
        return {
          group: "client",
          label: waitLeft > 0 ? `Client to pay — chase in ${waitLeft}d` : "Client to pay",
          headline: `${fmtAmount(r.balance_ccy)} ${ccyLabel(r.currency_client)}`,
          headlineLabel: `client outstanding ${ccyLabel(r.currency_client)}`,
        };
      }

      // A negative balance means the client paid more than we invoiced: we owe
      // them the difference. Same fortnight of grace as the partner recoveries —
      // a late invoice often closes the gap on its own.
      const clientCredit = -(r.balance_ccy ?? 0);
      if (clientCredit > 0.01) {
        const age = daysSinceEvent(r);
        if (age != null && age < 14) {
          return {
            group: "waiting",
            label: "Nothing to do yet — pending",
            headline: `${fmtAmount(clientCredit)} ${ccyLabel(r.currency_client)}`,
            headlineLabel: `pending ${14 - age}d ${ccyLabel(r.currency_client)}`,
          };
        }
        return {
          group: "ours",
          label: `Refund the client ${fmtAmount(clientCredit)}`,
          headline: `${fmtAmount(clientCredit)} ${ccyLabel(r.currency_client)}`,
          headlineLabel: `client to refund ${ccyLabel(r.currency_client)}`,
        };
      }

      return {
        group: "done",
        label: "Nothing to do",
        headline: fmt(0),
        headlineLabel: `settled ${ccyLabel(ccy)}`,
      };
    },
    [actionFor],
  );

  const withMove = useMemo(
    () =>
      filtered.map((item) => ({
        ...item,
        move: moveFor(item.row, item.partners, item.recovery),
      })),
    [filtered, moveFor],
  );

  // One predicate per scope, shared by the filter and the chip counts below so a
  // chip can never claim a number the list does not show.
  const SCOPE_TEST: Record<typeof scope, (x: (typeof withMove)[number]) => boolean> = useMemo(
    () => ({
      move: (x) => needsAMove(x.move.group),
      commission: (x) => x.move.headlineLabel.includes("commission"),
      refund: (x) => x.move.headlineLabel.includes("refund to recover"),
      client_refund: (x) => x.move.headlineLabel.includes("client to refund"),
      // Keyed off the recovery itself, not the move label: a booking can owe us a
      // client balance *and* carry a partner claim, and only one of those can be
      // the headline. The chip has to agree with the Client recovery button.
      client_recovery: (x) => x.recovery.eligible,
      all: () => true,
    }),
    [],
  );

  const scoped = useMemo(() => withMove.filter(SCOPE_TEST[scope]), [withMove, scope, SCOPE_TEST]);

  const scopeCounts = useMemo(
    () => ({
      move: withMove.filter(SCOPE_TEST.move).length,
      commission: withMove.filter(SCOPE_TEST.commission).length,
      refund: withMove.filter(SCOPE_TEST.refund).length,
      clientRefund: withMove.filter(SCOPE_TEST.client_refund).length,
      clientRecovery: withMove.filter(SCOPE_TEST.client_recovery).length,
      all: withMove.length,
    }),
    [withMove, SCOPE_TEST],
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
      title: GROUP_META[g].title,
      dot: GROUP_META[g].dot,
      rows: byGroup.get(g)!,
    }));
  }, [scoped]);

  const selected = useMemo(() => {
    if (scoped.length === 0) return null;
    return scoped.find(({ row }) => (row.readable_id ?? "") === selectedRef) ?? scoped[0];
  }, [scoped, selectedRef]);

  const sel = selected?.row ?? null;
  const selPartners = selected?.partners ?? [];
  const selRef = sel?.readable_id ?? "";
  const selTotals = useMemo(() => sumPartners(selPartners), [selPartners]);
  const selInvoices = selected?.invoices ?? [];
  const selRecovery = selected?.recovery ?? null;
  // Which documents the recovery actually counts, so the invoicing tab can show
  // what the email leaves out instead of quietly disagreeing with it.
  const selLiveDocIds = useMemo(
    () => new Set((selRecovery?.docs ?? []).map((d) => d.invoice_id ?? d.invoice_ref ?? "")),
    [selRecovery],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      {error != null && (
        <div
          role="alert"
          className="flex-none border-b border-rose-200 bg-rose-50 px-5 py-2.5 text-sm text-rose-800"
        >
          Failed to load data: {(error as Error).message}
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
                  placeholder="Search booking, company, partner…"
                  aria-label="Search"
                  className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] outline-none"
                />
              </span>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-white px-2.5 text-[12px] text-slate-700"
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                    Filters
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-[340px] space-y-2">
                  <FilterSelect
                    label="Type"
                    value={eventType}
                    onChange={setEventType}
                    options={kinds}
                  />
                  <FilterSelect
                    label="Sales"
                    value={sales}
                    onChange={setSales}
                    options={salesList}
                  />
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
                  <label className="flex cursor-pointer items-center gap-2 pt-1 text-[12px] text-slate-700">
                    <input
                      type="checkbox"
                      checked={showAncient}
                      onChange={(e) => setShowAncient(e.target.checked)}
                      className="h-3.5 w-3.5 accent-navy"
                    />
                    Show events older than 100 days
                  </label>
                </PopoverContent>
              </Popover>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {/* Scope chips: Needs a move is the default, per the handoff. */}
              {(
                [
                  { key: "move" as const, label: "Needs a move", count: scopeCounts.move },
                  {
                    key: "commission" as const,
                    label: "Commission",
                    count: scopeCounts.commission,
                  },
                  { key: "refund" as const, label: "Refund", count: scopeCounts.refund },
                  {
                    key: "client_refund" as const,
                    label: "Client to refund",
                    count: scopeCounts.clientRefund,
                  },
                  {
                    key: "client_recovery" as const,
                    label: "Client recovery",
                    count: scopeCounts.clientRecovery,
                  },
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
              {/* Counts what is left to send, not what exists: an ask a colleague has
                  already sent is shown inside the dialog but never offered again. */}
              {gmailConnection?.connected && unsentPartnerTargets.length > 0 && (
                <button
                  type="button"
                  onClick={() => void openRecoveryDialog(commissionRefundTargets)}
                  className="rounded-full bg-naboo px-2.5 py-[3px] text-[11.5px] font-semibold text-navy"
                >
                  Recover from {unsentPartnerTargets.length} partner
                  {unsentPartnerTargets.length > 1 ? "s" : ""}
                </button>
              )}
              {gmailConnection?.connected && unsentClientTargets.length > 0 && (
                <button
                  type="button"
                  onClick={() => commissionRefundDialog.open(clientRecoveryTargets)}
                  className="rounded-full bg-navy px-2.5 py-[3px] text-[11.5px] font-semibold text-white"
                >
                  Client recovery ({unsentClientTargets.length})
                </button>
              )}
              {/* Say when the figures were computed, so a cached page never looks
                  live when it is not. Refresh in the top bar forces a recompute. */}
              {cachedAge != null && cachedAge > 30 && (
                <span
                  className="rounded-full px-2 py-[3px] text-[11.5px] text-slate-400"
                  title="Chiffres mis en cache. Rafraîchir recalcule depuis BigQuery et resynchronise les cartes approuvées."
                >
                  il y a {cachedAge < 90 ? `${cachedAge} s` : `${Math.round(cachedAge / 60)} min`}
                </span>
              )}
              {/* The approved cards come from a mirror that only the Refresh button
                  syncs, so its age has to be visible here too — otherwise a card
                  approved this morning looks like a provider who never had one. */}
              <span
                className="rounded-full px-2 py-[3px] text-[11.5px] text-slate-400"
                title="Cartes approuvées dans #finance-paiement-by-card, lues depuis le miroir Postgres. Rafraîchir resynchronise."
              >
                cartes {fmtAge(cardsSyncedAgeSeconds)}
              </span>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {isLoading && (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
            )}
            {!isLoading && scoped.length === 0 && (
              <div className="flex flex-col items-center gap-2.5 px-12 py-16 text-center">
                <SearchX className="h-6 w-6 text-slate-400" aria-hidden="true" />
                <span className="font-display text-base font-bold">
                  {search ? `Nothing matches “${search}”` : "Nothing to show"}
                </span>
                <span className="text-[12.5px] leading-relaxed text-slate-600">
                  Search covers booking refs, companies, events and partner names.
                </span>
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="inline-flex h-[30px] items-center rounded-md border border-input bg-white px-3 text-[12px] font-medium text-slate-700"
                  >
                    Clear the search
                  </button>
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
                  {g.rows.map(({ row: r, partners: ps, move }) => {
                    const ref = r.readable_id ?? "";
                    const isSel = selRef === ref;
                    return (
                      <button
                        key={ref}
                        type="button"
                        onClick={() => {
                          setSelectedRef(ref);
                          setDetailTab("partners");
                        }}
                        className={`flex w-full gap-2.5 border-b border-slate-100 px-4 py-2.5 text-left ${
                          isSel ? "bg-[#fafaf8]" : "hover:bg-[#fafaf8]"
                        }`}
                        style={{ borderLeft: `3px solid ${isSel ? "#101f34" : "transparent"}` }}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[13px] font-medium">
                              {r.company_name ?? "—"}
                            </span>
                            <span className="flex-none font-mono text-[10.5px] text-slate-400">
                              {ref}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-[11.5px] text-slate-500">
                            {r.event_name ?? "—"}
                          </span>
                          <span className="mt-[5px] inline-flex">
                            <span
                              className={`rounded-full px-2 py-[2px] text-[10.5px] font-semibold ${MOVE_PILL[move.group]}`}
                            >
                              {move.label}
                            </span>
                          </span>
                        </span>
                        <span className="flex-none whitespace-nowrap text-right">
                          <span className="block text-[13px] font-semibold tabular-nums">
                            {move.headline}
                          </span>
                          <span className="block text-[10.5px] text-[#9CA3AF]">
                            {move.headlineLabel}
                          </span>
                          <span className="mt-1.5 block text-[10.5px] text-slate-400">
                            {fmtDate(r.start_date)}
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
                Select a booking on the left to see its detail.
              </span>
            </div>
          ) : (
            <>
              <div className="flex-none border-b border-border bg-white px-6 pb-3.5 pt-4">
                <div className="flex items-start gap-3.5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h1 className="font-display text-2xl font-bold tracking-tight">
                        {sel.company_name ?? "—"}
                      </h1>
                      {sel.booking_url ? (
                        <a
                          href={sel.booking_url}
                          target="_blank"
                          rel="noreferrer"
                          className="border-b border-dotted border-slate-400 font-mono text-[12.5px] no-underline"
                        >
                          {selRef}
                        </a>
                      ) : (
                        <span className="font-mono text-[12.5px]">{selRef}</span>
                      )}
                      <LockChip
                        locked={selPartners.some((p) => p.locked)}
                        admin={selPartners.some((p) => p.locked_by_admin)}
                        client={selPartners.some((p) => p.locked_by_client)}
                        em={sel.em_referent}
                      />
                    </div>
                    <div className="mt-1 text-[13px] text-slate-500">
                      {sel.event_name ?? "—"} ·{" "}
                      {(sel.transaction_kind ?? "—").replaceAll("_", " ").toLowerCase()} ·{" "}
                      {sel.billing_entity ?? "—"} · {fmtDate(sel.start_date)}
                      {sel.participants ? ` · ${sel.participants} pax` : ""}
                    </div>
                  </div>
                  <div className="ml-auto flex flex-none items-center gap-2">
                    {sel.booking_url && (
                      <a
                        href={sel.booking_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-white px-2.5 text-[12.5px] text-slate-700 no-underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        Back office
                      </a>
                    )}
                    <StatementButton eventRef={selRef} />
                    {/* Same targets as the list-level button, narrowed to this booking. */}
                    {(() => {
                      if (!gmailConnection?.connected) return null;
                      // Marketplace NA only ever asks for commission or a refund —
                      // bank details and tax numbers are a L'Oreal concern.
                      const mine = commissionRefundTargets.filter((t) => t.eventRef === selRef);
                      if (mine.length === 0) return null;
                      const left = mine.filter((t) => !sentFor(t));
                      // Every provider on this booking has already been written to:
                      // say who did it rather than offering the round again.
                      if (left.length === 0) {
                        return <SentButton send={latestSend(mine.map(sentFor))} />;
                      }
                      const anyRefund = left.some((t) => t.mode !== "commission");
                      return (
                        <button
                          type="button"
                          onClick={() => void openRecoveryDialog(mine)}
                          className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border-0 bg-naboo px-3 text-[12.5px] font-bold text-navy"
                        >
                          <Send className="h-3.5 w-3.5" aria-hidden="true" />
                          {anyRefund
                            ? `Recover from ${left.length} partner${left.length > 1 ? "s" : ""}`
                            : `Ask ${left.length} partner${left.length > 1 ? "s" : ""} for the commission`}
                        </button>
                      );
                    })()}
                    {/* Same targets as the list-level Client recovery button. */}
                    {(() => {
                      if (!gmailConnection?.connected) return null;
                      const mine = clientRecoveryTargets.filter((t) => t.eventRef === selRef);
                      if (mine.length === 0) return null;
                      const left = mine.filter((t) => !sentFor(t));
                      if (left.length === 0) {
                        return <SentButton send={latestSend(mine.map(sentFor))} />;
                      }
                      return (
                        <button
                          type="button"
                          onClick={() => commissionRefundDialog.open(mine)}
                          className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border-0 bg-navy px-3 text-[12.5px] font-bold text-white"
                        >
                          <Send className="h-3.5 w-3.5" aria-hidden="true" />
                          Client recovery
                        </button>
                      );
                    })()}
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-6">
                  {[
                    {
                      label: "Client GMV",
                      side: "client" as const,
                      node: <Money value={sel.gmv_client_ccy} currency={sel.currency_client} />,
                    },
                    {
                      label: "Invoiced",
                      side: "client" as const,
                      node: <Money value={sel.invoiced_ccy} currency={sel.currency_client} />,
                    },
                    {
                      label: "Received",
                      side: "client" as const,
                      node: <Money value={sel.paid_ccy} currency={sel.currency_client} />,
                    },
                    {
                      label: "To cash in",
                      side: "client" as const,
                      node: (
                        <Money
                          value={sel.balance_ccy}
                          currency={sel.currency_client}
                          kind="danger"
                        />
                      ),
                    },
                    {
                      label: "Available cash",
                      side: "partner" as const,
                      node: (
                        <Money
                          value={availableCash(sel, selPartners)}
                          currency={sel.currency_client}
                          kind={availableCash(sel, selPartners) > 0.01 ? "neutral" : "muted"}
                        />
                      ),
                    },
                    {
                      label: "To pay partners",
                      side: "partner" as const,
                      node: <MultiMoney map={selTotals} field="outstanding" kind="danger" />,
                    },
                  ].map((s) => (
                    <div key={s.label} className="bg-white px-3 py-2.5">
                      {/* Label colour is what replaces the old tinted column
                          blocks: teal client side, lime partner side. */}
                      <div
                        className={`text-[9.5px] font-bold uppercase tracking-[0.08em] ${
                          s.side === "client" ? "text-[#0F766E]" : "text-[#5B6511]"
                        }`}
                      >
                        {s.label}
                      </div>
                      <div className="mt-0.5 text-base font-semibold tabular-nums">{s.node}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Tab bar — counts come from the same data the panels render. */}
              <div className="flex flex-none gap-[18px] border-b border-border bg-white px-6">
                {(
                  [
                    {
                      key: "partners" as const,
                      label: "Partners",
                      count: selPartners.filter((p) => !p.is_provision).length,
                    },
                    {
                      key: "invoices" as const,
                      label: "Client invoicing",
                      count: selInvoices.length,
                    },
                    {
                      key: "emails" as const,
                      label: "Emails",
                      count: selPartners.filter((p) => !p.is_provision && p.email).length,
                    },
                    { key: "docs" as const, label: "Documents", count: null },
                    {
                      key: "comments" as const,
                      label: "Comments",
                      count: commentSummaries?.get(selRef)?.count ?? null,
                    },
                  ] as const
                ).map((t) => {
                  const active = detailTab === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setDetailTab(t.key)}
                      className={`inline-flex h-10 items-center gap-1.5 whitespace-nowrap border-b-2 bg-transparent p-0 text-[13px] ${
                        active
                          ? "border-navy font-semibold text-navy"
                          : "border-transparent font-normal text-slate-600"
                      }`}
                    >
                      {t.label}
                      {t.count != null && (
                        <span className="font-normal text-slate-400">{t.count}</span>
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
                {detailTab === "partners" && (
                  <PartnerSectionCard
                    id={selRef}
                    partners={selPartners}
                    totals={selTotals}
                    actionFor={actionFor}
                    factsMap={factsMap}
                    cardApprovedCodes={cardApprovedCodes}
                    onRequest={(p) => {
                      // Same targets the list-level button builds, narrowed to
                      // this partner — no new email logic.
                      const mine = commissionRefundTargets.filter(
                        (t) =>
                          t.eventRef === selRef &&
                          t.address.toLowerCase() === (p.email ?? "").toLowerCase(),
                      );
                      if (mine.length > 0) void openRecoveryDialog(mine);
                      else if (sel?.booking_url) window.open(sel.booking_url, "_blank");
                    }}
                    // Whoever already wrote to this provider about this booking.
                    sentFor={(p) =>
                      latestSend(
                        commissionRefundTargets
                          .filter(
                            (t) =>
                              t.eventRef === selRef &&
                              t.address.toLowerCase() === (p.email ?? "").toLowerCase(),
                          )
                          .map(sentFor),
                      )
                    }
                  />
                )}
                {detailTab === "invoices" && (
                  <div className="flex flex-col gap-3">
                    {selRecovery && (
                      <ClientRecoveryCard
                        recovery={selRecovery}
                        sent={latestSend(
                          clientRecoveryTargets.filter((t) => t.eventRef === selRef).map(sentFor),
                        )}
                      />
                    )}
                    <div className="overflow-hidden rounded-[10px] border border-border bg-white shadow-sm">
                      <header className="flex items-center gap-2 border-b border-[#cdeaf0] bg-[#e8f6f9] px-3.5 py-2.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-teal-700">
                        <ReceiptText className="h-3.5 w-3.5" aria-hidden="true" />
                        Client invoicing
                        {/* The statement is the client-facing view of this very table. */}
                        <span className="ml-auto">
                          <StatementButton eventRef={selRef} tone="primary" />
                        </span>
                      </header>
                      {selInvoices.length === 0 ? (
                        <div className="px-9 py-9 text-center">
                          <div className="font-display text-[15px] font-bold">
                            No invoice issued yet
                          </div>
                          <p className="mx-auto mt-1.5 max-w-[440px] text-[12.5px] leading-relaxed text-slate-500">
                            Nothing has been billed to the client on this booking so far.
                          </p>
                        </div>
                      ) : (
                        <table className="w-full border-collapse">
                          <thead>
                            <tr>
                              {["Invoice", "Issued", "Due", "Amount", "Status"].map((h, i) => (
                                <th
                                  key={h}
                                  className={`border-b border-slate-100 px-3.5 py-2 text-[9.5px] font-bold uppercase tracking-[0.07em] text-slate-500 ${
                                    i === 3 ? "text-right" : "text-left"
                                  }`}
                                >
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {selInvoices.map((iv, i) => (
                              <tr key={`${iv.invoice_ref ?? i}`}>
                                <td className="border-b border-slate-100 px-3.5 py-2.5 font-mono text-[12.5px]">
                                  {iv.invoice_ref ?? "—"}
                                </td>
                                <td className="border-b border-slate-100 px-3.5 py-2.5 text-[12.5px] text-slate-700">
                                  {fmtDate(iv.emission_date)}
                                </td>
                                <td className="border-b border-slate-100 px-3.5 py-2.5 text-[12.5px] text-slate-700">
                                  {fmtDate(iv.due_date)}
                                </td>
                                <td className="border-b border-slate-100 px-3.5 py-2.5 text-right text-[12.5px] tabular-nums">
                                  <Money value={iv.amount_ttc} currency={iv.currency} />
                                </td>
                                <td className="border-b border-slate-100 px-3.5 py-2.5">
                                  <span className="flex flex-wrap items-center gap-1">
                                    <span
                                      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-[2px] text-[10.5px] font-semibold ${
                                        iv.status === "CANCELLED"
                                          ? "bg-slate-100 text-slate-600"
                                          : iv.is_sent
                                            ? "bg-emerald-100 text-emerald-800"
                                            : "bg-amber-100 text-amber-800"
                                      }`}
                                    >
                                      {iv.status === "CANCELLED"
                                        ? "Cancelled"
                                        : iv.is_sent
                                          ? "Sent"
                                          : "Not sent"}
                                    </span>
                                    {/* Why a document is absent from the recovery email. */}
                                    {iv.party === "PARTNER" ? (
                                      <span
                                        title="Our commission note to a provider — not billed to the client"
                                        className="inline-flex items-center whitespace-nowrap rounded-full bg-slate-100 px-2 py-[2px] text-[10.5px] font-semibold text-slate-600"
                                      >
                                        Provider
                                      </span>
                                    ) : (
                                      !selLiveDocIds.has(iv.invoice_id ?? iv.invoice_ref ?? "") && (
                                        <span
                                          title="Cancelled out by a credit note — excluded from the balance due"
                                          className="inline-flex items-center whitespace-nowrap rounded-full bg-slate-100 px-2 py-[2px] text-[10.5px] font-semibold text-slate-600"
                                        >
                                          Nets out
                                        </span>
                                      )
                                    )}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                    {selRecovery && selRecovery.receipts.length > 0 && (
                      <ClientReceiptsCard receipts={selRecovery.receipts} />
                    )}
                  </div>
                )}
                {detailTab === "emails" &&
                  (gmailConnection?.connected ? (
                    <div className="flex flex-col gap-3">
                      {/* The AI recap belongs with the threads it summarises, not on
                          the payment card. */}
                      {selPartners
                        .filter((p) => !p.is_provision && p.email)
                        .map((p, i) => {
                          const key = partnerKey(p.name ?? p.email ?? "");
                          return (
                            <div
                              key={`${selRef}-sum-${i}`}
                              className="rounded-[10px] border border-border bg-white p-[14px_16px] shadow-[0_1px_2px_rgba(16,31,52,0.06)]"
                            >
                              <div className="text-sm font-semibold">{p.name ?? p.email}</div>
                              <NaFinancialSummaryBox
                                existing={financialSummaries?.get(`${selRef}::${key}`)}
                                loading={
                                  summarize.isPending &&
                                  summarize.variables?.event_ref === selRef &&
                                  summarize.variables?.partner_name === (p.name ?? p.email ?? "")
                                }
                                onSummarize={() =>
                                  summarize.mutate({
                                    event_ref: selRef,
                                    partner_name: p.name ?? p.email ?? "",
                                    partner_email: p.email,
                                  })
                                }
                              />
                            </div>
                          );
                        })}
                      <PartnerEmails
                        eventRef={selRef}
                        partners={selPartners
                          .filter((p) => !p.is_provision && p.email)
                          .map((p) => ({
                            name: p.name,
                            email: p.email,
                            owed: p.outstanding != null ? fmtAmount(p.outstanding) : null,
                          }))}
                      />
                    </div>
                  ) : (
                    <p className="rounded-lg border border-border bg-white px-4 py-8 text-center text-[12.5px] text-slate-600">
                      Connectez Gmail depuis le menu de votre compte pour retrouver vos échanges
                      avec ces prestataires.
                    </p>
                  ))}
                {detailTab === "docs" && (
                  <PartnerInvoicePdfs clientRequestId={sel.client_request_id} />
                )}
                {detailTab === "comments" && <CommentsSectionCard eventRef={selRef} />}
              </div>
            </>
          )}
        </div>
      </div>

      {commissionRefundDialog.targets && (
        <NaCommissionRequestDialog
          targets={commissionRefundDialog.targets}
          onClose={commissionRefundDialog.close}
        />
      )}
    </div>
  );
}

/**
 * Cash actually available on a booking to pay its providers: what the client has
 * paid, less what we have already disbursed, less our own service charge — that
 * fee is revenue, not money held on their behalf.
 */
function availableCash(r: NaRow, partners: NaPartnerLine[]): number {
  const received = r.paid_ccy ?? 0;
  const disbursed = partners.filter((p) => !p.is_provision).reduce((t, p) => t + (p.paid ?? 0), 0);
  const ourFee = r.client_service_fees_ttc ?? 0;
  return received - disbursed - ourFee;
}

/** Days since the event ended (or started, when there is no end date). */
function daysSinceEvent(r: NaRow): number | null {
  const raw = r.end_date ?? r.start_date;
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function Kpi({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
          {title}
        </CardTitle>
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
  const summary =
    count === 0
      ? `${label}: All`
      : count === 1
        ? `${label}: ${[...selected][0]}`
        : `${label}: ${count}`;
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
            <button
              type="button"
              onClick={onClear}
              className="text-xs text-primary hover:underline"
            >
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
    const map = new Map<
      string,
      {
        gmv: number;
        paid: number;
        outstanding: number;
        payable: number;
        payableToDate: number;
        commission: number;
      }
    >();
    for (const p of partners) {
      if (!p.is_provision) continue;
      const c = p.currency ?? "—";
      const cur = map.get(c) ?? {
        gmv: 0,
        paid: 0,
        outstanding: 0,
        payable: 0,
        payableToDate: 0,
        commission: 0,
      };
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

function StatusCell({
  owed,
  commission,
  refund,
}: {
  owed: Map<string, number>;
  commission: Map<string, number>;
  refund: Map<string, number>;
}) {
  const fmt = (m: Map<string, number>) =>
    Array.from(m.entries())
      .map(([c, v]) => `${fmtAmount(v)} ${ccyLabel(c)}`)
      .join(" · ");
  if (owed.size === 0 && commission.size === 0 && refund.size === 0) {
    return <span className="text-text-muted">—</span>;
  }
  return (
    <span className="flex flex-col items-start gap-1">
      {owed.size > 0 && (
        <span
          className="na-pill na-pill-green inline-flex items-center gap-1 whitespace-nowrap"
          title="Client paid — partner outstanding"
        >
          <Banknote className="h-3 w-3" />
          Partner to be paid · {fmt(owed)}
        </span>
      )}
      {commission.size > 0 && (
        <span
          className="na-pill na-pill-amber inline-flex items-center gap-1 whitespace-nowrap"
          title="Commission fronted to partner — to recover"
        >
          <Banknote className="h-3 w-3" />
          Commission to recover · {fmt(commission)}
        </span>
      )}
      {refund.size > 0 && (
        <span
          className="na-pill na-pill-red inline-flex items-center gap-1 whitespace-nowrap"
          title="Partner over-refunded beyond commission — refund to ask"
        >
          <Banknote className="h-3 w-3" />
          Refund to ask · {fmt(refund)}
        </span>
      )}
    </span>
  );
}

/**
 * One white card per partner line, per the redesign handoff.
 *
 * The old tinted table is gone: the client/partner distinction now lives in the
 * stat strip label colours, not in coloured backgrounds. Cards carry three
 * metrics and the actual next move as a button. Provision legs stay visible but
 * muted and excluded from the payable count, as before.
 *
 * Only the presentation changed — stickers, financial summaries and every amount
 * come from the same helpers as the table did.
 */
function PartnerSectionCard({
  id,
  partners,
  totals,
  actionFor,
  factsMap,
  cardApprovedCodes,
  onRequest,
  sentFor,
}: {
  id: string;
  partners: ReturnType<typeof parseNaPartners>;
  totals: ReturnType<typeof sumPartners>;
  actionFor: ReturnType<typeof useActionIndex>["actionFor"];
  factsMap: ReturnType<typeof useActionIndex>["factsMap"];
  cardApprovedCodes: ReturnType<typeof useActionIndex>["cardApprovedCodes"];
  onRequest: (partner: ReturnType<typeof parseNaPartners>[number]) => void;
  /** The recovery email already sent to this provider on this booking, if any. */
  sentFor: (partner: ReturnType<typeof parseNaPartners>[number]) => RecoverySend | undefined;
}) {
  const payableCount = partners.filter((p) => !p.is_provision).length;
  const provisionCount = partners.filter((p) => p.is_provision).length;

  if (partners.length === 0) {
    return (
      <div className="rounded-[10px] border border-dashed border-[#D1D5DB] p-10 text-center">
        <div className="font-display text-base font-bold">No partner line yet</div>
        <p className="mx-auto mt-1.5 max-w-[440px] text-[12.5px] leading-relaxed text-[#6B7280]">
          Nothing can be asked of the partners until the booking carries a priced quote. It will
          appear here the day it lands.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {partners.map((p, i) => {
        const prov = !!p.is_provision;
        const key = partnerKey(p.name ?? p.email ?? "");
        const action = prov
          ? null
          : actionFor(
              id,
              {
                name: p.name,
                email: p.email,
                amount_due: p.outstanding,
                vat_raw: null,
                tax_identifier: null,
                country: null,
                cardOnThisEvent: p.payment_method === "CREDIT_CARD" ? "accepted" : undefined,
              },
              true,
              { taxTracked: false },
            );
        const claw = partnerClawback(p);
        // Money to recover outranks every other verdict on this card — see
        // partnerRecoveryAsk for why the action tree cannot be trusted alone here.
        const ask = partnerRecoveryAsk(p);
        const hasRefundToClaim = ask === "refund";
        const hasCommissionToClaim = ask === "commission";
        const hasRecoveryAsk = ask != null;
        // Only a real ask can have been sent, so this is looked up for those lines
        // alone: nothing else on the card ever opened an email.
        const alreadyAsked = hasRecoveryAsk ? sentFor(p) : undefined;
        // A card approved in #finance-paiement-by-card means the money is
        // already available to the provider: the next move is theirs, not ours,
        // and it is certainly not a bank-details chase.
        const cardIssued =
          p.owner_code != null && cardApprovedCodes?.has(p.owner_code.toUpperCase()) === true;
        // The last metric is the one that decides the next move, so it carries the
        // emphasis: amber when it is money to claw back, muted when nothing is due.
        const outTone = prov
          ? "text-[#9CA3AF]"
          : hasRecoveryAsk
            ? "text-[#B45309]"
            : (p.outstanding ?? 0) > 0.01
              ? "text-[#101F34]"
              : "text-[#9CA3AF]";

        return (
          <div
            key={`${id}-p-${i}`}
            className={`flex flex-wrap items-start gap-4 rounded-[10px] border border-border bg-white p-[14px_16px] shadow-[0_1px_2px_rgba(16,31,52,0.06)] transition-colors hover:border-navy ${
              prov ? "opacity-70" : ""
            }`}
          >
            <div className="min-w-[220px] flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-semibold">{p.name ?? "—"}</span>
                <PartnerLockBadge admin={!!p.locked_by_admin} client={!!p.locked_by_client} />
                {prov && <ProvisionPill />}
                {p.payment_method === "CREDIT_CARD" && (
                  <span className="rounded-full bg-[#F3F4F6] px-2 py-[2px] text-[10.5px] font-medium text-[#4B5563]">
                    Virtual card
                  </span>
                )}
              </div>
              {p.email && (
                <a
                  href={`mailto:${p.email}`}
                  className="mt-[3px] block text-xs text-[#6B7280] hover:text-navy hover:underline"
                >
                  {p.email}
                </a>
              )}
              {!prov && action && (
                <>
                  <div className="mt-2 text-xs text-[#374151]">
                    {/* Same precedence as the button: never tell someone the line is
                        paid up while a refund or a commission is still to be asked for. */}
                    {hasRefundToClaim
                      ? `Overpaid by ${fmtAmount(claw.refund)} ${ccyLabel(p.currency)} beyond our commission — refund to ask.`
                      : hasCommissionToClaim
                        ? `Commission of ${fmtAmount(claw.commission)} ${ccyLabel(p.currency)} paid out with the provider's invoice — to recover.`
                        : cardIssued
                          ? "Carte émise et approuvée — au prestataire de la débiter."
                          : action.detail}
                  </div>
                  {cardIssued && (
                    <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#E7F8F3] px-2 py-[2px] text-[10.5px] font-semibold text-[#00593C]">
                      Card issued, service provider to debit it
                    </span>
                  )}
                  <PartnerStickers
                    action={action}
                    facts={factsMap?.get(`${id}::${key}`)}
                    partner={{
                      name: p.name,
                      email: p.email,
                      amount_due: p.outstanding,
                      vat_raw: null,
                      tax_identifier: null,
                      country: null,
                    }}
                    hideTax
                    hideCardPending
                    hideAction
                    hideContact
                  />
                </>
              )}
            </div>

            <div className="flex flex-none items-center gap-[22px] text-right">
              <span>
                <span className="block text-[9.5px] font-bold uppercase tracking-[0.07em] text-[#6B7280]">
                  Payable to date
                </span>
                <span className="mt-0.5 block whitespace-nowrap text-[13.5px] tabular-nums text-[#374151]">
                  {prov ? "—" : <Money value={p.payable_to_date} currency={p.currency} />}
                </span>
              </span>
              <span>
                <span className="block text-[9.5px] font-bold uppercase tracking-[0.07em] text-[#6B7280]">
                  Paid
                </span>
                <span className="mt-0.5 block whitespace-nowrap text-[13.5px] tabular-nums text-[#374151]">
                  {prov ? "—" : <Money value={p.paid} currency={p.currency} />}
                </span>
              </span>
              <span>
                <span className="block text-[9.5px] font-bold uppercase tracking-[0.07em] text-[#6B7280]">
                  {hasRefundToClaim
                    ? "Refund to recover"
                    : hasCommissionToClaim
                      ? "Commission to recover"
                      : "Outstanding"}
                </span>
                <span
                  className={`mt-0.5 block whitespace-nowrap text-[15px] font-bold tabular-nums ${outTone}`}
                >
                  {prov ? (
                    "—"
                  ) : (
                    <Money
                      value={
                        hasRefundToClaim
                          ? claw.refund
                          : hasCommissionToClaim
                            ? claw.commission
                            : p.outstanding
                      }
                      currency={p.currency}
                    />
                  )}
                </span>
              </span>
              <span className="flex flex-col items-end gap-1.5">
                {prov ? (
                  <span className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-semibold text-[#9CA3AF]">
                    Excluded
                  </span>
                ) : alreadyAsked ? (
                  // Someone has written to this provider about this booking. Nobody
                  // writes again — the ledger says who and when.
                  <span
                    title={`${alreadyAsked.sent_by}${alreadyAsked.subject ? ` — ${alreadyAsked.subject}` : ""}`}
                    className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-[#F3F4F6] px-3 text-xs font-semibold text-[#6B7280]"
                  >
                    <Check className="h-3 w-3" aria-hidden="true" />
                    {recoverySentLabel(alreadyAsked)}
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={
                      !hasRecoveryAsk &&
                      // Nothing owed either way, or waiting on the provider: the card
                      // is issued, or it is theirs to debit. Nothing to open here.
                      (action?.code === "settled" ||
                        cardIssued ||
                        (p.payment_method === "CREDIT_CARD" && action?.code === "ours_pay"))
                    }
                    onClick={() => onRequest(p)}
                    className="inline-flex h-8 items-center whitespace-nowrap rounded-md border border-navy bg-white px-3 text-xs font-semibold text-navy transition-colors hover:bg-[#FAFAF8] disabled:border-border disabled:text-[#9CA3AF]"
                  >
                    {/* Marketplace NA never asks for bank or tax details, so every
                      label here is either a payout state or a recovery ask. The
                      card is a state we act on elsewhere, not something we debit
                      from this screen. */}
                    {hasRefundToClaim
                      ? "Ask for the refund"
                      : hasCommissionToClaim
                        ? "Ask for the commission"
                        : action?.code === "settled"
                          ? "Nothing to do"
                          : cardIssued
                            ? "Card to debit"
                            : action?.code === "ours_pay"
                              ? p.payment_method === "CREDIT_CARD"
                                ? "Card to debit"
                                : "Pay by transfer"
                              : "Open in back office"}
                  </button>
                )}
                {/* Only where there is something to consolidate: a provider with no
                  commission document would open an empty page. */}
                {!prov && (p.commission_doc_count ?? 0) > 0 && p.house_code && (
                  <a
                    href={`/commission/${encodeURIComponent(id)}/${encodeURIComponent(p.house_code)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-medium text-[#4B5563] no-underline underline-offset-2 hover:text-navy hover:underline"
                  >
                    <Printer className="h-3 w-3" aria-hidden="true" />
                    Commission statement
                  </a>
                )}
              </span>
            </div>
          </div>
        );
      })}

      <div className="flex items-center justify-between rounded-[10px] border border-border bg-white px-4 py-3">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.07em] text-[#6B7280]">
          Subtotal
          <span className="ml-2 font-normal normal-case tracking-normal text-[#9CA3AF]">
            {payableCount} payable
            {provisionCount > 0
              ? ` · ${provisionCount} provision leg${provisionCount === 1 ? "" : "s"} excluded`
              : ""}
          </span>
        </span>
        <span className="flex items-center gap-[22px] text-right">
          <span>
            <span className="block text-[9.5px] font-bold uppercase tracking-[0.07em] text-[#6B7280]">
              Payable to date
            </span>
            <span className="mt-0.5 block text-[13.5px] tabular-nums text-[#374151]">
              <MultiMoney map={totals} field="payableToDate" />
            </span>
          </span>
          <span>
            <span className="block text-[9.5px] font-bold uppercase tracking-[0.07em] text-[#6B7280]">
              Paid
            </span>
            <span className="mt-0.5 block text-[13.5px] tabular-nums text-[#374151]">
              <MultiMoney map={totals} field="paid" />
            </span>
          </span>
          <span>
            <span className="block text-[9.5px] font-bold uppercase tracking-[0.07em] text-[#6B7280]">
              Outstanding
            </span>
            <span className="mt-0.5 block text-[15px] font-bold tabular-nums">
              <MultiMoney map={totals} field="outstanding" kind="danger" />
            </span>
          </span>
          <span className="w-[92px]" />
        </span>
      </div>
    </div>
  );
}

/**
 * Opens the client statement of account for one booking.
 *
 * A link rather than a download: the statement is a page, printed by the browser,
 * and it reads BigQuery when it loads — so there is nothing cached to hand out and
 * no stale copy to guard against. The tab it opens carries the intended file name
 * as its title, which is what the print dialog offers to save it as.
 */
function StatementButton({
  eventRef,
  tone = "secondary",
}: {
  eventRef: string;
  tone?: "secondary" | "primary";
}) {
  if (!eventRef) return null;
  const className =
    tone === "primary"
      ? "inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-md border border-[#9ed4de] bg-white px-2.5 text-[11px] font-semibold normal-case tracking-normal text-teal-800 no-underline"
      : "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-white px-2.5 text-[12.5px] text-slate-700 no-underline";
  return (
    <a
      href={`/statement/${encodeURIComponent(eventRef)}`}
      target="_blank"
      rel="noreferrer"
      className={className}
    >
      <Printer className="h-3.5 w-3.5" aria-hidden="true" />
      Download statement
    </a>
  );
}

/** The most recent of a set of sends, ignoring the asks that never went out. */
function latestSend(sends: Array<RecoverySend | undefined>): RecoverySend | undefined {
  return sends
    .filter((s): s is RecoverySend => !!s)
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at))
    .pop();
}

/**
 * Where a send button used to be, once the email has gone out.
 *
 * Deliberately a disabled button rather than a hidden one: the shape stays where
 * the eye expects it, and it answers the question the absence of a button would
 * raise — who already did this, and when.
 */
function SentButton({ send }: { send: RecoverySend | undefined }) {
  if (!send) return null;
  return (
    <span
      title={`${send.sent_by}${send.subject ? ` — ${send.subject}` : ""}`}
      className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-[#F3F4F6] px-3 text-[12.5px] font-semibold text-[#6B7280]"
    >
      <Check className="h-3.5 w-3.5" aria-hidden="true" />
      {recoverySentLabel(send)}
    </span>
  );
}

/**
 * The client recovery position, shown above the invoice table.
 *
 * It states the age of the balance on both clocks — the event and the last
 * invoice — because that pair is the whole rule for whether the email goes out,
 * and a figure without its age invites chasing a client who is not late yet.
 */
function ClientRecoveryCard({
  recovery,
  sent,
}: {
  recovery: NaClientRecovery;
  sent: RecoverySend | undefined;
}) {
  const ccy = recovery.currency;
  const owed = recovery.outstanding > 0.01;
  const overpaid = !owed && recovery.paid - recovery.invoiced > 0.01;
  const netted = recovery.docs.some((d) => d.doc_kind === "CREDIT_NOTE");

  const wait = (days: number | null) => (days == null ? "no date on file" : `${days}d ago`);

  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-white shadow-sm">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5">
        <Banknote className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
        <span className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-slate-600">
          Client recovery
        </span>
        <span
          title={sent ? `${sent.sent_by}${sent.subject ? ` — ${sent.subject}` : ""}` : undefined}
          className={`ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-[2px] text-[10.5px] font-semibold ${
            sent
              ? "bg-slate-100 text-slate-600"
              : recovery.eligible
                ? "bg-indigo-100 text-indigo-800"
                : owed
                  ? "bg-amber-100 text-amber-800"
                  : "bg-slate-100 text-slate-600"
          }`}
        >
          {/* Chased already outranks "to chase": the work is done, whoever did it. */}
          {sent ? (
            <>
              <Check className="h-2.5 w-2.5" aria-hidden="true" />
              {recoverySentLabel(sent)}
            </>
          ) : recovery.eligible ? (
            "To chase"
          ) : owed ? (
            `Pending — ${RECOVERY_GRACE_DAYS}d grace`
          ) : overpaid ? (
            "Client in credit"
          ) : (
            "Settled"
          )}
        </span>
      </header>
      <div className="grid grid-cols-3 gap-px bg-border">
        {[
          { label: "Invoiced (live docs)", value: recovery.invoiced },
          { label: "Received", value: recovery.paid },
          { label: "Balance due", value: recovery.outstanding },
        ].map((s, i) => (
          <div key={s.label} className="bg-white px-3.5 py-2.5">
            <div className="text-[9.5px] font-bold uppercase tracking-[0.08em] text-[#0F766E]">
              {s.label}
            </div>
            <div className="mt-0.5 text-[15px] font-semibold tabular-nums">
              <Money
                value={s.value}
                currency={ccy}
                align="left"
                kind={i === 2 ? "danger" : "neutral"}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="border-t border-border px-3.5 py-2 text-[11.5px] leading-relaxed text-slate-600">
        Event {wait(recovery.daysSinceEvent)} · last invoice {wait(recovery.daysSinceInvoice)}
        {recovery.lastInvoiceDay ? ` (${recovery.lastInvoiceDay})` : ""} · {recovery.docs.length}{" "}
        document{recovery.docs.length === 1 ? "" : "s"} counted
        {netted ? ", credit notes netted off" : ""}.
        {!recovery.eligible && owed
          ? ` A balance is chased once it is ${RECOVERY_GRACE_DAYS} days past both the event and the most recent invoice.`
          : ""}
      </p>
    </div>
  );
}

/** Client cash received, itemised — the ledger the recovery email quotes. */
function ClientReceiptsCard({ receipts }: { receipts: NaClientReceipt[] }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-white shadow-sm">
      <header className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <Banknote className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
        <span className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-slate-600">
          Payments received
        </span>
        <span className="text-[10.5px] text-slate-400">{receipts.length}</span>
      </header>
      <table className="w-full border-collapse">
        <tbody>
          {receipts.map((r, i) => (
            <tr key={`receipt-${i}`}>
              <td className="border-b border-slate-100 px-3.5 py-2 text-[12.5px] text-slate-700">
                {fmtDate(r.paid_on)}
              </td>
              <td className="border-b border-slate-100 px-3.5 py-2 text-[12.5px] text-slate-500">
                {r.method ?? "—"}
              </td>
              <td className="max-w-[280px] truncate border-b border-slate-100 px-3.5 py-2 text-[12px] text-slate-500">
                {r.reference ?? "—"}
              </td>
              <td className="border-b border-slate-100 px-3.5 py-2 text-right text-[12.5px] tabular-nums">
                <Money value={r.amount} currency={r.currency} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
  return (
    ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || src[0]?.toUpperCase() || "?"
  );
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
                <span className="font-medium text-text-primary">{c.user_name || c.user_email}</span>
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
              <div className="mt-0.5 whitespace-pre-wrap text-xs text-text-primary">{c.body}</div>
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
        <Button size="sm" onClick={submit} disabled={!user || !body.trim() || addComment.isPending}>
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
    </section>
  );
}
