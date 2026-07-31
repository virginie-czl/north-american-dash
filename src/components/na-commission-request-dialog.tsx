/**
 * Recovery request dialog for Marketplace NA — same bulk checklist pattern as
 * RequestInfoDialog (deselect, preview/edit, draft or send), but for the money
 * this tracker chases instead of missing bank/tax info: a commission or refund
 * from a provider, or a balance due from a client.
 */
import { useMemo, useState } from "react";
import { AlertCircle, Check, ChevronDown, ChevronUp, Lock, Send, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePartnerRequests, useRecoveryLog, type OutgoingMessage } from "@/lib/use-gmail";
import { recoveryKey, recoverySentLabel } from "@/lib/recovery-log";

export type NaCommissionTarget = {
  eventRef: string;
  /** Display name of the counterparty: the provider, or the client company. */
  partnerName: string | null;
  address: string;
  contactName: string | null;
  subject: string;
  body: string;
  mode: "commission" | "refund" | "combined" | "client";
};

const MODE_LABEL: Record<NaCommissionTarget["mode"], string> = {
  commission: "commission",
  refund: "refund",
  combined: "commission + refund",
  client: "balance due",
};

const MODE_PILL: Record<NaCommissionTarget["mode"], string> = {
  commission: "bg-sky-100 text-sky-800",
  refund: "bg-rose-100 text-rose-800",
  combined: "bg-amber-100 text-amber-800",
  client: "bg-indigo-100 text-indigo-800",
};

