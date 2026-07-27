import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, ChevronRight, Send } from "lucide-react";
import {
  pickContact,
  composeCommissionRequest,
  composeRefundRequest,
  composeCombinedRequest,
} from "@/lib/commission-requests";
import { useGmailConnection, usePartnerRequests } from "@/lib/use-gmail";
import { Button } from "@/components/ui/button";
import { getCommissionRows, type CommissionRow } from "@/lib/commission.functions";
import { SummaryStrip, useRegisterTrackerActions } from "@/components/tracker-chrome";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/na-commissions")({
  ssr: false,
  beforeLoad: ({ context }) => {
    const allowed = (context as { allowedTrackers?: string[] }).allowedTrackers ?? [];
    if (!allowed.includes("na")) {
      throw redirect({ to: "/" });
    }
  },
  component: NaCommissionsPage,
});

// ── Formatting helpers ─────────────────────────────────────────────────────

function fmtCurrency(amount: number | null, ccy: string | null): string {
  if (amount == null) return "—";
  const n = Number(amount);
  if (Number.isNaN(n)) return "—";
  return (
    n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
    (ccy ? ` ${ccy}` : "")
  );
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return Number(v).toFixed(2) + " %";
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("en-CA", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return s;
  }
}

function fmtEventType(t: string | null): string {
  if (!t) return "—";
  return t
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

// ── CSV export ─────────────────────────────────────────────────────────────

function exportCsv(rows: CommissionRow[]) {
  const header = [
    "Booking ref",
    "Client",
    "Event name",
    "Event type",
    "Start date",
    "End date",
    "Billing entity",
    "Currency",
    "Gross GMV HT",
    "Total commission HT",
    "Effective rate %",
    "Partners",
    "EM referent",
  ];
  const csv = [header.join(",")];
  for (const r of rows) {
    const partners = (r.partners ?? [])
      .map(
        (p) =>
          `${p.partner_name ?? ""} ${fmtPct(p.commission_rate ? p.commission_rate * 100 : null)}`,
      )
      .join(" | ");
    csv.push(
      [
        r.readable_id,
        r.company_name,
        r.event_name,
        r.event_type,
        r.start_date,
        r.end_date,
        r.billing_entity,
        r.currency_client,
        r.gross_gmv_ht,
        r.total_commission_ht,
        r.effective_rate,
        partners,
        r.em_referent,
      ]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(","),
    );
  }
  const blob = new Blob([csv.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `na-commissions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ── Main component ─────────────────────────────────────────────────────────

function NaCommissionsPage() {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [composing, setComposing] = useState<null | {
    to: string; contactName: string | null; subject: string; body: string;
    row: CommissionRow; mode: "commission" | "refund" | "combined";
  }>(null);
  const { data: gmailConnection } = useGmailConnection();
  const requests = usePartnerRequests();

  const {
    data = [],
    isFetching,
    isLoading,
    refetch,
    error,
  } = useQuery({
    queryKey: ["na-commissions"],
    queryFn: () => getCommissionRows(),
    staleTime: 5 * 60_000,
  });

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return data;
    return data.filter(
      (r) =>
        (r.readable_id ?? "").toLowerCase().includes(q) ||
        (r.company_name ?? "").toLowerCase().includes(q) ||
        (r.event_name ?? "").toLowerCase().includes(q) ||
        (r.em_referent ?? "").toLowerCase().includes(q) ||
        (r.partners ?? []).some((p) =>
          (p.partner_name ?? "").toLowerCase().includes(q),
        ),
    );
  }, [data, search]);

  // KPIs
  const totalCommission = useMemo(
    () =>
      data.reduce((s, r) => {
        if (!r.total_commission_ht) return s;
        const k = r.currency_client ?? "?";
        s[k] = (s[k] ?? 0) + Number(r.total_commission_ht);
        return s;
      }, {} as Record<string, number>),
    [data],
  );

  const mismatches = useMemo(
    () =>
      data.filter((r) => (r.partners ?? []).some((p) => p.mismatch)).length,
    [data],
  );

  useRegisterTrackerActions(
    {
      onRefresh: () => refetch(),
      isFetching,
      exports: [
        {
          label: "Export CSV",
          onClick: () => exportCsv(filtered),
          disabled: filtered.length === 0,
        },
      ],
    },
    [isFetching, filtered.length],
  );

  function toggleRow(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const fmtTotalCcy = Object.entries(totalCommission)
    .map(([ccy, v]) => `${v.toLocaleString("en-CA", { maximumFractionDigits: 0 })} ${ccy}`)
    .join(" · ");

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <SummaryStrip
        title="Commissions — North America"
        stats={[
          { label: "Bookings", value: isLoading ? "…" : String(data.length) },
          { label: "Total commissions", value: isLoading ? "…" : fmtTotalCcy || "—" },
          {
            label: "Rate mismatches",
            value: isLoading ? "…" : String(mismatches),
          },
        ]}
        alert={mismatches > 0 ? `${mismatches} mismatch${mismatches > 1 ? "es" : ""}` : null}
      />

      {error != null && (
        <div role="alert" className="flex-none border-b border-rose-200 bg-rose-50 px-5 py-2.5 text-sm text-rose-800">
          Failed to load: {String((error as Error).message ?? error)}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border px-5 py-2">
        <Input
          placeholder="Search booking ref, client, event or partner…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 w-72 text-[12px]"
        />
        <span className="ml-auto text-xs text-muted-foreground">
          {filtered.length} / {data.length} bookings
        </span>
      </div>

      {/* Table */}
      <div className="sla-scroll">
        <Table className="sla-table">
          <TableHeader>
            <TableRow>
              <TableHead className="w-6" />
              <TableHead>Booking</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Event name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Start</TableHead>
              <TableHead>End</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead className="text-right">Gross GMV HT</TableHead>
              <TableHead className="text-right">Commission HT</TableHead>
              <TableHead className="text-right">Rate %</TableHead>
              <TableHead>EM</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={12} className="text-center text-xs text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="text-center text-xs text-muted-foreground">
                  No results.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((r) => {
                const id = r.readable_id ?? "";
                const isOpen = expanded.has(id);
                const hasMismatch = (r.partners ?? []).some((p) => p.mismatch);
                return [
                  <TableRow
                    key={id}
                    className={`cursor-pointer hover:bg-slate-50 ${hasMismatch ? "bg-rose-50/40" : ""}`}
                    onClick={() => toggleRow(id)}
                  >
                    <TableCell className="pr-0 text-slate-400">
                      <ChevronRight
                        className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`}
                        aria-hidden="true"
                      />
                    </TableCell>
                    <TableCell className="font-mono font-medium">
                      <span className="flex items-center gap-1.5">
                        {r.readable_id ?? "—"}
                        {r.booking_url && (
                          <a
                            href={r.booking_url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-slate-400 hover:text-slate-700"
                            aria-label="Open in admin"
                          >
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                          </a>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[130px] truncate font-medium">
                      {r.company_name ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-[160px] truncate">
                      {r.event_name ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-slate-500">
                      {fmtEventType(r.event_type)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{fmtDate(r.start_date)}</TableCell>
                    <TableCell className="whitespace-nowrap cell-sub">
                      {fmtDate(r.end_date)}
                    </TableCell>
                    <TableCell className="cell-sub">{r.billing_entity ?? "—"}</TableCell>
                    <TableCell className="cell-mono text-right">
                      {fmtCurrency(r.gross_gmv_ht, r.currency_client)}
                    </TableCell>
                    <TableCell className="cell-mono text-right font-semibold">
                      {fmtCurrency(r.total_commission_ht, r.currency_client)}
                    </TableCell>
                    <TableCell
                      className={`cell-mono text-right ${hasMismatch ? "text-rose-700" : ""}`}
                    >
                      {fmtPct(r.effective_rate)}
                    </TableCell>
                    <TableCell className="cell-sub max-w-[100px] truncate">
                      {r.em_referent ?? "—"}
                    </TableCell>
                  </TableRow>,

                  isOpen && (
                    <TableRow key={`${id}-detail`} className="bg-slate-50/60">
                      <TableCell />
                      <TableCell colSpan={11} className="py-2">
                        <table className="w-full border-separate border-spacing-y-0 text-[11.5px]">
                          <thead>
                            <tr className="text-[10px] uppercase tracking-[0.06em] text-slate-500">
                              <th className="py-1 pr-3 text-left font-semibold">Partner / Venue</th>
                              <th className="py-1 pr-3 text-right font-semibold">GMV HT</th>
                              <th className="py-1 pr-3 text-right font-semibold">Commission HT</th>
                              <th className="py-1 pr-3 text-right font-semibold">Rate</th>
                              <th className="py-1 text-left font-semibold">Rates by category</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(r.partners ?? []).map((p, i) => (
                              <tr
                                key={i}
                                className={p.mismatch ? "text-rose-700" : "text-slate-700"}
                              >
                                <td className="py-0.5 pr-3">
                                  <span className="font-medium">{p.partner_name ?? "—"}</span>
                                  {p.venue_name && p.venue_name !== p.partner_name && (
                                    <span className="ml-1.5 text-slate-400">{p.venue_name}</span>
                                  )}
                                  {p.mismatch && (
                                    <span className="ml-1.5 rounded-full bg-rose-100 px-1.5 py-[1px] text-[9.5px] font-medium text-rose-800">
                                      mismatch
                                    </span>
                                  )}
                                </td>
                                <td className="cell-mono py-0.5 pr-3 text-right">
                                  {fmtCurrency(p.gmv_ht, p.partner_currency)}
                                </td>
                                <td className="cell-mono py-0.5 pr-3 text-right font-semibold">
                                  {fmtCurrency(p.commission_ht, p.partner_currency)}
                                </td>
                                <td className="cell-mono py-0.5 pr-3 text-right">
                                  {fmtPct(
                                    p.commission_rate != null ? p.commission_rate * 100 : null,
                                  )}
                                </td>
                                <td className="py-0.5 text-[10.5px] text-slate-500">
                                  {[
                                    p.rate_house != null
                                      ? `Venue ${(p.rate_house * 100).toFixed(0)} %`
                                      : null,
                                    p.rate_food != null
                                      ? `F&B ${(p.rate_food * 100).toFixed(0)} %`
                                      : null,
                                    p.rate_activity != null
                                      ? `Activity ${(p.rate_activity * 100).toFixed(0)} %`
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ") || "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {gmailConnection?.connected && (() => {
                          const contact = pickContact(r.partners ?? []);
                          if (!contact.address) return (
                            <p className="mt-2 text-[10.5px] text-slate-400">
                              No contact email on file for this booking.
                            </p>
                          );
                          const { subject, body } = composeCommissionRequest(r, contact);
                          return (
                            <>
                            <button
                              type="button"
                              className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] text-sky-800 underline-offset-2 hover:underline"
                              onClick={(e) => {
                                e.stopPropagation();
                                setComposing({ to: contact.address!, contactName: contact.name, subject, body, row: r, mode: "commission" });
                              }}
                            >
                              <Send className="h-3 w-3" aria-hidden="true" />
                              Request commission
                            </button>
                            {(() => {
                              const refund = composeRefundRequest(r, contact);
                              if (!refund) return null;
                              return (
                                <button
                                  type="button"
                                  className="mt-1 inline-flex items-center gap-1.5 text-[11.5px] text-rose-800 underline-offset-2 hover:underline"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setComposing({ to: contact.address!, contactName: contact.name, ...refund, row: r, mode: "refund" });
                                  }}
                                >
                                  <Send className="h-3 w-3" aria-hidden="true" />
                                  Request refund
                                </button>
                              );
                            })()}
                            {(() => {
                              const combined = composeCombinedRequest(r, contact);
                              if (!combined) return null;
                              return (
                                <button
                                  type="button"
                                  className="mt-1 inline-flex items-center gap-1.5 text-[11.5px] text-amber-800 underline-offset-2 hover:underline"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setComposing({ to: contact.address!, contactName: contact.name, ...combined, row: r, mode: "combined" });
                                  }}
                                >
                                  <Send className="h-3 w-3" aria-hidden="true" />
                                  Commission + refund combined
                                </button>
                              );
                            })()}
                          </>
                          );
                        })()}
                      </TableCell>
                    </TableRow>
                  ),
                ];
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Commission request dialog */}
      {composing && (
        <CommissionRequestDialog
          composing={composing}
          requests={requests}
          onClose={() => { setComposing(null); requests.reset(); }}
        />
      )}
    </div>
  );
}

type ComposingState = {
  to: string;
  contactName: string | null;
  subject: string;
  body: string;
  row: CommissionRow;
  mode: "commission" | "refund" | "combined";
};

function CommissionRequestDialog({
  composing,
  requests,
  onClose,
}: {
  composing: ComposingState;
  requests: ReturnType<typeof usePartnerRequests>;
  onClose: () => void;
}) {
  const [subject, setSubject] = useState(composing.subject);
  const [body, setBody] = useState(composing.body);
  const [confirmSend, setConfirmSend] = useState(false);
  const finished = !requests.running && requests.results.length > 0;
  const result = requests.results[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
      >
        <header className="flex flex-none items-start gap-3 border-b border-border px-5 py-3.5">
          <span className="min-w-0">
            <h2 className="font-display text-lg font-bold">
              {composing.mode === "refund" ? "Request refund" : "Request commission"}
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-600">
              To: {composing.to}{composing.contactName ? ` (${composing.contactName})` : ""}
              {" · "}{composing.row.readable_id} · {composing.row.company_name}
            </p>
          </span>
          <button type="button" onClick={onClose} aria-label="Close"
            className="ml-auto rounded-md p-1 text-slate-500 hover:bg-slate-100">
            <ExternalLink className="h-4 w-4 rotate-45" aria-hidden="true" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-5 py-3">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={requests.running || finished}
            aria-label="Subject"
            placeholder="Subject"
            className="w-full rounded-md border border-input px-2.5 py-1.5 text-[12px]"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={requests.running || finished}
            rows={20}
            aria-label="Message body"
            className="min-h-0 flex-1 resize-y rounded-md border border-input px-2.5 py-1.5 text-[12px] leading-relaxed"
          />
          <p className="text-[10.5px] text-slate-400">
            Your Gmail signature will be appended automatically.
          </p>
        </div>

        <footer className="flex flex-none flex-wrap items-center gap-2 border-t border-border bg-slate-50 px-5 py-3">
          {requests.running && <span className="text-[12.5px] text-slate-600">Sending…</span>}
          {finished && result && (
            <span className={`text-[12.5px] ${result.ok ? "text-emerald-800" : "text-rose-800"}`}>
              {result.ok
                ? result.link
                  ? <a href={result.link} target="_blank" rel="noreferrer" className="underline underline-offset-2">Draft saved — open in Gmail</a>
                  : "Sent!"
                : `Failed: ${result.error}`}
            </span>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {finished ? (
              <Button size="sm" className="h-8" onClick={onClose}>Close</Button>
            ) : (
              <>
                <Button variant="outline" size="sm" className="h-8 gap-1.5"
                  disabled={requests.running}
                  onClick={() => requests.run([{ to: composing.to, subject, body }], "draft")}>
                  Save as draft
                </Button>
                {confirmSend ? (
                  <>
                    <Button size="sm"
                      className="h-8 gap-1.5 border-0 bg-naboo font-semibold text-navy shadow-none hover:bg-naboo-hover"
                      disabled={requests.running}
                      onClick={() => requests.run([{ to: composing.to, subject, body }], "send")}>
                      <Send className="h-3.5 w-3.5" aria-hidden="true" />
                      Confirm send
                    </Button>
                    <button type="button" onClick={() => setConfirmSend(false)}
                      className="text-[11.5px] text-slate-500 underline-offset-2 hover:underline">
                      Cancel
                    </button>
                  </>
                ) : (
                  <Button size="sm"
                    className="h-8 gap-1.5 border-0 bg-naboo font-semibold text-navy shadow-none hover:bg-naboo-hover"
                    disabled={requests.running}
                    onClick={() => setConfirmSend(true)}>
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    Send now
                  </Button>
                )}
              </>
            )}
          </span>
        </footer>
      </div>
    </div>
  );
}
