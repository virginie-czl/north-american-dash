import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRegisterTrackerActions } from "@/components/tracker-chrome";
import { PartnerEmails } from "@/components/partner-emails";
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
import { zipStored } from "@/lib/zip";
import { CommandPalette, type PaletteGroup } from "@/components/command-palette";
import { EventNotes } from "@/components/paper-notes";
import { listCsv, listFileName } from "@/lib/list-export";
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
  PaperLink,
  RailBlock,
  SectionLabel,
  usePaletteShortcut,
} from "@/components/paper";
import {
  archiveName,
  clientStatement,
  supplierStatement,
  type StatementEvent,
} from "@/lib/account-statements";
import {
  fetchNaRecoveryRequests,
  recordNaRecoveryRequests,
  type NaRecoveryRequest,
} from "@/lib/na-recovery-log.functions";
import { useActionIndex } from "@/lib/use-partner-actions";
import { useGmailConnection, useFactScan } from "@/lib/use-gmail";
import { useAddComment, useCommentSummaries } from "@/lib/use-annotations";
import { useCallback, useEffect, Fragment, useMemo, useRef, useState } from "react";
import {
  getNaRows,
  parseNaPartners,
  sumPartners,
  type NaRow,
  type NaPartnerLine,
} from "@/lib/na.functions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PartnerInvoicePdfs } from "@/components/partner-invoice-pdfs";
import { syncCardApprovals } from "@/lib/slack-cards.functions";
import { parseNaInvoices } from "@/lib/na.functions";
import { needsAMove, type Move } from "@/lib/tracker-move";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ArrowUpDown,
  Banknote,
  ChevronDown,
  Download,
  Lock,
  SlidersHorizontal,
} from "lucide-react";

type NaSearch = { list?: NaListKey; ref?: string };