export function NaCommissionRequestDialog({
  targets,
  onClose,
}: {
  targets: NaCommissionTarget[];
  onClose: () => void;
}) {
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, OutgoingMessage>>({});
  const [confirmSend, setConfirmSend] = useState(false);
  const requests = usePartnerRequests();
  const { data: recoveryLog } = useRecoveryLog();

  const key = (t: NaCommissionTarget) => `${t.address}::${t.eventRef}::${t.mode}`;
  // The list is one audience or the other, never mixed: the two buttons that open
  // this dialog each build their own targets.
  const audience = targets.every((t) => t.mode === "client") ? "clients" : "partners";

  /** Already gone out — by whoever got there first, this round or last week. */
  const alreadySent = (t: NaCommissionTarget) =>
    recoveryLog?.get(recoveryKey(t.eventRef, t.address, t.mode));

  const composedMap = useMemo(() => {
    const map = new Map<string, OutgoingMessage>();
    for (const t of targets) {
      const k = key(t);
      map.set(
        k,
        edits[k] ?? {
          to: t.address,
          subject: t.subject,
          body: t.body,
          // Travels with the message so the server can claim the ask in the ledger
          // before it sends, and record who sent it.
          recovery: { event_ref: t.eventRef, mode: t.mode, recipient_name: t.partnerName },
        },
      );
    }
    return map;
  }, [targets, edits]);

  // An ask someone has already sent is out of the round entirely — it cannot be
  // selected, sent or drafted again. The server enforces the same rule, so a stale
  // page cannot get around it either.
  const selected = targets.filter((t) => !excluded.has(key(t)) && !alreadySent(t));
  const messages = selected.map((t) => composedMap.get(key(t))!).filter(Boolean);
  const lockedCount = targets.filter((t) => !!alreadySent(t)).length;
  const finished = !requests.running && requests.results.length > 0;
  const successes = requests.results.filter((r) => r.ok);
  const failures = requests.results.filter((r) => !r.ok);
  // A duplicate the ledger refused is not a failure to fix — it is the feature
  // working. Counting it as one would send someone hunting for a broken address.
  const duplicates = failures.filter((r) => !!r.already_sent);
  const realFailures = failures.filter((r) => !r.already_sent);

  function toggle(t: NaCommissionTarget) {
    const k = key(t);
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // Matched on the booking too: the same provider can be chased on two of them
  // in one round, and each has its own outcome.
  const sentKey = (t: NaCommissionTarget) =>
    requests.results.find(
      (res) =>
        res.to.toLowerCase() === t.address.toLowerCase() &&
        (res.event_ref == null || res.event_ref === t.eventRef),
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={
          audience === "clients" ? "Chase a client balance" : "Request commission or refund"
        }
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
      >
        <header className="flex flex-none items-start gap-3 border-b border-border px-5 py-4">
          <span className="min-w-0">
            <h2 className="font-display text-lg font-bold leading-tight">Send selected</h2>
            <p className="mt-0.5 text-[12.5px] text-slate-600">
              Deselect {audience} you don't want to contact. Each message will be sent from your
              Gmail. Your Gmail signature will be added automatically.
              {lockedCount > 0 &&
                " Asks a colleague has already sent are locked — nobody chases the same counterparty twice on the same booking."}
            </p>
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded-md p-1 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
          {targets.map((t) => {
            const k = key(t);
            const locked = alreadySent(t);
            const off = excluded.has(k) || !!locked;
            const message = composedMap.get(k)!;
            const result = sentKey(t);
            const isExpanded = expanded === k;

            return (
              <li key={k} className={off ? "opacity-50" : ""}>
                <div className="flex flex-wrap items-start gap-2.5 px-5 py-3">
                  <input
                    type="checkbox"
                    checked={!off}
                    disabled={requests.running || finished || !!locked}
                    onChange={() => toggle(t)}
                    aria-label={`Include ${t.partnerName ?? t.eventRef}`}
                    className="mt-0.5 h-3.5 w-3.5 flex-none accent-navy"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold">{t.partnerName ?? "—"}</span>
                    <span className="block truncate text-[11.5px] text-slate-500">{t.address}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-[1px] text-[10px] font-medium text-slate-600">
                        {t.eventRef}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-[1px] text-[10px] font-medium ${MODE_PILL[t.mode]}`}
                      >
                        {MODE_LABEL[t.mode]}
                      </span>
                      {locked && (
                        <span
                          title={`${locked.sent_by}${locked.subject ? ` — ${locked.subject}` : ""}`}
                          className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-[1px] text-[10px] font-semibold text-slate-600"
                        >
                          <Lock className="h-2.5 w-2.5" aria-hidden="true" />
                          {recoverySentLabel(locked)}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {result &&
                      (result.ok ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-800">
                          <Check className="h-3 w-3" aria-hidden="true" />
                          {result.link ? (
                            <a
                              href={result.link}
                              target="_blank"
                              rel="noreferrer"
                              className="underline underline-offset-2"
                            >
                              Draft
                            </a>
                          ) : (
                            "Sent"
                          )}
                        </span>
                      ) : result.already_sent ? (
                        // Lost the race: a colleague sent it between this page
                        // loading and the click. Not a failure — a duplicate avoided.
                        <span
                          title={result.error}
                          className="inline-flex items-center gap-1 text-[11px] text-slate-600"
                        >
                          <Lock className="h-3 w-3" aria-hidden="true" />
                          Already sent
                        </span>
                      ) : (
                        <span
                          title={result.error}
                          className="inline-flex items-center gap-1 text-[11px] text-rose-800"
                        >
                          <AlertCircle className="h-3 w-3" aria-hidden="true" />
                          Failed
                        </span>
                      ))}
                    <button
                      type="button"
                      onClick={() => setExpanded(isExpanded ? null : k)}
                      className="inline-flex items-center gap-1 text-[11px] text-slate-600 underline-offset-2 hover:underline"
                    >
                      Preview
                      {isExpanded ? (
                        <ChevronUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-3 w-3" aria-hidden="true" />
                      )}
                    </button>
                  </span>
                </div>

                {isExpanded && (
                  <div className="space-y-2 border-t border-border bg-slate-50 px-5 py-3">
                    <div className="text-[11px] text-slate-500">
                      <span className="font-medium">To:</span> {t.address}
                    </div>
                    <input
                      value={message.subject}
                      disabled={requests.running || finished}
                      onChange={(e) =>
                        setEdits((prev) => ({
                          ...prev,
                          [k]: { ...message, subject: e.target.value },
                        }))
                      }
                      aria-label="Subject"
                      placeholder="Subject"
                      className="w-full rounded-md border border-input bg-white px-2.5 py-1.5 text-[12px]"
                    />
                    <textarea
                      value={message.body}
                      rows={14}
                      disabled={requests.running || finished}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [k]: { ...message, body: e.target.value } }))
                      }
                      aria-label="Message body"
                      className="w-full resize-y rounded-md border border-input bg-white px-2.5 py-1.5 text-[12px] leading-relaxed"
                    />
                    <p className="text-[10.5px] text-slate-400">
                      Your Gmail signature will be appended automatically.
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <footer className="flex flex-none flex-wrap items-center gap-2 border-t border-border bg-slate-50 px-5 py-3">
          {requests.running ? (
            <span className="text-[12.5px] text-slate-600">
              {requests.done}/{requests.total} sent…
            </span>
          ) : finished ? (
            <span className="text-[12.5px]">
              <span className="text-emerald-800">{successes.length} successful</span>
              {duplicates.length > 0 && (
                <span className="ml-2 text-slate-600">
                  {duplicates.length} already sent by someone else
                </span>
              )}
              {realFailures.length > 0 && (
                <span className="ml-2 text-rose-800">{realFailures.length} failed</span>
              )}
            </span>
          ) : (
            <span className="text-[12.5px] text-slate-600">
              {selected.length} of {targets.length} selected
              {lockedCount > 0 && (
                <span className="text-slate-500"> · {lockedCount} already sent</span>
              )}
            </span>
          )}

          <span className="ml-auto flex flex-wrap items-center gap-2">
            {finished ? (
              <Button size="sm" className="h-8" onClick={onClose}>
                Close
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5"
                  disabled={requests.running || messages.length === 0}
                  onClick={() => {
                    setConfirmSend(false);
                    requests.run(messages, "draft");
                  }}
                >
                  <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  Save as drafts ({messages.length})
                </Button>
                {confirmSend ? (
                  <>
                    <Button
                      size="sm"
                      className="h-8 gap-1.5 border-0 bg-naboo font-semibold text-navy shadow-none hover:bg-naboo-hover"
                      disabled={requests.running || messages.length === 0}
                      onClick={() => requests.run(messages, "send")}
                    >
                      <Send className="h-3.5 w-3.5" aria-hidden="true" />
                      Confirm — send {messages.length}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setConfirmSend(false)}
                      className="text-[11.5px] text-slate-500 underline-offset-2 hover:underline"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    className="h-8 gap-1.5 border-0 bg-naboo font-semibold text-navy shadow-none hover:bg-naboo-hover"
                    disabled={requests.running || messages.length === 0}
                    onClick={() => setConfirmSend(true)}
                  >
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    Send selected ({messages.length})
                  </Button>
                )}
              </>
            )}
          </span>
        </footer>

        {requests.error && (
          <p
            role="alert"
            className="border-t border-rose-200 bg-rose-50 px-5 py-2 text-xs text-rose-800"
          >
            {requests.error}
          </p>
        )}
        {finished && realFailures.length > 0 && (
          <ul className="border-t border-rose-200 bg-rose-50 px-5 py-2 text-xs text-rose-800">
            {realFailures.map((f) => (
              <li key={`${f.to}::${f.event_ref ?? ""}`}>
                {f.to} — {f.error}
              </li>
            ))}
          </ul>
        )}
        {finished && duplicates.length > 0 && (
          <ul className="border-t border-border bg-slate-50 px-5 py-2 text-xs text-slate-600">
            {duplicates.map((f) => (
              <li key={`${f.to}::${f.event_ref ?? ""}`}>
                {f.to} — {f.error}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function useNaCommissionRequestDialog() {
  const [targets, setTargets] = useState<NaCommissionTarget[] | null>(null);
  return {
    targets,
    open: (list: NaCommissionTarget[]) => setTargets(list.length > 0 ? list : null),
    close: () => setTargets(null),
  };
}
