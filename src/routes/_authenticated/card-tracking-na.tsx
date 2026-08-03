/**
 * Card tracking North America — a decision queue over a settled ledger.
 *
 * One row per service provider we have an accepted North American booking with, and
 * whether they take card. Two columns that look alike and are not: the provider's
 * willingness is derived from evidence and occasionally overridden by hand; Naboo's
 * decision to use it is always a human call. The row worth reading is the divergence —
 * they accept and we still say no — and that is the only place a written reason is
 * mandatory.
 *
 * The page is split because a flat table gave every row the same weight: the handful
 * that need a call looked exactly like the ones already settled. So the rows that need
 * a human are dealt as cards with the next move spelled out and its two buttons on it,
 * and everything decided collapses into a quiet table underneath. The split is
 * presentation only — `needsDecision` in card-tracking.ts is the single predicate behind
 * the queue, its count and the KPI, and the CSV still exports every row.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, RefreshCw, X } from "lucide-react";
import {
  CARD_STATUS_LABEL,
  CSV_HEADER,
  accepts,
  approvalNote,
  cardKpis,
  cardOkIfFeeNote,
  cardOutreach,
  cardStatus,
  csvRows,
  buildRows,
  declineNote,
  fmtAge,
  fmtAmount,
  fmtDay,
  fmtFee,
  fmtRound,
  hasFee,
  matchesSearch,
  nabooPays,
  nextMove,
  openDecisionsNote,
  partitionRows,
  payableNote,
  provenance,
  refusesNote,
  rowNabooPays,
  scopeCounts,
  sortRows,
  validateCardTerms,
  type CardEvidence,
  type CardRow,
  type CardSortKey,
  type CardStatus,
  type CardTerms,
  type CardYesNo,
} from "@/lib/card-tracking";
import { getCardProviders } from "@/lib/card-tracking.functions";
import { fetchCardEvidence, fetchCardTerms, saveCardTerms } from "@/lib/card-terms.functions";
import { syncCardApprovals } from "@/lib/slack-cards.functions";
import { useDraftEmail, useFactScan, useGmailConnection } from "@/lib/use-gmail";
import { useRegisterTrackerActions } from "@/components/tracker-chrome";
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

type SaveInput = Parameters<typeof saveCardTerms>[0]["data"];

function CardTrackingPage() {
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
    mutationFn: (input: SaveInput) => saveCardTerms({ data: input }),
    onSuccess: (saved) => {
      // The row leaves the queue for the ledger as soon as this lands — no animation,
      // it just moves.
      queryClient.setQueryData<CardTerms[]>(["na-card-terms"], (prev) => {
        const rest = (prev ?? []).filter((t) => t.owner_code !== saved.owner_code);
        return [...rest, saved];
      });
      setEditing(null);
    },
  });

  const draft = useDraftEmail();
  const { data: gmailConnection } = useGmailConnection();
  const { progress: recheckProgress, start: startRecheck } = useFactScan();

  const rows = useMemo(() => {
    const termsByOwner = new Map((termsQuery.data ?? []).map((t) => [t.owner_code, t]));
    const evidenceByOwner = new Map<string, CardEvidence>(
      (evidenceQuery.data?.evidence ?? []).map((e) => [
        e.owner_code,
        {
          slackApproved: e.slackApproved,
          emailVerdict: e.emailVerdict,
          approvalCount: e.approvalCount,
          lastApprovedAt: e.lastApprovedAt,
        },
      ]),
    );
    return buildRows(providers, termsByOwner, evidenceByOwner);
  }, [providers, termsQuery.data, evidenceQuery.data]);

  // Providers currently trusted as "Card OK" purely on an old email verdict — the
  // exact case the detection rules got wrong before they were tightened (see
  // email-facts.ts). There is nothing left to re-derive this from without reading
  // the thread again, so every one of their bookings goes back through the real
  // scan rather than a guess.
  const recheckEvents = useMemo(() => {
    const byEvent = new Map<string, Array<{ name: string; email: string | null }>>();
    for (const r of rows) {
      if (r.evidence.emailVerdict !== "accepted") continue;
      for (const eventRef of r.provider.event_refs) {
        const partners = byEvent.get(eventRef) ?? [];
        partners.push({ name: r.provider.provider_name, email: r.provider.email });
        byEvent.set(eventRef, partners);
      }
    }
    return [...byEvent.entries()].map(([event_ref, partners]) => ({ event_ref, partners }));
  }, [rows]);

  async function recheckEmailEvidence() {
    await startRecheck(recheckEvents);
    queryClient.invalidateQueries({ queryKey: ["na-card-evidence"] });
  }

  // The KPI band answers for the whole set; search narrows the two lists below it. The
  // group counts follow what is on screen and say so when they are a subset.
  const kpis = useMemo(() => cardKpis(rows), [rows]);
  const counts = useMemo(() => scopeCounts(rows), [rows]);
  const { open, settled } = useMemo(() => {
    const matching = rows.filter((r) => matchesSearch(r, search));
    const parts = partitionRows(matching);
    return {
      open: sortRows(parts.open, sortKey, sortDesc),
      settled: sortRows(parts.settled, sortKey, sortDesc),
    };
  }, [rows, search, sortKey, sortDesc]);

  const isLoading = providersQuery.isLoading || termsQuery.isLoading;
  const error = providersQuery.error ?? termsQuery.error ?? evidenceQuery.error;
  const mirrorAge = evidenceQuery.data?.syncedAgeSeconds ?? null;
  const filtered = search.trim().length > 0;

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
      // Every row, queue and ledger together: the split is presentational, and an
      // export that shipped half the providers would be a regression on the
      // reconciliation it exists for.
      exports: [
        { label: "Export CSV", onClick: () => exportCsv(rows), disabled: rows.length === 0 },
      ],
    },
    [providersQuery.isFetching, rows],
  );

  function toggleSort(key: CardSortKey) {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(key !== "provider");
    }
  }

  function markRefused(row: CardRow) {
    save.reset();
    // A fee cannot stand on a provider that refuses — the same rule the editor and the
    // server both enforce — so it goes with the same click rather than failing the save.
    save.mutate({
      owner_code: row.provider.owner_code,
      accepts_card: "no",
      fee_percent: null,
      fee_fixed: null,
      fee_currency: null,
      refusal_reason: row.terms.refusal_reason,
      naboo_pays_card: row.terms.naboo_pays_card,
      naboo_reason: row.terms.naboo_reason,
      aliases: row.provider.aliases,
      provider_name: row.provider.provider_name,
      venue_types: row.provider.venue_types,
    });
  }

  function askAboutCard(row: CardRow) {
    const to = (row.provider.email ?? "").trim();
    if (!to) return;
    draft.reset();
    draft.mutate(
      { to, ...cardOutreach(row.provider) },
      // The draft lands in the caller's own mailbox rather than being sent: the
      // wording is theirs to check, and this page has no business sending mail
      // on its own.
      { onSuccess: (result) => window.open(result.link, "_blank", "noopener,noreferrer") },
    );
  }

  const takeCard = counts.card_ok + counts.card_ok_if_fee;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-50">
      {/* leading-[normal]: the design's vertical rhythm is authored against the browser
          default, not the app's global 1.5 — which stretched every card, tile and table
          row by 6–23px. The three line-heights the design does specify (the provider
          name at 1.3, the next-move prose at 1.45, the KPI figure at 1.15) override it
          where they belong. */}
      <main className="flex min-h-0 min-w-[1200px] flex-1 flex-col gap-5 overflow-auto px-6 pb-7 pt-5 leading-[normal]">
        {/* 1 — page head */}
        <div className="flex items-end justify-between gap-6">
          <div className="flex flex-col gap-0.5">
            <h1 className="m-0 font-display text-[26px] font-extrabold leading-[normal] tracking-[-0.02em] text-navy">
              Card tracking — North America
            </h1>
            <p className="m-0 text-[13px] text-slate-500">
              {isLoading
                ? "Loading providers…"
                : `${rows.length} provider${rows.length === 1 ? "" : "s"} with an accepted booking · ${takeCard} take card · ${counts.refuses} refuse`}
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            {/* Not in the design. Kept because the real set is 450 providers, not the
                15 the prototype was drawn on, and there is otherwise no way to find
                one of them. It narrows both zones. */}
            <Input
              placeholder="Search provider, O- code or country…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-56 text-[12px]"
            />
            {/* Reading the mirror never calls Slack, so its age is stated rather than
                assumed — and only this button refreshes it. */}
            <span
              className="whitespace-nowrap text-[11.5px] text-slate-400"
              title="Approvals mirrored from #finance-paiement-by-card"
            >
              Approvals {fmtAge(mirrorAge)}
            </span>
            <Button
              variant="naboo-ghost"
              size="naboo"
              onClick={() => syncCards.mutate()}
              disabled={syncCards.isPending}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${syncCards.isPending ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              {syncCards.isPending ? "Syncing…" : "Refresh card approvals"}
            </Button>
            {gmailConnection?.connected && recheckEvents.length > 0 && (
              <Button
                variant="naboo-ghost"
                size="naboo"
                onClick={recheckEmailEvidence}
                disabled={recheckProgress.running}
                title="Re-reads the thread for every provider currently marked Card OK on an old email verdict"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${recheckProgress.running ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                {recheckProgress.running
                  ? `Rechecking… ${recheckProgress.done}/${recheckProgress.total}`
                  : `Recheck email evidence (${recheckEvents.length})`}
              </Button>
            )}
          </div>
        </div>

        {recheckProgress.error && (
          <div
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-[12.5px] text-rose-800"
          >
            Recheck interrupted: {recheckProgress.error}
          </div>
        )}
        {!recheckProgress.running &&
          recheckProgress.done > 0 &&
          recheckProgress.done === recheckProgress.total && (
            <p className="m-0 text-[11.5px] text-slate-500">
              Rechecked {recheckProgress.total} event{recheckProgress.total === 1 ? "" : "s"} —{" "}
              {recheckProgress.matched} provider{recheckProgress.matched === 1 ? "" : "s"} matched
              in Gmail.
            </p>
          )}

        {(error != null || save.isError || syncCards.isError || draft.isError) && (
          <div
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-[12.5px] text-rose-800"
          >
            {error != null && <div>Failed to load: {message(error)}</div>}
            {save.isError && <div>{message(save.error)}</div>}
            {syncCards.isError && <div>Sync failed: {message(syncCards.error)}</div>}
            {draft.isError && <div>Could not draft the email: {message(draft.error)}</div>}
          </div>
        )}
        {syncCards.isSuccess && !syncCards.isPending && (
          <p className="m-0 text-[11.5px] text-slate-500">
            Mirrored {syncCards.data.synced} approval{syncCards.data.synced === 1 ? "" : "s"} across{" "}
            {syncCards.data.providers} provider{syncCards.data.providers === 1 ? "" : "s"}.
          </p>
        )}

        {/* 2 — KPI band */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <Kpi
            dark
            label="Open decisions"
            value={isLoading ? "…" : String(kpis.open.total)}
            valueClassName="text-naboo"
            note={isLoading ? " " : openDecisionsNote(kpis.open)}
          />
          <Kpi
            label="Payable by card"
            value={isLoading ? "…" : String(kpis.payableByCard.total)}
            valueClassName="text-emerald-700"
            note={isLoading ? " " : payableNote(kpis.payableByCard)}
          />
          <Kpi
            // Named by currency for the same reason as the exposure card below: this is
            // one currency's total, never a sum across the others in play.
            label={
              kpis.payableByCard.feeAmount
                ? `Accepts with a fee (${kpis.payableByCard.feeAmount.currency})`
                : "Accepts with a fee"
            }
            value={
              isLoading || !kpis.payableByCard.feeAmount
                ? "—"
                : fmtRound(kpis.payableByCard.feeAmount.amount)
            }
            unit={kpis.payableByCard.feeAmount?.currency}
            note={isLoading ? " " : cardOkIfFeeNote(kpis.payableByCard)}
          />
          <Kpi
            label="They accept, we decline"
            value={isLoading ? "…" : String(kpis.weDecline.total)}
            note={isLoading ? " " : declineNote(kpis.weDecline)}
          />
          <Kpi
            label={
              kpis.refuses.amount
                ? `Refuses card (${kpis.refuses.amount.currency})`
                : "Refuses card"
            }
            valueClassName="text-red-700"
            value={isLoading || !kpis.refuses.amount ? "—" : fmtRound(kpis.refuses.amount.amount)}
            unit={kpis.refuses.amount?.currency}
            note={isLoading ? " " : refusesNote(kpis.refuses)}
          />
          <Kpi
            // The currency is named in the label because the figure is one currency's
            // exposure and nothing here is ever summed across currencies.
            label={
              kpis.largestExposure
                ? `Largest ${kpis.largestExposure.currency} exposure`
                : "Largest exposure"
            }
            value={isLoading || !kpis.largestExposure ? "—" : fmtRound(kpis.largestExposure.amount)}
            unit={kpis.largestExposure?.currency}
            note={
              kpis.largestExposure
                ? `${kpis.largestExposure.provider} · never summed across currencies`
                : "no outstanding amount recorded"
            }
          />
        </div>

        {/* 3 — decision queue */}
        <section className="flex flex-col gap-2.5">
          <GroupHead
            title="Needs a decision"
            count={open.length}
            total={filtered ? kpis.open.total : null}
            hint="Status unknown, or they accept and nobody has said whether we pay by card"
          />
          {isLoading ? (
            <p className="m-0 text-[12px] text-slate-400">Loading…</p>
          ) : open.length === 0 ? (
            <p className="m-0 text-[12px] text-slate-500">
              {filtered
                ? "No provider matching this search needs a decision."
                : `Nothing to decide — all ${rows.length} providers are settled.`}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {open.map((row) =>
                editing === row.provider.owner_code ? (
                  <div
                    key={row.provider.owner_code}
                    className="rounded-[10px] border border-slate-200 border-l-[3px] border-l-naboo bg-white p-4"
                  >
                    <TermsEditor
                      row={row}
                      pending={save.isPending}
                      onCancel={() => {
                        save.reset();
                        setEditing(null);
                      }}
                      onSave={(input) => save.mutate(input)}
                    />
                  </div>
                ) : (
                  <QueueCard
                    key={row.provider.owner_code}
                    row={row}
                    pending={save.isPending || draft.isPending}
                    onDecide={() => {
                      save.reset();
                      setEditing(row.provider.owner_code);
                    }}
                    onMarkRefused={() => markRefused(row)}
                    onAsk={() => askAboutCard(row)}
                  />
                ),
              )}
            </div>
          )}
        </section>

        {/* 4 — settled ledger */}
        <section className="flex flex-col gap-2.5">
          <GroupHead
            title="Settled"
            count={settled.length}
            total={filtered ? rows.length - kpis.open.total : null}
            hint="Nothing to chase — kept for reference and for the CSV"
            muted
          />
          <div className="overflow-x-auto overflow-y-hidden rounded-xl border border-slate-200 bg-white">
            <Table className="text-[12.5px]" wrapperClassName="overflow-visible">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <LedgerHead
                    label="Provider"
                    sortKey="provider"
                    active={sortKey}
                    desc={sortDesc}
                    onSort={toggleSort}
                  />
                  <LedgerHead
                    label="Amount at stake"
                    sortKey="amount"
                    active={sortKey}
                    desc={sortDesc}
                    onSort={toggleSort}
                    align="right"
                    hint="Outstanding payable, per currency. Sorted by the largest single-currency exposure — these are USD, CAD, EUR and IDR, and one total across them would mean nothing."
                  />
                  <LedgerHead label="Provider takes card" />
                  <LedgerHead label="Fee" />
                  <LedgerHead label="Naboo pays" />
                  <LedgerHead label="Reason on file" />
                  <LedgerHead label="Updated" />
                  <TableHead className="w-10 bg-slate-50 border-b border-slate-200 px-4 py-2" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="px-4 py-3 text-[12px] text-slate-400">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : settled.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="px-4 py-3 text-[12px] text-slate-500">
                      {filtered
                        ? "No settled provider matches this search."
                        : "Nothing settled yet — every provider is still in the queue."}
                    </TableCell>
                  </TableRow>
                ) : (
                  settled.map((row) =>
                    editing === row.provider.owner_code ? (
                      <TableRow key={row.provider.owner_code} className="hover:bg-transparent">
                        <TableCell
                          colSpan={8}
                          className="border-b border-slate-100 bg-slate-50 p-4"
                        >
                          <TermsEditor
                            row={row}
                            pending={save.isPending}
                            onCancel={() => {
                              save.reset();
                              setEditing(null);
                            }}
                            onSave={(input) => save.mutate(input)}
                          />
                        </TableCell>
                      </TableRow>
                    ) : (
                      <LedgerRow
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
        </section>
      </main>
    </div>
  );
}

function message(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

// ── The furniture ───────────────────────────────────────────────────────────

function Kpi({
  label,
  value,
  unit,
  note,
  dark = false,
  valueClassName,
}: {
  label: string;
  value: string;
  unit?: string | null;
  note: string;
  dark?: boolean;
  valueClassName?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-0.5 rounded-xl border px-[18px] py-4 ${
        dark ? "border-navy bg-navy text-white" : "border-slate-200 bg-white"
      }`}
    >
      <span
        className={`text-[10.5px] font-semibold uppercase tracking-[0.08em] ${
          dark ? "text-white/50" : "text-slate-500"
        }`}
      >
        {label}
      </span>
      <span
        className={`font-display text-[30px] font-extrabold leading-[1.15] tabular-nums ${
          valueClassName ?? (dark ? "text-white" : "text-navy")
        }`}
      >
        {value}
        {unit && <span className="ml-1 text-[15px] font-extrabold text-slate-500">{unit}</span>}
      </span>
      <span className={`text-[11.5px] ${dark ? "text-white/60" : "text-slate-400"}`}>{note}</span>
    </div>
  );
}

function GroupHead({
  title,
  count,
  total,
  hint,
  muted = false,
}: {
  title: string;
  count: number;
  /** The unfiltered figure, when a search is narrowing the list. */
  total: number | null;
  hint: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-navy">{title}</span>
      <span
        className={`inline-flex h-5 items-center rounded-full px-2 text-[11px] tabular-nums ${
          muted ? "bg-slate-100 font-semibold text-slate-600" : "bg-naboo font-bold text-navy"
        }`}
      >
        {count}
        {total != null && total !== count && (
          <span className="ml-1 font-normal opacity-60">of {total}</span>
        )}
      </span>
      <span className="text-[12px] text-slate-400">{hint}</span>
    </div>
  );
}

const STATUS_PILL: Record<CardStatus, string> = {
  card_ok: "bg-emerald-100 text-emerald-700",
  card_ok_if_fee: "bg-amber-100 text-amber-800",
  refuses: "bg-[#FFF4F4] text-rose-700",
  unknown: "bg-slate-100 text-slate-500",
};

function StatusPill({ row }: { row: CardRow }) {
  const detail =
    row.verdict.source === "slack"
      ? "Approved card in #finance-paiement-by-card"
      : row.verdict.source === "email"
        ? "Explicit acceptance or refusal in the email scan"
        : row.verdict.source === "manual"
          ? `Set by hand${row.terms.updated_by ? ` by ${row.terms.updated_by}` : ""}`
          : row.verdict.source === "airline"
            ? "An airline: they take card as a matter of course and do not surcharge a corporate booking. Assumed, not asked — set it by hand if this one is different."
            : "Never asked — the honest default";
  return (
    <span
      title={detail}
      className={`inline-flex items-center rounded-full px-[9px] py-[3px] text-[11px] font-medium ${STATUS_PILL[row.verdict.status]}`}
    >
      {CARD_STATUS_LABEL[row.verdict.status]}
    </span>
  );
}

/** The manual-override tag. A derived status disagreeing with the evidence must say so. */
function OverrideTag({ row }: { row: CardRow }) {
  if (!row.verdict.overridden) return null;
  return (
    <span
      title={`Manual override${row.terms.updated_by ? ` by ${row.terms.updated_by}` : ""} — the evidence says otherwise`}
      className="ml-[5px] rounded-full border border-slate-200 bg-white px-1.5 py-[1px] text-[9.5px] uppercase tracking-[0.08em] text-slate-500"
    >
      Override
    </span>
  );
}

/** Primary amount, with the other currencies beneath. Never one figure across them. */
function Amounts({ row, className = "" }: { row: CardRow; className?: string }) {
  const [first, ...rest] = row.provider.amounts;
  return (
    <div className={`flex flex-col gap-px text-right ${className}`}>
      <span className="whitespace-nowrap text-[13.5px] font-semibold tabular-nums">
        {first ? fmtAmount(first.amount, first.currency) : "—"}
      </span>
      {rest.length > 0 && (
        <span className="whitespace-nowrap text-[10.5px] text-slate-400 tabular-nums">
          {rest.map((a) => fmtAmount(a.amount, a.currency)).join(" · ")}
        </span>
      )}
    </div>
  );
}

// ── The queue ───────────────────────────────────────────────────────────────

function QueueCard({
  row,
  pending,
  onDecide,
  onMarkRefused,
  onAsk,
}: {
  row: CardRow;
  pending: boolean;
  onDecide: () => void;
  onMarkRefused: () => void;
  onAsk: () => void;
}) {
  const { provider } = row;
  // Which of the two questions is open decides which pair of buttons the card carries.
  const unasked = row.verdict.status === "unknown";
  const email = (provider.email ?? "").trim();
  return (
    <div className="grid grid-cols-[250px_104px_156px_190px_1fr_auto] items-center gap-4 rounded-[10px] border border-slate-200 border-l-[3px] border-l-naboo bg-white px-4 py-3 transition-[box-shadow,border-color] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)] [&:hover]:border-navy [&:hover]:border-l-naboo [&:hover]:shadow-[0_4px_6px_rgba(16,31,52,0.06)]">
      <div className="flex min-w-0 flex-col gap-px">
        <span
          className="truncate text-[13.5px] font-semibold leading-[1.3]"
          title={provider.provider_name}
        >
          {provider.provider_name}
        </span>
        <span className="font-mono text-[10.5px] text-slate-400">
          {provider.owner_code} · {provider.country ?? "—"}
        </span>
      </div>

      <div className="flex flex-col gap-px">
        <span className="text-[13px] tabular-nums">
          {provider.bookings} booking{provider.bookings === 1 ? "" : "s"}
        </span>
        <span className="whitespace-nowrap text-[10.5px] text-slate-400">
          {fmtDay(provider.latest_start)}
        </span>
      </div>

      <Amounts row={row} />

      <div className="flex flex-col items-start gap-[3px]">
        <span className="inline-flex items-center">
          <StatusPill row={row} />
          <OverrideTag row={row} />
        </span>
        <span className="text-[10.5px] text-slate-400">{provenance(row)}</span>
      </div>

      <p className="m-0 text-pretty text-[12px] leading-[1.45] text-slate-500">{nextMove(row)}</p>

      <div className="flex items-center gap-1.5">
        {unasked ? (
          <>
            <Button
              variant="naboo"
              size="naboo-sm"
              disabled={pending || !email}
              title={
                email
                  ? `Draft an email to ${email} asking whether they take card`
                  : "No email address recorded for this provider"
              }
              onClick={onAsk}
            >
              Ask about card
            </Button>
            <Button
              variant="naboo-ghost"
              size="naboo-sm"
              disabled={pending}
              title="Record that this provider does not take card"
              onClick={onMarkRefused}
            >
              Mark refused
            </Button>
            {/* The third answer, and the common one: somebody already knows, from a
                call or a contract, and only needs somewhere to type it. Without this
                the only way in was to mark the row refused and correct it in the
                ledger afterwards. Same editor the pencil and Decide open. */}
            <Button
              variant="naboo-ghost"
              size="naboo-sm"
              disabled={pending}
              title="Fill in what they said — whether they take card, any fee, and our decision"
              onClick={onDecide}
            >
              Fill in
            </Button>
          </>
        ) : (
          <>
            <Button variant="naboo" size="naboo-sm" disabled={pending} onClick={onDecide}>
              Decide
            </Button>
            <Button variant="naboo-ghost" size="naboo-sm" asChild>
              {/* The evidence for this row lives in a mailbox or in Slack, and neither
                  stores a link we hold. A search for the provider in the reader's own
                  mail is the closest honest target. */}
              <a
                href={threadSearchUrl(row)}
                target="_blank"
                rel="noopener noreferrer"
                title="Search your mailbox for correspondence with this provider"
              >
                Open thread
              </a>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function threadSearchUrl(row: CardRow): string {
  const query = (row.provider.email ?? "").trim() || row.provider.provider_name;
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
}

// ── The ledger ──────────────────────────────────────────────────────────────

function LedgerHead({
  label,
  sortKey,
  active,
  desc,
  onSort,
  align = "left",
  hint,
}: {
  label: string;
  sortKey?: CardSortKey;
  active?: CardSortKey;
  desc?: boolean;
  onSort?: (key: CardSortKey) => void;
  align?: "left" | "right";
  hint?: string;
}) {
  const base =
    "whitespace-nowrap border-b border-slate-200 bg-slate-50 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500";
  return (
    <TableHead className={`${base} ${align === "right" ? "text-right" : "text-left"}`}>
      {sortKey && onSort ? (
        <button
          type="button"
          title={hint}
          onClick={() => onSort(sortKey)}
          className={`inline-flex items-center gap-1 uppercase ${active === sortKey ? "text-navy" : ""}`}
        >
          {label}
          <span className="text-[9px] text-slate-400">
            {active === sortKey ? (desc ? "▼" : "▲") : "↕"}
          </span>
        </button>
      ) : (
        label
      )}
    </TableHead>
  );
}

function LedgerRow({ row, onEdit }: { row: CardRow; onEdit: () => void }) {
  const { provider, terms, verdict } = row;
  const theyAccept = accepts(verdict.status);
  const pays = rowNabooPays(row);
  const weDecline = theyAccept && pays.value === "no";
  // Their reason when they refuse, ours when we do. Both are "the reason on file";
  // which one it is follows from the two pills on the same line.
  const reason = weDecline
    ? terms.naboo_reason
    : verdict.status === "refuses"
      ? terms.refusal_reason
      : null;
  return (
    <TableRow
      // The warm tint marks a row where we made a choice against the provider's
      // willingness. Hover has to beat it, or the row stops responding under the cursor.
      className={`border-b border-slate-100 ${weDecline ? "bg-[#FFFCF2]" : ""} hover:bg-slate-50`}
    >
      <TableCell className="whitespace-nowrap px-4 py-[9px] align-middle">
        <span className="font-semibold">{provider.provider_name}</span>
        <span className="ml-2 font-mono text-[10.5px] text-slate-400">
          {provider.owner_code} · {provider.country ?? "—"}
        </span>
      </TableCell>
      <TableCell className="px-4 py-[9px] align-middle">
        <Amounts row={row} />
      </TableCell>
      <TableCell className="px-4 py-[9px] align-middle">
        <span className="inline-flex items-center whitespace-nowrap">
          <StatusPill row={row} />
          <OverrideTag row={row} />
          {/* How strong the evidence is, not just that it exists: one approval two
              years ago and four this quarter both read "Card OK" without this. */}
          {approvalNote(row.evidence) && (
            <span className="ml-2 text-[10.5px] text-slate-400">{approvalNote(row.evidence)}</span>
          )}
        </span>
      </TableCell>
      {/* A fee only means something on a provider that accepts. Elsewhere the cell
          recedes rather than inviting the data-entry error. */}
      <TableCell className="px-4 py-[9px] align-middle tabular-nums">
        {theyAccept && hasFee(terms) ? fmtFee(terms) : <span className="text-slate-300">—</span>}
      </TableCell>
      <TableCell className="whitespace-nowrap px-4 py-[9px] align-middle">
        {pays.value == null ? (
          <span className="text-[11px] text-slate-400">Undecided</span>
        ) : (
          <span className="inline-flex items-center">
            <span
              className={`inline-flex items-center rounded-full px-[9px] py-[3px] text-[11px] font-medium ${
                pays.value === "yes"
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-slate-100 text-slate-600"
              }`}
            >
              {pays.value === "yes" ? "Yes" : "No"}
            </span>
            {/* Nobody typed this one. Said out loud, because the Updated column is
                empty beside it and the next reader would otherwise wonder. */}
            {pays.source === "automatic" && (
              <span
                title="They take card at no fee, so yes is the standing answer — nobody was asked. Set it by hand to override."
                className="ml-[5px] rounded-full border border-slate-200 bg-white px-1.5 py-[1px] text-[9.5px] uppercase tracking-[0.08em] text-slate-500"
              >
                Automatic
              </span>
            )}
          </span>
        )}
      </TableCell>
      <TableCell className="max-w-[300px] px-4 py-[9px] align-middle">
        {reason ? (
          <span className="block truncate text-[11.5px]" title={reason}>
            {reason}
          </span>
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap px-4 py-[9px] align-middle text-[10.5px] text-slate-400">
        {terms.updated_by
          ? `${terms.updated_by.replace(/@naboo\.app$/, "")} · ${fmtDay(terms.updated_at?.slice(0, 10) ?? null)}`
          : "—"}
      </TableCell>
      <TableCell className="w-10 px-4 py-[9px] align-middle">
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${provider.provider_name}`}
          className="text-slate-400 transition-colors duration-150 hover:text-navy"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TableCell>
    </TableRow>
  );
}

// ── The editor ──────────────────────────────────────────────────────────────

type EditState = {
  accepts_card: CardYesNo | "" | "derived";
  fee_percent: string;
  fee_fixed: string;
  fee_currency: string;
  refusal_reason: string;
  naboo_pays_card: CardYesNo | "";
  naboo_reason: string;
};

/**
 * One editor, opened from either zone.
 *
 * The queue's "Decide" and the ledger's pencil are the same edit, so they are the same
 * form: the rules it enforces — a fee promoting the status while it is typed, a
 * mandatory reason on the divergence — are load-bearing enough that a second copy of
 * them would be a second place to get them wrong.
 */
function TermsEditor({
  row,
  pending,
  onCancel,
  onSave,
}: {
  row: CardRow;
  pending: boolean;
  onCancel: () => void;
  onSave: (input: SaveInput) => void;
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
  const previewStatus = cardStatus(row.evidence, { ...terms, ...draft }).status;
  const theyAccept = accepts(previewStatus);
  const problem = validateCardTerms(draft, previewStatus);
  // Focus follows the first open question: on a row nobody has asked, that is what the
  // provider said, not what we decided about it.
  const startAtProvider = row.verdict.status === "unknown";
  // Follows the fee as it is typed: clearing a fee makes the row answer itself, adding
  // one hands the question back.
  const automatic = nabooPays(previewStatus, { naboo_pays_card: null }).source === "automatic";
  const field = "h-8 rounded-md border border-slate-300 bg-white px-2 text-[12px]";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-[13.5px] font-semibold">{provider.provider_name}</span>
        <span className="font-mono text-[10.5px] text-slate-400">{provider.owner_code}</span>
        <span className="ml-auto text-[11px] text-slate-400">
          Will read as {CARD_STATUS_LABEL[previewStatus]}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500">
            Provider takes card
          </span>
          <select
            aria-label="Provider takes card"
            autoFocus={startAtProvider}
            value={state.accepts_card}
            onChange={(e) =>
              setState((s) => ({ ...s, accepts_card: e.target.value as EditState["accepts_card"] }))
            }
            className={`${field} w-[190px]`}
          >
            <option value="derived">From evidence ({CARD_STATUS_LABEL[row.verdict.status]})</option>
            <option value="yes">Takes card</option>
            <option value="no">Refuses card</option>
          </select>
        </label>

        {/* The fee is a percentage and an optional flat amount: both can apply, so
            both are captured rather than one being folded into the other. */}
        {theyAccept && (
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500">
              Fee
            </span>
            <span className="flex items-center gap-1">
              <input
                aria-label="Fee percent"
                value={state.fee_percent}
                onChange={(e) => setState((s) => ({ ...s, fee_percent: e.target.value }))}
                placeholder="0.00"
                className={`${field} w-16 text-right tabular-nums`}
              />
              <span className="text-[11px] text-slate-500">%</span>
              <span className="text-[11px] text-slate-400">+</span>
              <input
                aria-label="Fee fixed amount"
                value={state.fee_fixed}
                onChange={(e) => setState((s) => ({ ...s, fee_fixed: e.target.value }))}
                placeholder="0.00"
                className={`${field} w-20 text-right tabular-nums`}
              />
              <input
                aria-label="Fee currency"
                value={state.fee_currency}
                onChange={(e) =>
                  setState((s) => ({ ...s, fee_currency: e.target.value.toUpperCase() }))
                }
                className={`${field} w-14 uppercase`}
              />
            </span>
          </label>
        )}

        {previewStatus === "refuses" && (
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500">
              Their reason
            </span>
            <input
              aria-label="Reason for refusal"
              value={state.refusal_reason}
              onChange={(e) => setState((s) => ({ ...s, refusal_reason: e.target.value }))}
              placeholder="Why they refuse"
              className={`${field} w-[240px]`}
            />
          </label>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500">
            Naboo pays by card
          </span>
          <select
            aria-label="Naboo pays by card"
            autoFocus={!startAtProvider}
            value={state.naboo_pays_card}
            onChange={(e) =>
              setState((s) => ({ ...s, naboo_pays_card: e.target.value as CardYesNo | "" }))
            }
            className={`${field} w-[190px]`}
          >
            {/* Leaving it blank is not the same as leaving it undecided on a fee-free
                provider: it hands the row back to the standing yes. */}
            <option value="">{automatic ? "Automatic (Yes — no fee)" : "Undecided"}</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>

        {theyAccept && state.naboo_pays_card === "no" && (
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500">
              Why not
            </span>
            <input
              aria-label="Why Naboo does not pay by card"
              value={state.naboo_reason}
              onChange={(e) => setState((s) => ({ ...s, naboo_reason: e.target.value }))}
              placeholder="Required — why not?"
              className={`${field} w-[300px] ${state.naboo_reason.trim() ? "" : "border-rose-300"}`}
            />
          </label>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="naboo"
            size="naboo"
            disabled={pending || problem != null}
            onClick={() =>
              onSave({
                ...draft,
                aliases: provider.aliases,
                provider_name: provider.provider_name,
                venue_types: provider.venue_types,
              })
            }
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Save
          </Button>
          <Button variant="naboo-ghost" size="naboo" onClick={onCancel}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Cancel
          </Button>
        </div>
      </div>

      {problem && (
        <p role="alert" className="m-0 text-[11.5px] text-rose-700">
          {problem}
        </p>
      )}
    </div>
  );
}
