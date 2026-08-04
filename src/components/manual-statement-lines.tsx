/**
 * The hand-typed half of a booking's Client invoicing tab.
 *
 * The warehouse lags the back office by days, and a statement generated in that window
 * quietly under-bills while claiming to be today's. This is where somebody closes the gap:
 * the documents and payments the back office has issued and BigQuery has not caught up with
 * yet, typed once, shown in the same tables as the rest, and printed on the statement as
 * ordinary lines — because they are ordinary lines. The client received these invoices.
 *
 * Nothing here marks them as manual on the client-facing PDF. Flagging a figure that is
 * correct invites doubt about it; what the document says instead is how old its data is,
 * which is the honest thing a reader needs.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  refWarning,
  seriesPrefix,
  signedAmount,
  validateManualEntry,
  type ManualEntry,
  type ManualKind,
} from "@/lib/manual-entries";
import {
  createManualEntry,
  getSeriesSync,
  listManualEntries,
  updateManualEntry,
} from "@/lib/manual-entries.functions";
import { Button } from "@/components/ui/button";

/** What the tab already knows about the warehouse's own documents. */
export type KnownDocument = { ref: string; issued: string | null };

/** What the tab already knows about the warehouse's own payments, for the duplicate warning. */
export type KnownPayment = { paid_on: string | null; amount: number; currency: string };

export function useManualEntries(eventRef: string) {
  return useQuery({
    queryKey: ["manual-entries", eventRef],
    queryFn: () => listManualEntries({ data: { event_ref: eventRef } }),
    staleTime: 30_000,
    enabled: eventRef.length > 0,
  });
}

/**
 * "Records synchronised up to 3 Aug 2026 · 1 entry added by hand".
 *
 * The date comes from the last document issued in this booking's own series, never from
 * the clock: the clock always says today, and saying today is exactly the claim that was
 * wrong. When there is no series to read — a booking with no invoice yet — the line says
 * only what it can.
 */
export function FreshnessLine({
  documents,
  manualCount,
}: {
  documents: KnownDocument[];
  manualCount: number;
}) {
  const prefix = useMemo(() => seriesPrefix(documents), [documents]);
  const sync = useQuery({
    queryKey: ["series-sync", prefix],
    queryFn: () => getSeriesSync({ data: { prefix: prefix! } }),
    enabled: prefix != null,
    staleTime: 10 * 60_000,
  });
  const upTo = sync.data?.syncedUpTo ?? null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3.5 py-2 text-[11.5px] text-slate-500">
      <span>
        {upTo
          ? `Records synchronised up to ${prose(upTo)}`
          : prefix
            ? "Checking how current these records are…"
            : "No invoice issued yet, so there is nothing to synchronise."}
      </span>
      {manualCount > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span className="font-medium text-navy">
            {manualCount === 1 ? "1 entry added by hand" : `${manualCount} entries added by hand`}
          </span>
        </>
      )}
    </div>
  );
}