export const Route = createFileRoute("/_authenticated/tracking-north-america")({
  /** The open list and booking live in the URL, so a screen can be linked. */
  validateSearch: (search: Record<string, unknown>): NaSearch => ({
    list: typeof search.list === "string" ? (search.list as NaListKey) : undefined,
    ref: typeof search.ref === "string" ? search.ref : undefined,
  }),
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

/** One list per action type — the spine of the redesigned overview. */
export type NaListKey = "commission" | "refund" | "pay" | "client_refund" | "chase" | "hold";

const NA_LIST_ORDER: NaListKey[] = [
  "commission",
  "refund",
  "pay",
  "client_refund",
  "chase",
  "hold",
];

/**
 * How each list introduces itself.
 *
 * Commission and refund stay two lists on purpose: one is revenue we never
 * collected, the other is cash we paid out by mistake beyond it. They go to
 * different counterparties as different emails, and merging them into a single
 * "to recover" line is exactly what the redesign is undoing.
 */
const NA_LIST_META: Record<
  NaListKey,
  {
    name: string;
    title: (units: number) => string;
    unit: string;
    /** How the list screen explains the rule that produced the work. */
    explanation: string;
    /** The three right-hand columns, in order. */
    columns: [string, string, string];
    /** What the rows are, for "4 more ___ in this list". */
    unitNoun: string;
    primary?: boolean;
    quiet?: boolean;
  }
> = {
  commission: {
    name: "Recover commission",
    title: (n) => `Recover the commission we fronted to ${n} supplier${n === 1 ? "" : "s"}`,
    unit: "commission",
    explanation:
      "One email per supplier, in their language, quoting the booking and the figure. A supplier who also owes a refund gets that as a separate ask — never in the same message. Nothing sends until you confirm.",
    columns: ["Commission", "Paid to date", "Since event"],
    unitNoun: "suppliers",
    primary: true,
  },
  refund: {
    name: "Ask for refunds",
    title: (n) => `Ask ${n} supplier${n === 1 ? "" : "s"} to refund what they were overpaid`,
    unit: "refund",
    explanation:
      "Cash paid out by mistake, beyond the commission. It is a separate claim from the commission and goes out as its own email, even to the same supplier on the same booking.",
    columns: ["Refund", "Paid to date", "Since event"],
    unitNoun: "suppliers",
  },
  pay: {
    name: "Pay suppliers",
    title: (n) => `Pay ${n} supplier${n === 1 ? "" : "s"} on bookings that hold the cash`,
    unit: "to pay out",
    explanation:
      "Client money received covers these. Virtual-card legs and provision lines are excluded, and a line the EM has not locked cannot be paid yet.",
    columns: ["To pay", "Available cash", "Since event"],
    unitNoun: "suppliers",
  },
  client_refund: {
    name: "Refund clients",
    title: (n) => `Refund ${n} client${n === 1 ? "" : "s"} who paid more than we invoiced`,
    unit: "to refund",
    explanation:
      "The client paid beyond what we billed them, and the event is past the 14-day window — a late invoice no longer closes the gap.",
    columns: ["To refund", "Invoiced", "Since event"],
    unitNoun: "bookings",
  },
  chase: {
    name: "Chase clients",
    title: (n) => `Chase ${n} client${n === 1 ? "" : "s"} whose balance is still open`,
    unit: "client outstanding",
    explanation:
      "Invoiced and not yet received. Where a supplier payout is waiting on the money, the row says so — that booking cannot settle until the client pays.",
    columns: ["Client outstanding", "Invoiced", "Since event"],
    unitNoun: "bookings",
  },
  hold: {
    name: "Leave alone",
    title: (n) => `Leave ${n} booking${n === 1 ? "" : "s"} alone for now`,
    unit: "pending",
    explanation:
      "Inside the 14 days after the event, where amounts usually settle on their own, or waiting on a supplier's reply. The countdown is on each row.",
    columns: ["Pending", "Client outstanding", "Since event"],
    unitNoun: "bookings",
    quiet: true,
  },
};

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

/**
 * `NA-2411-4362 · Lightspeed · Leadership offsite · venue finding · Naboo Canada · 27 March`
 *
 * Everything that identifies a booking, in one mono line — the deal shape and
 * the billing entity included, because they change how it is invoiced and paid.
 */
function naMetaLine(row: NaRow): string {
  return [
    row.readable_id ?? "—",
    row.company_name,
    row.event_name,
    (row.transaction_kind ?? "").replaceAll("_", " ").toLowerCase() || null,
    row.billing_entity,
    row.start_date ? fmtDate(row.start_date) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Who owns the booking, whether the supplier line is locked, and whatever else
 * the row needs to say. The lock matters on every payout: the EM has to set it
 * before we can pay.
 */
function naStateLine(
  row: NaRow,
  partner: NaPartnerLine | null,
  asked: NaRecoveryRequest | null | undefined,
  extra?: string | null,
): string {
  const bits = [
    row.sales_referent ? `Sales ${row.sales_referent}` : null,
    row.em_referent ? `EM ${row.em_referent}` : null,
  ].filter(Boolean) as string[];
  if (partner) {
    bits.push(
      partner.locked_by_admin
        ? "locked by admin"
        : partner.locked_by_client
          ? "locked by client"
          : partner.locked
            ? "locked"
            : `not locked — ask ${row.em_referent ?? "the EM"}`,
    );
    if ((partner.payment_method ?? "").toUpperCase() === "CREDIT_CARD") {
      bits.push("settled by virtual card");
    }
  }
  if (asked) {
    bits.push(
      `asked ${fmtAskedOn(asked.last_asked_at)}${
        asked.times_asked > 1 ? ` · ${asked.times_asked} times` : ", no reply yet"
      }`,
    );
  }
  if (extra) bits.push(extra);
  return bits.join(" · ");
}

function statementEvent(row: NaRow): StatementEvent {
  const from = (row.start_date ?? "").slice(0, 10);
  const to = (row.end_date ?? "").slice(0, 10);
  return {
    ref: row.readable_id ?? "—",
    client: row.company_name ?? "client",
    eventType: row.event_name || (row.event_type ?? "").replaceAll("_", " ").toLowerCase() || null,
    dates: from ? (from === to || !to ? from : `${from} – ${to}`) : null,
    currency: row.currency_client,
  };
}

/**
 * One statement per supplier on a booking. Provision legs are left out: they are
 * not payable and the booking view already says so.
 */
function naSupplierStatement(row: NaRow, p: ReturnType<typeof parseNaPartners>[number]) {
  const claw = partnerClawback(p);
  return supplierStatement(statementEvent(row), {
    name: p.name ?? "Prestataire inconnu",
    email: p.email,
    currency: p.currency,
    payable: p.payable,
    due: Math.max(p.outstanding ?? 0, 0),
    paid: p.paid,
    commission: p.commission,
    commissionToRecover: claw.commission,
    refundToRecover: claw.refund,
    payments: (p.disbursements ?? []).map((d) => ({
      amount: d.amount,
      paidOn: d.paid_on,
      method: d.method,
      reference: d.reference,
    })),
  });
}

function naSupplierStatements({
  row,
  partners,
}: {
  row: NaRow;
  partners: ReturnType<typeof parseNaPartners>;
}) {
  return partners.filter((p) => !p.is_provision).map((p) => naSupplierStatement(row, p));
}

function naClientStatement({ row }: { row: NaRow }, invoices: ReturnType<typeof parseNaInvoices>) {
  return clientStatement(statementEvent(row), {
    invoiced: row.invoiced_ccy,
    collected: row.paid_ccy,
    outstanding: row.balance_ccy,
    invoices: invoices.map((i) => ({
      ref: i.invoice_ref,
      status: i.status,
      issued: (i.emission_date ?? "").slice(0, 10),
      sent: i.is_sent ? "yes" : "",
      due: (i.due_date ?? "").slice(0, 10),
      amount: i.amount_ttc,
    })),
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
  const [scope, setScope] = useState<"move" | "commission" | "refund" | "client_refund" | "all">(
    "all",
  );
  // Where we are, read from the URL.
  const navigate = Route.useNavigate();
  const params = Route.useSearch();
  const activeList = params.list && NA_LIST_ORDER.includes(params.list) ? params.list : null;
  const selectedRef = params.ref ?? "";
  const setSelectedRef = useCallback(
    (value: string) =>
      navigate({ search: (prev: NaSearch) => ({ ...prev, ref: value || undefined }) }),
    [navigate],
  );
  const goToOverview = useCallback(() => navigate({ search: {} }), [navigate]);
  const openList = useCallback((key: NaListKey) => navigate({ search: { list: key } }), [navigate]);
  // ⌘K.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteCursor, setPaletteCursor] = useState(0);
  /** The rows ticked on an action list, by row id. */
  const [selection, setSelection] = useState<Set<string>>(new Set());
  /** Which of the booking's side panels is open. */
  const [panel, setPanel] = useState<"emails" | "docs" | null>(null);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  /** How stale the figures are, so the header can say so. */
  const cachedAge = data?.cachedAgeSeconds ?? null;

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

  const { factsMap, actionFor, eventNeedsScan, cardApprovedCodes } = useActionIndex();
  const { data: gmailConnection } = useGmailConnection();
  const { progress: scanProgress, start: startScan } = useFactScan();
  const commissionRefundDialog = useNaCommissionRequestDialog();
  const queryClient = useQueryClient();
  // Refreshing the mirror is explicit, so a cold instance never pays for Slack.
  const syncCards = useMutation({
    mutationFn: () => syncCardApprovals(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["slack-card-approvals"] }),
  });

  // Recovery emails already sent, so the tracker stops offering an ask that has
  // gone out. Keyed the same way as the summaries: event + partner.
  const { data: recoveryLog } = useQuery({
    queryKey: ["na-recovery-log"],
    queryFn: async () => {
      const rows = await fetchNaRecoveryRequests();
      const map = new Map<string, NaRecoveryRequest>();
      for (const r of rows) map.set(`${r.event_ref}::${r.partner_key}`, r);
      return map;
    },
    staleTime: 60_000,
  });

  const askedFor = useCallback(
    (eventRef: string, partnerName: string | null | undefined) =>
      recoveryLog?.get(`${eventRef}::${partnerKey(partnerName ?? "")}`) ?? null,
    [recoveryLog],
  );

  /**
   * Recording an ask that went out before this tracker kept track — or one sent
   * straight from Gmail. Without it the log only ever knows about the future,
   * and every commission asked for last month still reads as untouched.
   */
  const markAsked = useMutation({
    mutationFn: (row: {
      event_ref: string;
      partner_key: string;
      partner_name: string | null;
      mode: string;
      sent_to: string | null;
    }) => recordNaRecoveryRequests({ data: { rows: [row] } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["na-recovery-log"] }),
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

        // The booking's event manager knows the file — copy them, and never
        // the provider's own address twice over.
        const em = r.em_referent_email?.trim() ?? "";
        const cc = em && em.toLowerCase() !== contact.address.toLowerCase() ? em : undefined;

        // Already asked? The amounts will not move until they pay, so the ask
        // has to be remembered or it gets offered again on every load.
        const asked = askedFor(eventRef, p.name);
        const askedAt = asked?.last_asked_at ?? undefined;
        const timesAsked = asked?.times_asked ?? 0;

        if (cb.commission > 0.01 && cb.refund > 0.01) {
          const combined = composeNaCombinedRequest(r, p, contact);
          if (combined) {
            targets.push({
              eventRef,
              partnerName: p.name,
              address: contact.address,
              contactName: contact.name,
              cc,
              askedAt,
              timesAsked,
              ...combined,
              mode: "combined",
            });
          }
        } else if (cb.commission > 0.01) {
          const commission = composeNaCommissionRequest(r, p, contact);
          if (commission) {
            targets.push({
              eventRef,
              partnerName: p.name,
              address: contact.address,
              contactName: contact.name,
              cc,
              askedAt,
              timesAsked,
              ...commission,
              mode: "commission",
            });
          }
        } else {
          const refund = composeNaRefundRequest(r, p, contact);
          if (refund) {
            targets.push({
              eventRef,
              partnerName: p.name,
              address: contact.address,
              contactName: contact.name,
              cc,
              askedAt,
              timesAsked,
              ...refund,
              mode: "refund",
            });
          }
        }
      }
    }
    return targets;
  }, [sorted, askedFor]);

  /** Never asked. The batch buttons offer these; a chase stays a per-partner call. */
  const unaskedRecoveryTargets = useMemo(
    () => commissionRefundTargets.filter((t) => !t.askedAt),
    [commissionRefundTargets],
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
      ],
      search: {
        placeholder: "Booking, company, event, supplier",
        onOpen: () => setPaletteOpen(true),
      },
      status: {
        text:
          cachedAge == null
            ? "Figures just recomputed"
            : cachedAge < 90
              ? `Figures cached ${cachedAge} s ago`
              : `Figures cached ${Math.round(cachedAge / 60)} min ago`,
        action: {
          label: "Recompute",
          onClick: async () => {
            await queryClient.fetchQuery({
              queryKey: ["na-rows"],
              queryFn: () => getNaRows({ data: { force: true } }),
            });
            syncCards.mutate();
          },
        },
      },
    },
    [isFetching, sorted.length, recoverCount, cachedAge],
  );

  // ── Split view ────────────────────────────────────────────────────────────
  // Presentation only. Amounts, tags, email actions and the commission/refund
  // dialogs all come from the same hooks and helpers as the previous layout.

  // One move per booking, derived from the same helpers the partner cards use so
  // the pills, the scope counts and the dialog agree.
  const moveFor = useCallback(
    (r: NaRow, ps: ReturnType<typeof parseNaPartners>): Move => {
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

      if ((r.balance_ccy ?? 0) > 0.01) {
        return {
          group: "client",
          label: "Client to pay",
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
    () => filtered.map((item) => ({ ...item, move: moveFor(item.row, item.partners) })),
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
      all: () => true,
    }),
    [],
  );

  /**
   * Which action lists a booking belongs to, and what it contributes to each.
   *
   * Read straight off the move the page already computes, so a booking cannot
   * appear in a list the move model disagrees with — and one booking can sit in
   * several lists, which is the point.
   */
  const listed = useMemo(
    () =>
      withMove.map((x) => {
        const claw = rowClawbackSplit(x.partners);
        const toPay = rowPartnerToPay(x.row, x.partners);
        const clientBal = x.row.balance_ccy ?? 0;
        const ccy = x.row.currency_client ?? "—";
        const live = x.partners.filter((p) => !p.is_provision);

        const keys = new Set<NaListKey>();
        if (x.move.headlineLabel.includes("commission")) keys.add("commission");
        if (x.move.headlineLabel.includes("refund to recover")) keys.add("refund");
        if (x.move.label === "Pay the partner") keys.add("pay");
        if (x.move.headlineLabel.includes("client to refund")) keys.add("client_refund");
        if (x.move.group === "client") keys.add("chase");
        if (x.move.group === "waiting") keys.add("hold");

        const clientCredit =
          clientBal < -0.01 ? new Map([[ccy, -clientBal]]) : new Map<string, number>();
        const clientOwed =
          clientBal > 0.01 ? new Map([[ccy, clientBal]]) : new Map<string, number>();
        const pending = new Map<string, number>();
        for (const m of [claw.commission, claw.refund, toPay, clientCredit]) {
          for (const [c, v] of m) pending.set(c, (pending.get(c) ?? 0) + v);
        }

        return {
          x,
          keys,
          /** A booking owed money it cannot pay out yet, because it holds no cash. */
          blockedByCash: x.move.group === "client" && toPay.size > 0,
          units: {
            commission: live.filter((p) => partnerClawback(p).commission > 0.01).length,
            refund: live.filter((p) => partnerClawback(p).refund > 0.01).length,
            pay: live.filter((p) => (p.outstanding ?? 0) > 0.01).length,
            client_refund: 1,
            chase: 1,
            hold: 1,
          } as Record<NaListKey, number>,
          amounts: {
            commission: claw.commission,
            refund: claw.refund,
            pay: toPay,
            client_refund: clientCredit,
            chase: clientOwed,
            hold: pending,
          } as Record<NaListKey, Map<string, number>>,
        };
      }),
    [withMove],
  );

  const actionLists = useMemo(() => {
    const blocked = listed.filter((l) => l.blockedByCash).length;
    return NA_LIST_ORDER.map((key) => {
      const members = listed.filter((l) => l.keys.has(key));
      const units = members.reduce((total, l) => total + l.units[key], 0);
      const byCcy = new Map<string, number>();
      members.forEach((l) => {
        for (const [c, v] of l.amounts[key]) byCcy.set(c, (byCcy.get(c) ?? 0) + v);
      });
      const meta = NA_LIST_META[key];
      const detail =
        key === "commission"
          ? "Revenue we never collected · one email per supplier, never mixed with a refund"
          : key === "refund"
            ? "Cash paid out by mistake, beyond the commission · separate claim, separate email"
            : key === "pay"
              ? blocked > 0
                ? `Client money received covers them · ${blocked} more ${blocked === 1 ? "is" : "are"} payable but their booking holds no cash yet, so the client comes first`
                : "Client money received covers them"
              : key === "client_refund"
                ? "Past the 14-day window · a late invoice no longer closes the gap"
                : key === "chase"
                  ? blocked > 0
                    ? `${blocked} of them block a supplier payout · sales and EM are named on every row`
                    : "Sales and EM are named on every row"
                  : "Inside the 14 days after the event, or waiting on a supplier's reply";
      return { key, meta, events: members.length, units, byCcy, title: meta.title(units), detail };
    });
  }, [listed]);

  /** The four headline figures, each by currency. */
  const portfolio = useMemo(() => {
    const add = (m: Map<string, number>, ccy: string, v: number) =>
      m.set(ccy, (m.get(ccy) ?? 0) + v);
    const toCashIn = new Map<string, number>();
    const cash = new Map<string, number>();
    const toPay = new Map<string, number>();
    const toRecover = new Map<string, number>();
    const commission = new Map<string, number>();
    const refund = new Map<string, number>();
    let inGrace = 0;
    for (const l of listed) {
      const ccy = l.x.row.currency_client ?? "—";
      const bal = l.x.row.balance_ccy ?? 0;
      if (bal > 0.01) add(toCashIn, ccy, bal);
      const available = availableCash(l.x.row, l.x.partners);
      if (available > 0.01) add(cash, ccy, available);
      for (const [c, v] of l.amounts.pay) add(toPay, c, v);
      for (const [c, v] of l.amounts.commission) {
        add(toRecover, c, v);
        add(commission, c, v);
      }
      for (const [c, v] of l.amounts.refund) {
        add(toRecover, c, v);
        add(refund, c, v);
      }
      const age = daysSinceEvent(l.x.row);
      if (age != null && age < 14) inGrace += 1;
    }
    return { toCashIn, cash, toPay, toRecover, commission, refund, inGrace };
  }, [listed]);

  const scoped = useMemo(() => {
    let base = withMove;
    if (activeList) {
      const inList = new Set(listed.filter((l) => l.keys.has(activeList)).map((l) => l.x.row));
      base = base.filter((x) => inList.has(x.row));
    }
    return base.filter(SCOPE_TEST[scope]);
  }, [withMove, scope, SCOPE_TEST, activeList, listed]);

  const scopeCounts = useMemo(
    () => ({
      move: withMove.filter(SCOPE_TEST.move).length,
      commission: withMove.filter(SCOPE_TEST.commission).length,
      refund: withMove.filter(SCOPE_TEST.refund).length,
      clientRefund: withMove.filter(SCOPE_TEST.client_refund).length,
      all: withMove.length,
    }),
    [withMove, SCOPE_TEST],
  );

  const selected = useMemo(
    () =>
      selectedRef
        ? (withMove.find(({ row }) => (row.readable_id ?? "") === selectedRef) ?? null)
        : null,
    [withMove, selectedRef],
  );

  const sel = selected?.row ?? null;
  const selPartners = selected?.partners ?? [];
  const selRef = sel?.readable_id ?? "";
  const selTotals = useMemo(() => sumPartners(selPartners), [selPartners]);
  const selInvoices = useMemo(() => parseNaInvoices(sel?.invoices_json ?? null), [sel]);

  usePaletteShortcut(useCallback(() => setPaletteOpen(true), []));

  /**
   * Every statement for the open booking as one archive: one per supplier, plus
   * the client's. This is the download the tracker is asked for most.
   */
  const downloadBookingStatements = useCallback(() => {
    if (!selected) return;
    const invoices = parseNaInvoices(selected.row.invoices_json ?? null);
    const entries = [
      ...naSupplierStatements({ row: selected.row, partners: selected.partners }),
      naClientStatement({ row: selected.row }, invoices),
    ];
    downloadBlob(
      new Blob([zipStored(entries)], { type: "application/zip" }),
      `${(selected.row.readable_id ?? "booking").replace(/[^\w-]/g, "-")}-account-statement.zip`,
    );
  }, [selected]);

  /**
   * The filters that were always here, kept where they belong on a list screen:
   * behind one control, so the rows stay the loudest thing on the page.
   */
  const naFilters = (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-2 text-paper-body underline-offset-[3px] hover:underline"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.6} aria-hidden="true" />
          Filters
          {(eventType !== "all" ||
            sales !== "all" ||
            em !== "all" ||
            ccy !== "all" ||
            billing.size > 0 ||
            showAncient ||
            search.trim() !== "") && (
            <span className="font-paper-mono text-[11px] text-paper-label">on</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] space-y-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Narrow to a booking, company or supplier…"
          aria-label="Narrow the list"
          className="h-8 text-[12px]"
        />
        <FilterSelect label="Type" value={eventType} onChange={setEventType} options={kinds} />
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
  );

  /**
   * The rows of the open action list.
   *
   * A list about suppliers has one row per supplier — the unit the overview
   * counted — and a list about the client has one row per booking. Commission
   * and refund stay separate all the way down: two claims, two rows, two
   * emails, even for the same supplier on the same booking.
   */
  const naListRows = useMemo<PaperRow[]>(() => {
    if (!activeList) return [];
    const out: PaperRow[] = [];
    for (const entry of listed) {
      if (!entry.keys.has(activeList)) continue;
      const { row: r, partners } = entry.x;
      const ref = r.readable_id ?? "";
      const ccy = r.currency_client ?? "—";
      const meta = naMetaLine(r);
      const since = daysSinceEvent(r);
      const sinceLabel = since == null ? "—" : `${since} d`;
      const cash = availableCash(r, partners);

      if (activeList === "commission" || activeList === "refund") {
        for (const p of partners) {
          if (p.is_provision) continue;
          const claw = partnerClawback(p);
          const amount = activeList === "commission" ? claw.commission : claw.refund;
          if (amount <= 0.01) continue;
          const other = activeList === "commission" ? claw.refund : claw.commission;
          const asked = askedFor(ref, p.name);
          const target = commissionRefundTargets.find(
            (t) => t.eventRef === ref && t.partnerName === p.name,
          );
          out.push({
            id: `${ref}::${partnerKey(p.name ?? "")}::${activeList}`,
            ref,
            lead: "Ask",
            strong: p.name ?? "this supplier",
            tail:
              activeList === "commission"
                ? `for the ${fmtAmount(amount)} ${ccyLabel(p.currency ?? ccy)} commission we fronted on their payout`
                : `to refund the ${fmtAmount(amount)} ${ccyLabel(p.currency ?? ccy)} they were overpaid`,
            meta,
            state:
              other > 0.01
                ? `Also owes a ${fmtAmount(other)} ${ccyLabel(p.currency ?? ccy)} ${
                    activeList === "commission" ? "refund" : "commission"
                  } — it goes out as a second, separate email`
                : naStateLine(r, p, asked),
            stateAlert: other > 0.01,
            a: fmtAmount(amount) ?? "—",
            aCcy: p.currency ?? ccy,
            b: fmtAmount(p.paid ?? 0) ?? "—",
            trail: sinceLabel,
            target,
          });
        }
        continue;
      }

      if (activeList === "pay") {
        for (const p of partners) {
          if (p.is_provision) continue;
          if ((p.outstanding ?? 0) <= 0.01) continue;
          if ((p.payment_method ?? "").toUpperCase() === "CREDIT_CARD") continue;
          out.push({
            id: `${ref}::${partnerKey(p.name ?? "")}::pay`,
            ref,
            lead: "Pay",
            strong: p.name ?? "this supplier",
            tail: `${fmtAmount(p.outstanding ?? 0)} ${ccyLabel(p.currency ?? ccy)}`,
            meta,
            state: naStateLine(
              r,
              p,
              null,
              p.locked
                ? cash > 0.01
                  ? "the booking holds the cash"
                  : "the booking holds no cash yet — the client comes first"
                : "the line is not locked yet",
            ),
            stateAlert: !p.locked,
            a: fmtAmount(p.outstanding ?? 0) ?? "—",
            aCcy: p.currency ?? ccy,
            b: fmtAmount(cash) ?? "—",
            bCcy: ccy,
            trail: sinceLabel,
          });
        }
        continue;
      }

      const balance = r.balance_ccy ?? 0;
      if (activeList === "client_refund") {
        out.push({
          id: ref,
          ref,
          lead: "Refund",
          strong: r.company_name ?? "this client",
          tail: `${fmtAmount(Math.abs(balance))} ${ccyLabel(ccy)} they paid beyond what we invoiced`,
          meta,
          state: naStateLine(r, null, null, "a late invoice no longer closes the gap"),
          a: fmtAmount(Math.abs(balance)) ?? "—",
          aCcy: ccy,
          b: fmtAmount(r.invoiced_ccy ?? 0) ?? "—",
          trail: sinceLabel,
        });
        continue;
      }

      if (activeList === "chase") {
        out.push({
          id: ref,
          ref,
          lead: "Chase",
          strong: r.company_name ?? "this client",
          tail: `for the ${fmtAmount(balance)} ${ccyLabel(ccy)} still open`,
          meta,
          state: naStateLine(
            r,
            null,
            null,
            entry.blockedByCash ? "a supplier payout is waiting on this money" : null,
          ),
          stateAlert: entry.blockedByCash,
          a: fmtAmount(balance) ?? "—",
          aCcy: ccy,
          b: fmtAmount(r.invoiced_ccy ?? 0) ?? "—",
          trail: sinceLabel,
        });
        continue;
      }

      // hold
      const pending = [...entry.amounts.hold.values()].reduce((a, b) => a + b, 0);
      out.push({
        id: ref,
        ref,
        lead: "Leave",
        strong: r.company_name ?? "this booking",
        tail: "alone for now",
        meta,
        state: naStateLine(
          r,
          null,
          null,
          since != null && since < 14
            ? `inside the 14 days after the event — ${14 - since} to go`
            : "waiting on a supplier's reply",
        ),
        a: fmtAmount(pending) ?? "—",
        aCcy: ccy,
        b: fmtAmount(Math.max(balance, 0)) ?? "—",
        trail: sinceLabel,
      });
    }
    return out;
  }, [activeList, listed, askedFor, commissionRefundTargets]);

  /**
   * A list opens with everything ticked — the point of the screen is to clear
   * it. Only re-ticks when the list itself changes, so unticking sticks.
   */
  useEffect(() => {
    setSelection(new Set(naListRows.filter((r) => r.target).map((r) => r.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeList]);

  const selectedTargets = useMemo(
    () =>
      naListRows
        .filter((r) => r.target && selection.has(r.id))
        .map((r) => r.target as NaCommissionTarget),
    [naListRows, selection],
  );

  /** ⌘K over bookings, the suppliers on them, and their invoices. */
  const naPaletteGroups = useMemo<PaletteGroup[]>(() => {
    const q = paletteQuery.trim().toLowerCase();
    if (!q) return [];
    const open = (ref: string) => {
      setSelectedRef(ref);
      setPaletteOpen(false);
    };
    const hits = decorated.filter(({ row: r, partners }) =>
      [
        r.readable_id,
        r.company_name,
        r.event_name,
        r.sales_referent,
        r.em_referent,
        r.billing_entity,
        ...partners.map((p) => `${p.name ?? ""} ${p.email ?? ""}`),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );

    const bookings = hits.slice(0, 6).map(({ row: r, partners }) => {
      const entry = listed.find((l) => l.x.row === r);
      const moves = entry ? [...entry.keys].filter((k) => k !== "hold").length : 0;
      const claw = rowClawbackSplit(partners);
      const recover = [...claw.commission.values(), ...claw.refund.values()].reduce(
        (a, b) => a + b,
        0,
      );
      return {
        id: `booking-${r.readable_id}`,
        title: `${r.readable_id ?? "—"} · ${r.company_name ?? ""}`.trim(),
        meta: [
          r.event_name,
          (r.transaction_kind ?? "").replaceAll("_", " ").toLowerCase() || null,
          r.billing_entity,
          r.start_date ? fmtDate(r.start_date) : null,
          r.sales_referent ? `Sales ${r.sales_referent}` : null,
          r.em_referent ? `EM ${r.em_referent}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        amount:
          recover > 0.01
            ? (fmtAmount(recover) ?? undefined)
            : (fmtAmount(Math.max(r.balance_ccy ?? 0, 0)) ?? undefined),
        amountLabel: recover > 0.01 ? "to recover" : "client outstanding",
        amountAlert: recover > 0.01,
        note: moves > 0 ? `${moves} move${moves === 1 ? "" : "s"} waiting` : null,
        onPick: () => open(r.readable_id ?? ""),
      };
    });

    const suppliers = hits
      .slice(0, 3)
      .flatMap(({ row: r, partners }) =>
        partners
          .filter((p) => !p.is_provision)
          .filter(
            (p) =>
              `${p.name ?? ""} ${p.email ?? ""}`.toLowerCase().includes(q) || hits.length === 1,
          )
          .map((p) => {
            const claw = partnerClawback(p);
            const both = claw.commission > 0.01 && claw.refund > 0.01;
            return {
              id: `supplier-${r.readable_id}-${partnerKey(p.name ?? "")}`,
              title: p.name ?? "—",
              meta: both
                ? "Commission and refund both open · two separate emails"
                : claw.commission > 0.01
                  ? "Commission to recover"
                  : claw.refund > 0.01
                    ? "Refund to recover"
                    : p.locked
                      ? "Payable, line locked"
                      : "Payable, line not locked",
              metaAlert: claw.commission > 0.01 || claw.refund > 0.01,
              amount:
                fmtAmount(
                  Math.max(claw.commission + claw.refund, 0) > 0.01
                    ? claw.commission + claw.refund
                    : (p.outstanding ?? 0),
                ) ?? undefined,
              onPick: () => open(r.readable_id ?? ""),
            };
          }),
      )
      .slice(0, 6);

    return [
      { label: "Booking", items: bookings },
      { label: "Suppliers on this booking", items: suppliers },
    ];
  }, [paletteQuery, decorated, listed, setSelectedRef]);

  /**
   * Everything the open booking's screen needs.
   *
   * The rules this tracker has and L'Oréal does not all show up here:
   * commission and refund as two claims, the 14-day grace window, available
   * cash deciding whose move a payout is, locks, provision legs and virtual
   * cards excluded from what is payable, and several currencies at once.
   */
  const bookingScreen = useMemo(() => {
    if (!sel) return null;
    const ccy = sel.currency_client ?? "—";
    const money = (v: number | null | undefined, currency?: string | null) =>
      `${fmtAmount(v ?? 0) ?? "—"} ${ccyLabel(currency ?? ccy)}`;
    const cash = availableCash(sel, selPartners);
    const toPay = partnerToBePaidTotals(selTotals, selPartners);
    const toPayTotal = [...toPay.values()].reduce((a, b) => a + b, 0);
    const since = daysSinceEvent(sel);
    const claw = rowClawbackSplit(selPartners);
    const payable = selPartners.filter((p) => !p.is_provision);
    const provisions = selPartners.length - payable.length;

    const stats = [
      { label: "Client GMV", value: money(sel.gmv_client_ccy) },
      { label: "Invoiced", value: money(sel.invoiced_ccy) },
      { label: "Received", value: money(sel.paid_ccy) },
      {
        label: "To cash in",
        value: money(Math.max(sel.balance_ccy ?? 0, 0)),
        muted: (sel.balance_ccy ?? 0) <= 0.01,
      },
      { label: "Available cash", value: money(cash), muted: cash <= 0.01 },
      { label: "To pay suppliers", value: money(toPayTotal), muted: toPayTotal <= 0.01 },
    ];

    const inGrace = since != null && since < 14;
    const moves: EventMove[] = [];
    for (const p of payable) {
      const cb = partnerClawback(p);
      const asked = askedFor(selRef, p.name);
      const target = commissionRefundTargets.find(
        (t) => t.eventRef === selRef && t.partnerName === p.name,
      );
      if (cb.commission > 0.01) {
        moves.push({
          id: `commission-${partnerKey(p.name ?? "")}`,
          lead: "Ask",
          strong: p.name ?? "this supplier",
          tail: `for the ${money(cb.commission, p.currency)} commission we fronted`,
          reason: inGrace
            ? `Only ${since} days since the event — inside the 14-day window, the figures can still move.`
            : `${since ?? "—"} days since the event, so the figures are final. Revenue we never collected.${
                asked ? ` Asked ${fmtAskedOn(asked.last_asked_at)}.` : ""
              }`,
          reasonAlert: false,
          action:
            gmailConnection?.connected && target
              ? {
                  label: asked ? "Ask again" : "Review & send",
                  primary: !asked,
                  onClick: () => commissionRefundDialog.open([target]),
                }
              : undefined,
        });
      }
      if (cb.refund > 0.01) {
        moves.push({
          id: `refund-${partnerKey(p.name ?? "")}`,
          lead: "Ask",
          strong: p.name ?? "this supplier",
          tail: `to refund the ${money(cb.refund, p.currency)} they were overpaid`,
          reason:
            "Cash paid out beyond the commission · it goes out as its own email, not merged with the ask above",
          reasonAlert: true,
          action:
            gmailConnection?.connected && target
              ? {
                  label: "Review & send",
                  onClick: () => commissionRefundDialog.open([target]),
                }
              : undefined,
        });
      }
      if ((p.outstanding ?? 0) > 0.01 && (p.payment_method ?? "").toUpperCase() !== "CREDIT_CARD") {
        moves.push({
          id: `pay-${partnerKey(p.name ?? "")}`,
          lead: "Pay",
          strong: p.name ?? "this supplier",
          tail: money(p.outstanding, p.currency),
          reason: !p.locked
            ? `The line is not locked yet — ${sel.em_referent ?? "the EM"} has to lock it before we can pay.`
            : cash > 0.01
              ? "The booking holds the cash for it."
              : "The booking holds no cash yet, so the client comes first.",
          reasonAlert: !p.locked || cash <= 0.01,
          action: sel.booking_url
            ? {
                label: "Open the back office",
                onClick: () => window.open(sel.booking_url as string, "_blank"),
              }
            : undefined,
        });
      }
    }
    if ((sel.balance_ccy ?? 0) > 0.01) {
      moves.push({
        id: "chase",
        lead: "Chase",
        strong: sel.company_name ?? "the client",
        tail: `for the ${money(sel.balance_ccy)} still open`,
        reason:
          toPayTotal > 0.01
            ? "A supplier payout is waiting on this money."
            : "Invoiced and not yet received.",
        reasonAlert: toPayTotal > 0.01,
      });
    }
    if ((sel.balance_ccy ?? 0) < -0.01) {
      moves.push({
        id: "client-refund",
        lead: "Refund",
        strong: sel.company_name ?? "the client",
        tail: `${money(Math.abs(sel.balance_ccy ?? 0))} they paid beyond what we invoiced`,
        reason: "A late invoice no longer closes the gap.",
      });
    }

    const partnerRows: EventPartnerRow[] = selPartners.map((p) => {
      const cb = partnerClawback(p);
      const recover = cb.commission + cb.refund;
      const card = (p.payment_method ?? "").toUpperCase() === "CREDIT_CARD";
      const key = partnerKey(p.name ?? p.email ?? "");
      // What we already sent them. The amounts stay put until they pay, so
      // without this the screen asks for the same money indefinitely.
      const askedThis = recover > 0.01 ? askedFor(selRef, p.name) : null;
      const recap = financialSummaries?.get(`${selRef}::${key}`);
      return {
        key,
        name: p.is_provision ? `${p.name ?? "Provision"} — to be quoted` : (p.name ?? "—"),
        contact: p.is_provision
          ? "provision leg · excluded from what is payable"
          : [
              p.email,
              p.locked_by_admin
                ? "locked by admin"
                : p.locked_by_client
                  ? "locked by client"
                  : p.locked
                    ? "locked"
                    : `not locked — ask ${sel.em_referent ?? "the EM"}`,
            ]
              .filter(Boolean)
              .join(" · "),
        state: p.is_provision
          ? "Nothing can be paid or claimed on this line until a quote lands."
          : recover > 0.01
            ? `Paid ${money(p.paid, p.currency)}. ${
                cb.commission > 0.01 && cb.refund > 0.01
                  ? "We fronted the commission and overpaid on top of it — two claims open."
                  : cb.commission > 0.01
                    ? "We fronted the commission and never invoiced it back."
                    : "They were paid beyond what they were owed."
              }${
                askedThis
                  ? ` Asked ${fmtAskedOn(askedThis.last_asked_at)}${
                      askedThis.times_asked > 1 ? `, ${askedThis.times_asked} times` : ""
                    }, by ${askedThis.last_asked_by ?? "someone"}.`
                  : ""
              }`
            : card
              ? "Settled by virtual card. Nothing owed either way."
              : (p.outstanding ?? 0) > 0.01
                ? p.locked
                  ? "Payable, and the line is locked."
                  : "Payable, but the line is not locked yet."
                : "Nothing owed either way.",
        stateAlert: recover > 0.01,
        muted: !!p.is_provision,
        note: recap
          ? `${recap.summary} — from ${recap.message_count} message${
              recap.message_count === 1 ? "" : "s"
            }, summarised by ${recap.generated_by ?? "us"}.`
          : null,
        figures: p.is_provision
          ? [
              { label: "Payable to date", value: "—" },
              { label: "Paid", value: "—" },
              { label: "Outstanding", value: "—" },
            ]
          : [
              { label: "Payable to date", value: fmtAmount(p.payable_to_date ?? 0) ?? "—" },
              { label: "Paid", value: fmtAmount(p.paid ?? 0) ?? "—" },
              recover > 0.01
                ? {
                    label: "To recover",
                    value: fmtAmount(recover) ?? "—",
                    alert: true,
                    note: [
                      cb.commission > 0.01 ? `${fmtAmount(cb.commission)} comm` : null,
                      cb.refund > 0.01 ? `${fmtAmount(cb.refund)} refund` : null,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  }
                : {
                    label: "Outstanding",
                    value: fmtAmount(p.outstanding ?? 0) ?? "—",
                    note: card ? "virtual card" : null,
                  },
            ],
        links: p.is_provision ? undefined : (
          <>
            <DownloadLink
              className="text-[12.5px]"
              onClick={() => {
                const entry = naSupplierStatement(sel, p);
                downloadBlob(new Blob([entry.bytes], { type: "application/pdf" }), entry.name);
              }}
            >
              Supplier statement
            </DownloadLink>
            {p.email && (
              <PaperLink
                onClick={() =>
                  summarize.mutate({
                    event_ref: selRef,
                    partner_name: p.name ?? p.email ?? "",
                    partner_email: p.email,
                  })
                }
              >
                {summarize.isPending && summarize.variables?.partner_name === (p.name ?? p.email)
                  ? "Summarising…"
                  : recap
                    ? "Re-summarise our emails"
                    : "Summarise our emails"}
              </PaperLink>
            )}
            {recover > 0.01 && !askedThis && (
              <PaperLink
                onClick={() =>
                  markAsked.mutate({
                    event_ref: selRef,
                    partner_key: key,
                    partner_name: p.name,
                    mode:
                      cb.commission > 0.01 && cb.refund > 0.01
                        ? "combined"
                        : cb.commission > 0.01
                          ? "commission"
                          : "refund",
                    sent_to: p.email,
                  })
                }
              >
                Already asked — note it
              </PaperLink>
            )}
          </>
        ),
      };
    });

    const subtotal = {
      label: `Subtotal · ${ccyLabel(ccy)}`,
      values: [
        fmtAmount(payable.reduce((t, p) => t + (p.payable_to_date ?? 0), 0)) ?? "—",
        fmtAmount(payable.reduce((t, p) => t + (p.paid ?? 0), 0)) ?? "—",
        fmtAmount(
          payable.reduce((t, p) => {
            const cb = partnerClawback(p);
            return (
              t +
              (cb.commission + cb.refund > 0.01 ? cb.commission + cb.refund : (p.outstanding ?? 0))
            );
          }, 0),
        ) ?? "—",
      ],
    };

    const invoiceRows = selInvoices.map((i, n) => ({
      id: `${i.invoice_ref ?? n}`,
      ref: i.invoice_ref ?? "—",
      prose: [
        `Issued ${fmtDate(i.emission_date)}`,
        i.is_sent ? `sent ${fmtDate(i.emission_date)}` : "not sent yet",
        `due ${fmtDate(i.due_date)}`,
        (i.status ?? "").toUpperCase() === "CANCELLED" ? "cancelled" : null,
      ]
        .filter(Boolean)
        .join(" · "),
      amount: `${fmtAmount(i.amount_ttc ?? 0)} ${ccyLabel(i.currency ?? ccy)}`,
    }));

    const history: Array<{ id: string; title: string; meta: string; at: string }> = [];
    for (const p of selPartners) {
      const key = partnerKey(p.name ?? p.email ?? "");
      for (const d of p.disbursements ?? []) {
        if (!d.paid_on) continue;
        history.push({
          id: `paid-${key}-${d.reference ?? d.paid_on}`,
          title: `${p.name ?? "A supplier"} paid ${fmtAmount(d.amount ?? 0)} ${ccyLabel(p.currency ?? ccy)}${
            (d.method ?? "").toLowerCase().includes("card") ? " by card" : ""
          }`,
          meta: [fmtDate(d.paid_on), d.reference].filter(Boolean).join(" · "),
          at: d.paid_on,
        });
      }
      const asked = askedFor(selRef, p.name);
      if (asked?.last_asked_at) {
        history.push({
          id: `asked-${key}`,
          title: `${p.name ?? "A supplier"} asked for what they owe back`,
          meta: `${fmtAskedOn(asked.last_asked_at)} · by ${asked.last_asked_by ?? "someone"}${
            asked.times_asked > 1 ? ` · ${asked.times_asked} times` : ""
          }`,
          at: asked.last_asked_at,
        });
      }
    }
    if (since != null && since >= 14 && sel.end_date) {
      const left = new Date(Date.parse(sel.end_date) + 14 * 86_400_000).toISOString().slice(0, 10);
      history.push({
        id: "grace",
        title: "The 14-day window after the event closed",
        meta: `${left} · figures final since`,
        at: left,
      });
    }
    history.sort((a, b) => (a.at < b.at ? 1 : -1));

    return {
      stats,
      caption: `Available cash is what the client paid, less what we have already disbursed, less our service fee. Amounts in ${ccyLabel(ccy)}.`,
      moves,
      partnersLabel: `Suppliers · ${payable.length} payable${
        provisions > 0 ? `, ${provisions} provision excluded` : ""
      }`,
      partnerRows,
      subtotal,
      invoiceRows,
      history: history.slice(0, 6),
      recover: [...claw.commission.values(), ...claw.refund.values()].reduce((a, b) => a + b, 0),
    };
  }, [
    sel,
    selRef,
    selPartners,
    selInvoices,
    selTotals,
    askedFor,
    commissionRefundTargets,
    gmailConnection,
    commissionRefundDialog,
    summarize,
    markAsked,
    financialSummaries,
  ]);

  /** The bookings of the list we came from, so ← Previous / Next → can walk it. */
  const walk = useMemo(() => {
    const refs: string[] = [];
    for (const row of naListRows) if (!refs.includes(row.ref)) refs.push(row.ref);
    const at = refs.indexOf(selectedRef);
    return {
      prev: at > 0 ? refs[at - 1] : null,
      next: at >= 0 && at < refs.length - 1 ? refs[at + 1] : null,
    };
  }, [naListRows, selectedRef]);

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

      {/* ── Screens ───────────────────────────────────────────────────────
          Overview → list → booking, each one narrowing the last. */}
      {sel != null && bookingScreen != null ? (
        <EventScreen
          crumbs={[
            { label: "Overview", onClick: goToOverview },
            ...(activeList
              ? [{ label: NA_LIST_META[activeList].name, onClick: () => setSelectedRef("") }]
              : []),
            { label: selRef },
          ]}
          onPrev={walk.prev ? () => setSelectedRef(walk.prev as string) : undefined}
          onNext={walk.next ? () => setSelectedRef(walk.next as string) : undefined}
          statement={{
            label: "Account statement · this booking",
            onClick: downloadBookingStatements,
          }}
          backOffice={sel.booking_url}
          eventLabel={sel.company_name ?? "Booking"}
          reference={selRef}
          po={null}
          titleNote={
            selPartners.some((p) => !p.is_provision) ? (
              <span className="border-b border-paper-rule-strong pb-0.5 text-[12.5px] text-paper-muted">
                {selPartners.some((p) => p.locked_by_admin)
                  ? "Supplier lines locked by admin"
                  : selPartners.some((p) => p.locked_by_client)
                    ? "Supplier lines locked by client"
                    : selPartners.every((p) => p.is_provision || p.locked)
                      ? "Supplier lines locked"
                      : `Supplier lines not locked — ask ${sel.em_referent ?? "the EM"}`}
              </span>
            ) : undefined
          }
          meta={[
            sel.event_name,
            (sel.transaction_kind ?? "").replaceAll("_", " ").toLowerCase() || null,
            sel.billing_entity,
            sel.start_date
              ? `${fmtDate(sel.start_date)}${sel.end_date ? ` → ${fmtDate(sel.end_date)}` : ""}`
              : null,
            sel.participants ? `${sel.participants} pax` : null,
            sel.sales_referent ? `Sales ${sel.sales_referent}` : null,
            sel.em_referent ? `EM ${sel.em_referent}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          stats={bookingScreen.stats}
          caption={bookingScreen.caption}
          movesLabel="Next moves on this booking"
          moves={bookingScreen.moves}
          partnersLabel={bookingScreen.partnersLabel}
          partners={bookingScreen.partnerRows}
          subtotal={bookingScreen.subtotal}
          invoices={bookingScreen.invoiceRows}
          onClientStatement={() => {
            const entry = naClientStatement({ row: sel }, selInvoices);
            downloadBlob(new Blob([entry.bytes], { type: "application/pdf" }), entry.name);
          }}
          clientStatementLabel={`Client statement · ${sel.company_name ?? "the client"}, this booking`}
          history={bookingScreen.history}
          notes={<EventNotes eventRef={selRef} />}
          rail={[
            {
              id: "emails",
              label: `Emails with suppliers${gmailConnection?.connected ? "" : " — Gmail not connected"}`,
              onClick: () => setPanel((v) => (v === "emails" ? null : "emails")),
            },
            {
              id: "docs",
              label: "Supplier invoices — PDFs",
              onClick: () => setPanel((v) => (v === "docs" ? null : "docs")),
            },
            {
              id: "all",
              label: `All ${bookingScreen.partnerRows.filter((r) => !r.muted).length + 1} account statements for this booking`,
              download: true,
              onClick: downloadBookingStatements,
            },
          ]}
          panel={
            panel === "emails" ? (
              gmailConnection?.connected ? (
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
              ) : (
                <p className="text-[13.5px] text-paper-muted">
                  Connect Gmail from your account menu to see the threads with these suppliers.
                </p>
              )
            ) : panel === "docs" ? (
              <PartnerInvoicePdfs clientRequestId={sel.client_request_id} />
            ) : undefined
          }
        />
      ) : activeList !== null ? (
        <ListScreen
          crumb={NA_LIST_META[activeList].name}
          title={
            actionLists.find((l) => l.key === activeList)?.title ?? NA_LIST_META[activeList].name
          }
          explanation={NA_LIST_META[activeList].explanation}
          columns={NA_LIST_META[activeList].columns}
          unitNoun={NA_LIST_META[activeList].unitNoun}
          rows={naListRows}
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
            (activeList === "commission" || activeList === "refund") && gmailConnection?.connected
              ? {
                  label: `Review & send ${selectedTargets.length}`,
                  disabled: selectedTargets.length === 0,
                  onClick: () => commissionRefundDialog.open(selectedTargets),
                }
              : undefined
          }
          secondary={
            (activeList === "commission" || activeList === "refund") && gmailConnection?.connected
              ? {
                  label: "Create drafts",
                  disabled: selectedTargets.length === 0,
                  onClick: () => commissionRefundDialog.open(selectedTargets),
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
          filters={naFilters}
          isLoading={isLoading}
          onBack={goToOverview}
          onDownload={() =>
            downloadBlob(
              new Blob([listCsv(naListRows, NA_LIST_META[activeList].columns)], {
                type: "text/csv;charset=utf-8;",
              }),
              listFileName(NA_LIST_META[activeList].name, new Date().toISOString().slice(0, 10)),
            )
          }
          onOpen={(ref) => setSelectedRef(ref)}
        />
      ) : (
        <NaOverviewScreen
          portfolio={portfolio}
          lists={actionLists}
          isLoading={isLoading}
          totalBookings={listed.length}
          needsMove={listed.filter((l) => Array.from(l.keys).some((k) => k !== "hold")).length}
          noPricedLine={listed.filter((l) => l.x.partners.every((p) => p.is_provision)).length}
          unlockedLines={listed.reduce(
            (n, l) => n + l.x.partners.filter((p) => !p.is_provision && !p.locked).length,
            0,
          )}
          emsToAsk={Array.from(
            new Set(
              listed
                .filter((l) => l.x.partners.some((p) => !p.is_provision && !p.locked))
                .map((l) => l.x.row.em_referent)
                .filter((v): v is string => !!v && v.trim() !== ""),
            ),
          ).sort()}
          onOpenUnlocked={() => openList("pay")}
          cachedAge={cachedAge}
          gmail={gmailConnection}
          scanning={scanProgress.running}
          syncing={syncCards.isPending}
          search={search}
          onSearch={setSearch}
          statements={{
            suppliers: filtered.reduce((n, d) => n + naSupplierStatements(d).length, 0),
            clients: filtered.length,
            onSuppliers: () => {
              const entries = filtered.flatMap((d) => naSupplierStatements(d));
              downloadBlob(
                new Blob([zipStored(entries)], { type: "application/zip" }),
                archiveName("supplier", new Date().toISOString().slice(0, 10)),
              );
            },
            onClients: () => {
              const entries = filtered.map((d) =>
                naClientStatement(d, parseNaInvoices(d.row.invoices_json ?? null)),
              );
              downloadBlob(
                new Blob([zipStored(entries)], { type: "application/zip" }),
                archiveName("client", new Date().toISOString().slice(0, 10)),
              );
            },
            onRecover: () => exportRecoverCsv(sorted),
          }}
          onOpen={openList}
          onSend={
            gmailConnection?.connected && unaskedRecoveryTargets.length > 0
              ? () => commissionRefundDialog.open(unaskedRecoveryTargets)
              : undefined
          }
          onRecompute={async () => {
            await queryClient.fetchQuery({
              queryKey: ["na-rows"],
              queryFn: () => getNaRows({ data: { force: true } }),
            });
            syncCards.mutate();
          }}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        query={paletteQuery}
        onQuery={setPaletteQuery}
        onClose={() => setPaletteOpen(false)}
        groups={naPaletteGroups}
        placeholder="Booking, company, event, supplier"
        intro="Booking reference, company, event name, supplier, sales or EM. Picking a result opens that booking, with every figure, supplier line, invoice and note on it."
        hint="Partial refs work: 4362, NA-2411, Lightspeed"
        cursor={paletteCursor}
        onCursor={setPaletteCursor}
      />

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
/** Figures on the overview: grouped thousands, the currency named separately. */
function fmtPaper(value: number): string {
  return new Intl.NumberFormat("fr-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Biggest currency first — the hero shows that one large and stacks the rest. */
function byCcyDesc(m: Map<string, number>): Array<[string, number]> {
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
}

function paperTotal(m: Map<string, number>): string {
  const entries = byCcyDesc(m);
  if (entries.length === 0) return "—";
  return entries.map(([c, v]) => `${fmtPaper(v)} ${ccyLabel(c)}`).join(" · ");
}

/**
 * The Marketplace NA overview.
 *
 * Same treatment as L'Oréal CA, with this tracker's own rules kept intact:
 * commission and refund are two claims and never share a list, the fortnight of
 * grace after an event is stated rather than hidden, available cash is what
 * decides whether paying a supplier is our move, and every figure carries its
 * currency because this book is not in one.
 */
function NaOverviewScreen({
  portfolio,
  lists,
  isLoading,
  totalBookings,
  needsMove,
  noPricedLine,
  unlockedLines,
  emsToAsk,
  onOpenUnlocked,
  cachedAge,
  gmail,
  scanning,
  syncing,
  search,
  onSearch,
  statements,
  onOpen,
  onSend,
  onRecompute,
}: {
  portfolio: {
    toCashIn: Map<string, number>;
    cash: Map<string, number>;
    toPay: Map<string, number>;
    toRecover: Map<string, number>;
    commission: Map<string, number>;
    refund: Map<string, number>;
    inGrace: number;
  };
  lists: Array<{
    key: NaListKey;
    meta: (typeof NA_LIST_META)[NaListKey];
    events: number;
    units: number;
    byCcy: Map<string, number>;
    title: string;
    detail: string;
  }>;
  isLoading: boolean;
  totalBookings: number;
  /** Distinct bookings in at least one actionable list — not list memberships. */
  needsMove: number;
  noPricedLine: number;
  unlockedLines: number;
  /** The event managers who have a line to lock — the people to actually ask. */
  emsToAsk: string[];
  onOpenUnlocked: () => void;
  cachedAge: number | null;
  gmail: { connected?: boolean; email?: string | null } | undefined;
  scanning: boolean;
  syncing: boolean;
  search: string;
  onSearch: (value: string) => void;
  statements: {
    suppliers: number;
    clients: number;
    onSuppliers: () => void;
    onClients: () => void;
    onRecover: () => void;
  };
  onOpen: (key: NaListKey) => void;
  /** The lime row's own action: open the review dialog for the whole list. */
  onSend?: (key: NaListKey) => void;
  onRecompute: () => void;
}) {
  const hero = byCcyDesc(portfolio.toCashIn);
  const [main, ...rest] = hero;

  const figures = [
    {
      label: "Client to cash in",
      total: portfolio.toCashIn,
      hint: `${portfolio.toCashIn.size || 1} currenc${portfolio.toCashIn.size === 1 ? "y" : "ies"}`,
      alert: false,
    },
    {
      label: "Available cash",
      total: portfolio.cash,
      hint: "received, less paid out and our fee",
      alert: false,
    },
    {
      label: "To pay suppliers",
      total: portfolio.toPay,
      hint: "virtual-card legs excluded",
      alert: false,
    },
    {
      label: "To recover",
      total: portfolio.toRecover,
      hint: `commission ${paperTotal(portfolio.commission)} · refund ${paperTotal(portfolio.refund)}`,
      alert: true,
    },
  ];

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto bg-paper-canvas font-paper text-paper-ink lg:grid-cols-[1fr_380px]">
      <div className="border-paper-rule px-10 pb-10 pt-11 lg:border-r">
        <SectionLabel>Marketplace North America · in flight</SectionLabel>
        <div className="mt-[18px] flex items-end gap-[18px]">
          <span className="whitespace-nowrap font-paper-display text-[84px] leading-[0.9] tracking-[-0.02em] tabular-nums">
            {isLoading ? "…" : main ? fmtPaper(main[1]) : "—"}
          </span>
          {main && (
            <span className="pb-2 font-paper-display text-[22px] text-paper-muted">
              {ccyLabel(main[0])}
            </span>
          )}
          {rest.length > 0 && (
            <span className="flex flex-col gap-1 pb-2">
              {rest.map(([c, v]) => (
                <span
                  key={c}
                  className="whitespace-nowrap text-[15px] tabular-nums text-paper-muted"
                >
                  {fmtPaper(v)} <span className="text-paper-label">{ccyLabel(c)}</span>
                </span>
              ))}
            </span>
          )}
        </div>
        <p className="mt-3.5 max-w-[640px] text-[14px] leading-relaxed text-paper-body [text-wrap:pretty]">
          {isLoading
            ? "Loading…"
            : `Across ${totalBookings} live booking${totalBookings === 1 ? "" : "s"}, excluding L'Oréal and Veolia. ${needsMove} need a move today. ${portfolio.inGrace} ${portfolio.inGrace === 1 ? "is" : "are"} still inside the 14-day window after the event, where amounts usually settle on their own.`}
        </p>

        <div className="mt-8 grid grid-cols-2 gap-px border-t border-paper-rule-strong pt-px md:grid-cols-4">
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
                {isLoading ? "…" : paperTotal(f.total)}
              </div>
              <div className="mt-1 text-[11.5px] text-paper-label">{f.hint}</div>
            </div>
          ))}
        </div>

        <div className="mt-12 flex items-baseline gap-3">
          <span className="font-paper-display text-[26px]">What needs a move</span>
          <span className="text-[12.5px] text-paper-label">
            one list per action — commission and refund never share an email
          </span>
        </div>

        <div className="mt-5">
          {lists.map((list, i) => {
            const empty = list.events === 0;
            // The row opens the list; the lime button on the sending list opens
            // the review dialog for the whole list, as the design has it.
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
                      {empty ? `Nothing to ${list.meta.name.toLowerCase()}` : list.title}
                    </span>
                    <span className="mt-[5px] block text-[12.5px] text-paper-muted">
                      {list.detail}
                    </span>
                  </span>
                  <span className="w-[170px] flex-none text-right">
                    <span className="block text-[17px] tabular-nums">{paperTotal(list.byCcy)}</span>
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
          {noPricedLine === 0
            ? "Every booking carries at least one priced supplier line."
            : `${noPricedLine} booking${noPricedLine === 1 ? "" : "s"} carry no priced supplier line yet. Nothing can be paid or claimed until a quote lands.`}
        </p>
        <p className="mt-4 text-[14px] leading-relaxed text-paper-body">
          {unlockedLines === 0
            ? "Every supplier line is locked."
            : `${unlockedLines} supplier line${unlockedLines === 1 ? " is" : "s are"} not locked. The EM has to lock them before we can pay.`}
        </p>
        {unlockedLines > 0 && emsToAsk.length > 0 && (
          <button
            type="button"
            onClick={onOpenUnlocked}
            className="mt-3.5 inline-block border-b border-paper-ink pb-0.5 text-[13px]"
            title={emsToAsk.join(", ")}
          >
            Ask the EM — {emsToAsk.length} {emsToAsk.length === 1 ? "person" : "people"}
          </button>
        )}

        <div className="mt-9 border-t border-paper-rule pt-6 text-[10.5px] uppercase tracking-[0.2em] text-paper-label">
          Account statements
        </div>
        <p className="mt-3.5 text-[13px] leading-relaxed text-paper-body">
          One statement per supplier per booking, and one per client per booking. Download them on
          the booking, or take the whole filtered set — {totalBookings} booking
          {totalBookings === 1 ? "" : "s"}, {statements.suppliers + statements.clients} statements.
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
            onClick={statements.onRecover}
            className="flex h-9 items-center gap-2.5 border border-paper-rule-strong px-3 text-[13px] text-paper-body"
          >
            <Download className="h-3.5 w-3.5 flex-none" strokeWidth={1.6} aria-hidden="true" />
            Full booking export · to recover
          </button>
        </div>

        <div className="mt-9 border-t border-paper-rule pt-6 text-[10.5px] uppercase tracking-[0.2em] text-paper-label">
          Sources
        </div>
        {[
          {
            label: "Figures from BigQuery",
            value:
              cachedAge == null
                ? "just recomputed"
                : cachedAge < 90
                  ? `cached ${cachedAge} s`
                  : `cached ${Math.round(cachedAge / 60)} min`,
          },
          { label: "Approved cards from Slack", value: syncing ? "syncing…" : "on last refresh" },
          {
            label: "Gmail, your mailbox",
            value: gmail?.connected ? (scanning ? "scanning…" : "on demand") : "not connected",
          },
        ].map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-3 border-b border-paper-hairline py-4"
          >
            <span className="text-[13.5px] text-paper-body">{row.label}</span>
            <span className="font-paper-mono text-[11.5px] text-paper-label">{row.value}</span>
          </div>
        ))}
        <button
          type="button"
          onClick={onRecompute}
          className="mt-4 inline-block border-b border-paper-ink pb-0.5 text-[13px]"
        >
          Recompute everything
        </button>
      </aside>
    </div>
  );
}

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
/** "12 Aug" — a date you can judge staleness by without doing arithmetic. */
function fmtAskedOn(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-CA", { day: "numeric", month: "short" });
  } catch {
    return iso.slice(0, 10);
  }
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
