/**
 * Card tracking North America — one row per service provider we have an accepted
 * North American booking with, and whether they take card.
 *
 * A flat reference table rather than a work queue: there is no per-booking detail to
 * open, so the split view the other trackers use would be an empty right-hand pane.
 * Editing happens inline, one row at a time.
 *
 * Two columns that look alike and are not: "Provider takes card" is about them,
 * derived from evidence and occasionally overridden by hand; "Naboo pays by card" is
 * about us and is always a human decision. The row worth reading is the divergence —
 * they accept and we still say no — and that is the only place a written reason is
 * mandatory.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, RefreshCw, SearchX, X } from "lucide-react";
import {
  CARD_SCOPES,
  CARD_STATUS_LABEL,
  CSV_HEADER,
  accepts,
  cardStatus,
  csvRows,
  buildRows,
  fmtAge,
  fmtAmounts,
  fmtDay,
  fmtFee,
  matchesSearch,
  scopeCounts,
  scopeMatcher,
  sortRows,
  validateCardTerms,
  type CardEvidence,
  type CardRow,
  type CardScopeKey,
  type CardSortKey,
  type CardStatus,
  type CardTerms,
  type CardYesNo,
} from "@/lib/card-tracking";
import { getCardProviders } from "@/lib/card-tracking.functions";
import { fetchCardEvidence, fetchCardTerms, saveCardTerms } from "@/lib/card-terms.functions";
import { syncCardApprovals } from "@/lib/slack-cards.functions";
import { SummaryStrip, useRegisterTrackerActions } from "@/components/tracker-chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/card-tracking-na")({
  ssr: false,
  // Presentation aside, every server function on this page refuses too
  // (requireTracker("na-cards")).
  beforeLoad: ({ context }) => {
    const allowed = (context as { allowedTrackers?: string[] }).allowedTrackers ?? [];
    if (!allowed.includes("na-cards")) throw redirect({ to: "/" });
  },
  component: CardTrackingPage,
});

// ── CSV ─────────────────────────────────────────────────────────────────────

function exportCsv(rows: CardRow[]) {
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [CSV_HEADER.map(cell).join(",")];
  for (const row of csvRows(rows)) lines.push(row.map(cell).join(","));
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `card-tracking-na-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Page ────────────────────────────────────────────────────────────────────

function CardTrackingPage() {
  const [scope, setScope] = useState<CardScopeKey>("needs_decision");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<CardSortKey>("amount");
  const [sortDesc, setSortDesc] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const providersQuery = useQuery({
    queryKey: ["na-card-providers"],
    queryFn: () => getCardProviders(),
    staleTime: 5 * 60_000,
  });
  const providers = useMemo(() => providersQuery.data?.providers ?? [], [providersQuery.data]);

  const termsQuery = useQuery({
    queryKey: ["na-card-terms"],
    queryFn: () => fetchCardTerms(),
    staleTime: 60_000,
  });

  // The evidence needs the provider list first: Slack matches on the O- code, but the
  // Gmail scan is keyed by a slug of the partner's name, so the aliases have to go
  // with the request. This reads the mirror only — no Slack call on page load.
  const evidenceQuery = useQuery({
    queryKey: ["na-card-evidence", providers.length],
    enabled: providers.length > 0,
    staleTime: 60_000,
    queryFn: () =>
      fetchCardEvidence({
        data: {
          providers: providers.map((p) => ({ owner_code: p.owner_code, aliases: p.aliases })),
        },
      }),
  });

  const syncCards = useMutation({
    mutationFn: () => syncCardApprovals(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["na-card-evidence"] });
      queryClient.invalidateQueries({ queryKey: ["slack-card-approvals"] });
    },
    // A sync that fails in silence cannot be told apart from one that found nothing
    // to do — which is how an empty mirror went unnoticed. The message is rendered
    // next to the button, and logged so it also reaches the runtime logs.
    onError: (error) => console.error("Card approvals sync failed:", error),
  });

  const save = useMutation({
    mutationFn: (input: Parameters<typeof saveCardTerms>[0]["data"]) =>
      saveCardTerms({ data: input }),
    onSuccess: (saved) => {
      queryClient.setQueryData<CardTerms[]>(["na-card-terms"], (prev) => {
        const rest = (prev ?? []).filter((t) => t.owner_code !== saved.owner_code);
        return [...rest, saved];
      });
      setEditing(null);
    },
  });

  const rows = useMemo(() => {
    const termsByOwner = new Map((termsQuery.data ?? []).map((t) => [t.owner_code, t]));
    const evidenceByOwner = new Map<string, CardEvidence>(
      (evidenceQuery.data?.evidence ?? []).map((e) => [
        e.owner_code,
        { slackApproved: e.slackApproved, emailVerdict: e.emailVerdict },
      ]),
    );
    return buildRows(providers, termsByOwner, evidenceByOwner);
  }, [providers, termsQuery.data, evidenceQuery.data]);

  // Counts and the filter go through the same predicate table, so a chip can never
  // claim a number the list does not show.
  const counts = useMemo(() => scopeCounts(rows), [rows]);
  const shown = useMemo(() => {
    const scoped = rows.filter(scopeMatcher(scope)).filter((r) => matchesSearch(r, search));
    return sortRows(scoped, sortKey, sortDesc);
  }, [rows, scope, search, sortKey, sortDesc]);

  const isLoading = providersQuery.isLoading || termsQuery.isLoading;
  const error = providersQuery.error ?? termsQuery.error ?? evidenceQuery.error;
  const mirrorAge = evidenceQuery.data?.syncedAgeSeconds ?? null;

  useRegisterTrackerActions(
    {
      onRefresh: async () => {
        await queryClient.fetchQuery({
          queryKey: ["na-card-providers"],
          queryFn: () => getCardProviders({ data: { force: true } }),
        });
        await queryClient.invalidateQueries({ queryKey: ["na-card-terms"] });
      },
      isFetching: providersQuery.isFetching,
      exports: [
        { label: "Export CSV", onClick: () => exportCsv(shown), disabled: shown.length === 0 },
      ],
    },
    [providersQuery.isFetching, shown.length],
  );

  function toggleSort(key: CardSortKey) {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(key !== "provider");
    }
  }

  const decided = rows.filter((r) => r.terms.naboo_pays_card != null).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <SummaryStrip
        title="Card tracking — North America"
        stats={[
          { label: "Providers", value: isLoading ? "…" : String(rows.length) },
          {
            label: "Take card",
            value: isLoading ? "…" : String(counts.card_ok + counts.card_ok_if_fee),
          },
          { label: "Refuse", value: isLoading ? "…" : String(counts.refuses) },
          { label: "Naboo decided", value: isLoading ? "…" : `${decided} / ${rows.length}` },
        ]}
        alert={
          counts.needs_decision > 0 && !isLoading ? `${counts.needs_decision} to decide` : null
        }
      />

      {error != null && (
        <div
          role="alert"
          className="flex-none border-b border-rose-200 bg-rose-50 px-5 py-2.5 text-sm text-rose-800"
        >
          Failed to load: {String((error as Error).message ?? error)}
        </div>
      )}
      {save.isError && (
        <div
          role="alert"
          className="flex-none border-b border-rose-200 bg-rose-50 px-5 py-2.5 text-sm text-rose-800"
        >
          {String((save.error as Error).message ?? save.error)}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border px-5 py-2">
        <div className="flex flex-wrap items-center gap-1">
          {CARD_SCOPES.map((s) => (
            <button
              key={s.key}
              type="button"
              title={s.hint}
              onClick={() => setScope(s.key)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] transition-colors ${
                scope === s.key
                  ? "bg-naboo font-semibold text-navy"
                  : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              {s.label}
              <span className={scope === s.key ? "font-normal text-navy/60" : "text-slate-400"}>
                {isLoading ? "…" : counts[s.key]}
              </span>
            </button>
          ))}
        </div>

        <Input
          placeholder="Search provider, O- code or country…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 w-64 text-[12px]"
        />

        <div className="ml-auto flex items-center gap-2">
          {/* Reading the mirror never calls Slack, so its age is stated rather than
              assumed — and only this button refreshes it. */}
          <span
            className="text-[11.5px] text-slate-400"
            title="Approvals mirrored from #finance-paiement-by-card"
          >
            Approvals {fmtAge(mirrorAge)}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => syncCards.mutate()}
            disabled={syncCards.isPending}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${syncCards.isPending ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {syncCards.isPending ? "Syncing…" : "Refresh card approvals"}
          </Button>
          {syncCards.isSuccess && !syncCards.isPending && (
            <span className="text-[11.5px] text-slate-500">
              {syncCards.data.synced} approval{syncCards.data.synced === 1 ? "" : "s"} mirrored
            </span>
          )}
          {syncCards.isError && (
            <span
              role="alert"
              title={String((syncCards.error as Error).message ?? syncCards.error)}
              className="max-w-[420px] truncate text-[11.5px] text-rose-800"
            >
              {String((syncCards.error as Error).message ?? syncCards.error)}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {shown.length} / {rows.length}
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="sla-scroll">
        <Table className="sla-table">
          <TableHeader>
            <TableRow>
              <SortableHead
                label="Provider"
                active={sortKey === "provider"}
                desc={sortDesc}
                onClick={() => toggleSort("provider")}
              />
              <TableHead>Country</TableHead>
              <SortableHead
                label="Bookings"
                active={sortKey === "bookings"}
                desc={sortDesc}
                onClick={() => toggleSort("bookings")}
              />
              <SortableHead
                label="Amount at stake"
                active={sortKey === "amount"}
                desc={sortDesc}
                onClick={() => toggleSort("amount")}
                align="right"
                hint="Outstanding payable, per currency. Sorted by the largest single-currency exposure — these are USD, CAD, EUR and IDR, and one total across them would mean nothing."
              />
              <TableHead>Provider takes card</TableHead>
              <TableHead>Fee</TableHead>
              <TableHead>Reason for refusal</TableHead>
              <TableHead>Naboo pays by card</TableHead>
              <TableHead>Why not</TableHead>
              <TableHead>Last updated</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center text-xs text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <SearchX className="h-5 w-5 text-slate-400" aria-hidden="true" />
                    <span className="text-xs text-muted-foreground">
                      No provider matches this filter.
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              shown.map((row) =>
                editing === row.provider.owner_code ? (
                  <EditRow
                    key={row.provider.owner_code}
                    row={row}
                    pending={save.isPending}
                    onCancel={() => {
                      save.reset();
                      setEditing(null);
                    }}
                    onSave={(input) => save.mutate(input)}
                  />
                ) : (
                  <ReadRow
                    key={row.provider.owner_code}
                    row={row}
                    onEdit={() => {
                      save.reset();
                      setEditing(row.provider.owner_code);
                    }}
                  />
                ),
              )
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SortableHead({
  label,
  active,
  desc,
  onClick,
  align = "left",
  hint,
}: {
  label: string;
  active: boolean;
  desc: boolean;
  onClick: () => void;
  align?: "left" | "right";
  hint?: string;
}) {
  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={onClick}
        title={hint}
        className={`inline-flex items-center gap-1 ${active ? "text-navy" : ""}`}
      >
        {label}
        <span className="text-[9px] text-slate-400">{active ? (desc ? "▼" : "▲") : "↕"}</span>
      </button>
    </TableHead>
  );
}

const STATUS_STYLE: Record<CardStatus, string> = {
  card_ok: "border-emerald-200 bg-emerald-50 text-emerald-800",
  card_ok_if_fee: "border-amber-200 bg-amber-50 text-amber-800",
  refuses: "border-rose-200 bg-rose-50 text-rose-800",
  unknown: "border-border bg-slate-50 text-slate-500",
};

function StatusPill({ row }: { row: CardRow }) {
  const source =
    row.verdict.source === "slack"
      ? "Approved card in #finance-paiement-by-card"
      : row.verdict.source === "email"
        ? "Explicit acceptance or refusal in the email scan"
        : row.verdict.source === "manual"
          ? `Set by hand${row.terms.updated_by ? ` by ${row.terms.updated_by}` : ""}`
          : "Never asked — the honest default";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        title={source}
        className={`inline-flex items-center rounded-full border px-2 py-[2px] text-[11px] font-medium ${STATUS_STYLE[row.verdict.status]}`}
      >
        {CARD_STATUS_LABEL[row.verdict.status]}
      </span>
      {/* An override has to look like one, or the next reader wonders why the
          derived status disagrees with the evidence beside it. */}
      {row.verdict.overridden && (
        <span
          title={`Manual override${row.terms.updated_by ? ` by ${row.terms.updated_by}` : ""} — the evidence says otherwise`}
          className="rounded-full border border-border bg-white px-1.5 py-[1px] text-[10px] uppercase tracking-[0.08em] text-slate-500"
        >
          Override
        </span>
      )}
    </span>
  );
}

function ReadRow({ row, onEdit }: { row: CardRow; onEdit: () => void }) {
  const { provider, terms, verdict } = row;
  const theyAccept = accepts(verdict.status);
  const weDecline = theyAccept && terms.naboo_pays_card === "no";
  return (
    <TableRow className={weDecline ? "bg-amber-50/40" : undefined}>
      <TableCell className="max-w-[220px] font-medium">
        <span className="block truncate" title={provider.provider_name}>
          {provider.provider_name}
        </span>
        <span className="cell-sub font-mono text-[11px]">{provider.owner_code}</span>
      </TableCell>
      <TableCell className="cell-sub">{provider.country ?? "—"}</TableCell>
      <TableCell>
        <span className="tabular-nums">{provider.bookings}</span>
        <span className="cell-sub block text-[11px]">{fmtDay(provider.latest_start)}</span>
      </TableCell>
      <TableCell className="whitespace-nowrap text-right tabular-nums">
        {fmtAmounts(provider.amounts)}
      </TableCell>
      <TableCell>
        <StatusPill row={row} />
      </TableCell>
      {/* A fee only means something on a provider that accepts, and a reason for
          refusal only on one that refuses. Showing them anywhere else invites the
          data-entry error rather than preventing it. */}
      <TableCell className="tabular-nums">{theyAccept ? fmtFee(terms) : "—"}</TableCell>
      <TableCell className="max-w-[200px]">
        {verdict.status === "refuses" ? (
          <span className="block truncate text-[12px]" title={terms.refusal_reason ?? ""}>
            {terms.refusal_reason ?? "—"}
          </span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell>
        {terms.naboo_pays_card == null ? (
          <span className="text-[12px] text-slate-400">Undecided</span>
        ) : (
          <span
            className={`inline-flex items-center rounded-full border px-2 py-[2px] text-[11px] font-medium ${
              terms.naboo_pays_card === "yes"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-border bg-slate-50 text-slate-600"
            }`}
          >
            {terms.naboo_pays_card === "yes" ? "Yes" : "No"}
          </span>
        )}
      </TableCell>
      <TableCell className="max-w-[220px]">
        {weDecline ? (
          <span className="block truncate text-[12px]" title={terms.naboo_reason ?? ""}>
            {terms.naboo_reason ?? "—"}
          </span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="cell-sub whitespace-nowrap text-[11px]">
        {terms.updated_by ? (
          <>
            {terms.updated_by.replace(/@naboo\.app$/, "")}
            <span className="block">{fmtDay(terms.updated_at?.slice(0, 10) ?? null)}</span>
          </>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell>
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${provider.provider_name}`}
          className="text-slate-400 hover:text-navy"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TableCell>
    </TableRow>
  );
}

type EditState = {
  accepts_card: CardYesNo | "" | "derived";
  fee_percent: string;
  fee_fixed: string;
  fee_currency: string;
  refusal_reason: string;
  naboo_pays_card: CardYesNo | "";
  naboo_reason: string;
};

function EditRow({
  row,
  pending,
  onCancel,
  onSave,
}: {
  row: CardRow;
  pending: boolean;
  onCancel: () => void;
  onSave: (input: {
    owner_code: string;
    accepts_card: CardYesNo | null;
    fee_percent: number | null;
    fee_fixed: number | null;
    fee_currency: string | null;
    refusal_reason: string | null;
    naboo_pays_card: CardYesNo | null;
    naboo_reason: string | null;
    aliases: string[];
  }) => void;
}) {
  const { provider, terms } = row;
  const [state, setState] = useState<EditState>({
    accepts_card: terms.accepts_card ?? "derived",
    fee_percent: terms.fee_percent == null ? "" : String(terms.fee_percent),
    fee_fixed: terms.fee_fixed == null ? "" : String(terms.fee_fixed),
    fee_currency: terms.fee_currency ?? provider.amounts[0]?.currency ?? "USD",
    refusal_reason: terms.refusal_reason ?? "",
    naboo_pays_card: terms.naboo_pays_card ?? "",
    naboo_reason: terms.naboo_reason ?? "",
  });

  const num = (v: string) => {
    const n = Number(v.replace(",", "."));
    return v.trim() === "" || !Number.isFinite(n) ? null : n;
  };

  const draft = {
    owner_code: provider.owner_code,
    accepts_card:
      state.accepts_card === "derived" || state.accepts_card === "" ? null : state.accepts_card,
    fee_percent: num(state.fee_percent),
    fee_fixed: num(state.fee_fixed),
    fee_currency: state.fee_currency.trim() || null,
    refusal_reason: state.refusal_reason.trim() || null,
    naboo_pays_card: state.naboo_pays_card === "" ? null : state.naboo_pays_card,
    naboo_reason: state.naboo_reason.trim() || null,
  };

  // The status as it will read once saved, so the mandatory reason follows the fee
  // being typed rather than the status the row had when it was opened.
  const previewStatus = previewCardStatus(row, draft);
  const theyAccept = accepts(previewStatus);
  const problem = validateCardTerms(draft, previewStatus);

  return (
    <TableRow className="bg-slate-50/60 align-top">
      <TableCell className="max-w-[220px] font-medium">
        <span className="block truncate">{provider.provider_name}</span>
        <span className="cell-sub font-mono text-[11px]">{provider.owner_code}</span>
      </TableCell>
      <TableCell className="cell-sub">{provider.country ?? "—"}</TableCell>
      <TableCell className="tabular-nums">{provider.bookings}</TableCell>
      <TableCell className="whitespace-nowrap text-right tabular-nums">
        {fmtAmounts(provider.amounts)}
      </TableCell>

      <TableCell>
        <select
          aria-label="Provider takes card"
          value={state.accepts_card}
          onChange={(e) =>
            setState((s) => ({ ...s, accepts_card: e.target.value as EditState["accepts_card"] }))
          }
          className="h-7 w-[132px] rounded-md border border-input bg-white px-1.5 text-[12px]"
        >
          <option value="derived">From evidence ({CARD_STATUS_LABEL[row.verdict.status]})</option>
          <option value="yes">Takes card</option>
          <option value="no">Refuses card</option>
        </select>
      </TableCell>

      {/* The fee is a percentage and an optional flat amount: both can apply, so
          both are captured rather than one being folded into the other. */}
      <TableCell>
        {theyAccept ? (
          <div className="flex items-center gap-1">
            <input
              aria-label="Fee percent"
              value={state.fee_percent}
              onChange={(e) => setState((s) => ({ ...s, fee_percent: e.target.value }))}
              placeholder="0.00"
              className="h-7 w-14 rounded-md border border-input bg-white px-1.5 text-right text-[12px] tabular-nums"
            />
            <span className="text-[11px] text-slate-500">%</span>
            <span className="text-[11px] text-slate-400">+</span>
            <input
              aria-label="Fee fixed amount"
              value={state.fee_fixed}
              onChange={(e) => setState((s) => ({ ...s, fee_fixed: e.target.value }))}
              placeholder="0.00"
              className="h-7 w-16 rounded-md border border-input bg-white px-1.5 text-right text-[12px] tabular-nums"
            />
            <input
              aria-label="Fee currency"
              value={state.fee_currency}
              onChange={(e) =>
                setState((s) => ({ ...s, fee_currency: e.target.value.toUpperCase() }))
              }
              className="h-7 w-12 rounded-md border border-input bg-white px-1.5 text-[12px] uppercase"
            />
          </div>
        ) : (
          <span className="text-[11px] text-slate-400">n/a while they refuse</span>
        )}
      </TableCell>

      <TableCell>
        {previewStatus === "refuses" ? (
          <input
            aria-label="Reason for refusal"
            value={state.refusal_reason}
            onChange={(e) => setState((s) => ({ ...s, refusal_reason: e.target.value }))}
            placeholder="Their reason"
            className="h-7 w-[180px] rounded-md border border-input bg-white px-1.5 text-[12px]"
          />
        ) : (
          <span className="text-[11px] text-slate-400">n/a</span>
        )}
      </TableCell>

      <TableCell>
        <select
          aria-label="Naboo pays by card"
          value={state.naboo_pays_card}
          onChange={(e) =>
            setState((s) => ({ ...s, naboo_pays_card: e.target.value as CardYesNo | "" }))
          }
          className="h-7 w-[104px] rounded-md border border-input bg-white px-1.5 text-[12px]"
        >
          <option value="">Undecided</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </TableCell>

      <TableCell>
        {theyAccept && state.naboo_pays_card === "no" ? (
          <input
            aria-label="Why Naboo does not pay by card"
            value={state.naboo_reason}
            onChange={(e) => setState((s) => ({ ...s, naboo_reason: e.target.value }))}
            placeholder="Required — why not?"
            className={`h-7 w-[200px] rounded-md border bg-white px-1.5 text-[12px] ${
              state.naboo_reason.trim() ? "border-input" : "border-rose-300"
            }`}
          />
        ) : (
          <span className="text-[11px] text-slate-400">n/a</span>
        )}
      </TableCell>

      <TableCell className="cell-sub text-[11px]">
        {problem && <span className="block max-w-[200px] text-rose-700">{problem}</span>}
      </TableCell>

      <TableCell>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Save"
            disabled={pending || problem != null}
            onClick={() => onSave({ ...draft, aliases: provider.aliases })}
            className="text-emerald-700 disabled:text-slate-300"
          >
            <Check className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Cancel"
            onClick={onCancel}
            className="text-slate-400 hover:text-navy"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * The status this row will have once the draft is saved.
 *
 * Derived from the same function the table uses, with the draft standing in for the
 * stored terms: typing a fee has to promote the row to "Card OK if fee" while it is
 * being typed, and clearing it has to demote it, otherwise the mandatory-reason rule
 * fires on a status the editor is no longer showing.
 */
function previewCardStatus(
  row: CardRow,
  draft: { accepts_card: CardYesNo | null; fee_percent: number | null; fee_fixed: number | null },
): CardStatus {
  return cardStatus(row.evidence, { ...row.terms, ...draft }).status;
}