/** "3 Aug 2026" — the line is a sentence, so the date is written the way a sentence writes one. */
function prose(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The chip that marks a hand-typed row inside the tracker — never on the client's PDF. */
export function ByHandChip({ entry }: { entry: ManualEntry }) {
  const when = entry.created_at ? entry.created_at.slice(0, 10) : "";
  return (
    <span
      title={`Added by ${entry.created_by}${when ? ` on ${when}` : ""}. It will disappear on its own once the finance records catch up.`}
      className="inline-flex items-center whitespace-nowrap rounded-full bg-[#F6F9D8] px-2 py-[2px] text-[10.5px] font-semibold text-[#5B6511]"
    >
      Added by hand
    </span>
  );
}

/** The two edit affordances on a hand-typed row. */
export function RowActions({
  entry,
  onEdit,
  onDelete,
  pending,
}: {
  entry: ManualEntry;
  onEdit: () => void;
  onDelete: () => void;
  pending: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${entry.document_ref ?? "this line"}`}
        className="text-slate-400 transition-colors [&:hover]:text-navy"
      >
        <Pencil className="h-3 w-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={pending}
        aria-label={`Remove ${entry.document_ref ?? "this line"}`}
        className="text-slate-400 transition-colors [&:hover]:text-[#B4534B]"
      >
        <Trash2 className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  );
}

const FIELD =
  "h-8 w-full rounded-md border border-input bg-white px-2 text-[12px] text-navy focus:outline-none focus:ring-1 focus:ring-navy/30";
const LABEL = "text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500";

type Draft = {
  kind: ManualKind;
  document_ref: string;
  issued_on: string;
  due_on: string;
  amount: string;
  currency: string;
  method: string;
  note: string;
};

function emptyDraft(kind: ManualKind, currency: string): Draft {
  return {
    kind,
    document_ref: "",
    issued_on: "",
    due_on: "",
    amount: "",
    currency,
    method: kind === "payment" ? "Bank transfer" : "",
    note: "",
  };
}

function draftOf(entry: ManualEntry): Draft {
  return {
    kind: entry.kind,
    document_ref: entry.document_ref ?? "",
    issued_on: entry.issued_on ?? "",
    due_on: entry.due_on ?? "",
    // The magnitude is what a person types; the sign belongs to the type.
    amount: String(Math.abs(entry.amount)),
    currency: entry.currency,
    method: entry.method ?? "",
    note: entry.note ?? "",
  };
}

/**
 * Adding or editing one line.
 *
 * Two things are refused outright because they would put a wrong figure in front of a
 * client: a zero, and a due date before the issue date. A reference that does not match the
 * series only warns — the pattern is a convention, and blocking a document that genuinely
 * exists is worse than the typo it would catch. A payment that looks like one already in
 * the records warns too, for the same reason: a client really can pay the same amount twice
 * on the same day.
 */
export function EntryForm({
  eventRef,
  initial,
  entry,
  documents,
  payments,
  onDone,
  onCancel,
}: {
  eventRef: string;
  initial: Draft;
  /** Set when editing an existing line. */
  entry?: ManualEntry;
  documents: KnownDocument[];
  payments: KnownPayment[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["manual-entries", eventRef] });
    onDone();
  };
  const save = useMutation({
    mutationFn: (input: Parameters<typeof createManualEntry>[0]["data"]) =>
      entry
        ? updateManualEntry({ data: { ...input, id: entry.id } })
        : createManualEntry({ data: input }),
    onSuccess: invalidate,
  });

  const amount = draft.amount.trim() === "" ? null : Number(draft.amount.replace(",", "."));
  const problem = validateManualEntry({
    kind: draft.kind,
    document_ref: draft.document_ref || null,
    issued_on: draft.issued_on || null,
    due_on: draft.due_on || null,
    amount,
    currency: draft.currency || null,
    method: draft.method || null,
    note: draft.note || null,
  });

  const refNote = draft.kind === "payment" ? null : refWarning(draft.document_ref, documents);
  // The same rule the statement uses to decide a payment is already counted.
  const duplicate =
    draft.kind === "payment" &&
    amount != null &&
    draft.issued_on !== "" &&
    payments.some(
      (p) =>
        (p.paid_on ?? "").slice(0, 10) === draft.issued_on &&
        Math.round(p.amount * 100) === Math.round(Math.abs(amount) * 100) &&
        p.currency.toUpperCase() === draft.currency.toUpperCase(),
    )
      ? "A payment of this amount on this day is already in the finance records. Add it only if the client really paid twice."
      : null;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const isPayment = draft.kind === "payment";

  return (
    <div className="flex flex-col gap-2.5 border-t border-border bg-slate-50 px-3.5 py-3">
      <div className="flex flex-wrap items-end gap-2.5">
        {!isPayment && (
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Type</span>
            {/* The sign comes from here, never from what was typed: a credit note entered
                as a positive figure would otherwise add to the invoiced total. */}
            <select
              value={draft.kind}
              onChange={(e) => set({ kind: e.target.value as ManualKind })}
              className={`${FIELD} w-[130px]`}
            >
              <option value="invoice">Invoice</option>
              <option value="credit_note">Credit note</option>
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{isPayment ? "Reference" : "Document"}</span>
          <input
            autoFocus
            value={draft.document_ref}
            onChange={(e) => set({ document_ref: e.target.value })}
            placeholder={isPayment ? "Bank reference" : "USI-US26-00063"}
            className={`${FIELD} w-[170px] font-mono`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{isPayment ? "Paid on" : "Issued"}</span>
          <input
            type="date"
            value={draft.issued_on}
            onChange={(e) => set({ issued_on: e.target.value })}
            className={`${FIELD} w-[140px]`}
          />
        </label>
        {!isPayment && (
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Due</span>
            <input
              type="date"
              value={draft.due_on}
              onChange={(e) => set({ due_on: e.target.value })}
              className={`${FIELD} w-[140px]`}
            />
          </label>
        )}
        {isPayment && (
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Method</span>
            <input
              value={draft.method}
              onChange={(e) => set({ method: e.target.value })}
              placeholder="Bank transfer"
              className={`${FIELD} w-[150px]`}
            />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className={LABEL}>
            {draft.kind === "credit_note" ? "Amount credited" : "Amount"}
          </span>
          <input
            inputMode="decimal"
            value={draft.amount}
            onChange={(e) => set({ amount: e.target.value })}
            placeholder="12000.00"
            className={`${FIELD} w-[120px] text-right tabular-nums`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Currency</span>
          <input
            value={draft.currency}
            onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
            className={`${FIELD} w-[80px]`}
          />
        </label>
        <Button
          variant="naboo"
          size="naboo"
          disabled={problem != null || save.isPending}
          onClick={() =>
            save.mutate({
              event_ref: eventRef,
              kind: draft.kind,
              document_ref: draft.document_ref || null,
              issued_on: draft.issued_on || null,
              due_on: draft.due_on || null,
              // Signed here as well as on the server, so the figure sent is the figure meant.
              amount: amount == null ? null : signedAmount(draft.kind, amount),
              currency: draft.currency || null,
              method: draft.method || null,
              note: draft.note || null,
            })
          }
        >
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          {entry ? "Save" : "Add"}
        </Button>
        <Button variant="naboo-ghost" size="naboo" onClick={onCancel}>
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Cancel
        </Button>
      </div>

      {draft.kind === "credit_note" && (
        <p className="m-0 text-[11.5px] text-slate-500">
          Type the amount as a positive figure — a credit note is subtracted from the total.
        </p>
      )}
      {problem && draft.amount.trim() !== "" && (
        <p role="alert" className="m-0 text-[11.5px] text-[#B4534B]">
          {problem}
        </p>
      )}
      {/* Warnings, not refusals. */}
      {refNote && <p className="m-0 text-[11.5px] text-[#854F0B]">{refNote}</p>}
      {duplicate && <p className="m-0 text-[11.5px] text-[#854F0B]">{duplicate}</p>}
      {save.isError && (
        <p role="alert" className="m-0 text-[11.5px] text-[#B4534B]">
          {String((save.error as Error).message)}
        </p>
      )}
    </div>
  );
}

/** The two buttons that open the form, under the table. */
export function AddEntryBar({
  onAddDocument,
  onAddPayment,
}: {
  onAddDocument: () => void;
  onAddPayment: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-3.5 py-2.5">
      <button
        type="button"
        onClick={onAddDocument}
        className="inline-flex items-center gap-1.5 rounded-md border border-input bg-white px-2.5 py-1 text-[11.5px] font-medium text-navy transition-colors [&:hover]:bg-slate-50"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add invoice or credit note
      </button>
      <button
        type="button"
        onClick={onAddPayment}
        className="inline-flex items-center gap-1.5 rounded-md border border-input bg-white px-2.5 py-1 text-[11.5px] font-medium text-navy transition-colors [&:hover]:bg-slate-50"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add payment
      </button>
      <span className="text-[11px] text-slate-400">
        For documents the back office has issued and the finance records have not caught up with
        yet.
      </span>
    </div>
  );
}

export { emptyDraft, draftOf };
export type { Draft };
