/**
 * Information request dialog.
 *
 * Shows every provider who needs at least one item, lets you deselect
 * individual recipients, read and edit each message, then creates drafts or
 * sends in one go. Nothing leaves the mailbox until you confirm. Gmail appends
 * your configured signature automatically (insertSignature flag).
 */
import { useMemo, useState } from "react";
import { AlertCircle, Check, ChevronDown, ChevronUp, Send, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePartnerRequests, type OutgoingMessage } from "@/lib/use-gmail";
import { composeRequest, describeNeeds, type RequestTarget } from "@/lib/partner-requests";

// ─── Dialog (full list) ────────────────────────────────────────────────────

export function RequestInfoDialog({
  targets,
  onClose,
}: {
  targets: RequestTarget[];
  onClose: () => void;
}) {
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, OutgoingMessage>>({});
  const [confirmSend, setConfirmSend] = useState(false);
  const requests = usePartnerRequests();

  // Key is `address::eventRef` to allow the same address on different bookings.
  const composedMap = useMemo(() => {
    const map = new Map<string, OutgoingMessage>();
    for (const t of targets) {
      const key = `${t.address}::${t.eventRef}`;
      map.set(key, edits[key] ?? { to: t.address, ...composeRequest(t) });
    }
    return map;
  }, [targets, edits]);

  function key(t: RequestTarget) {
    return `${t.address}::${t.eventRef}`;
  }

  const selected = targets.filter((t) => !excluded.has(key(t)));
  const messages = selected.map((t) => composedMap.get(key(t))!).filter(Boolean);
  const finished = !requests.running && requests.results.length > 0;
  const successes = requests.results.filter((r) => r.ok);
  const failures = requests.results.filter((r) => !r.ok);

  function toggle(t: RequestTarget) {
    const k = key(t);
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  const sentKey = (r: RequestTarget) =>
    requests.results.find((res) => res.to.toLowerCase() === r.address.toLowerCase());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Request missing information"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="flex flex-none items-start gap-3 border-b border-border px-5 py-4">
          <span className="min-w-0">
            <h2 className="font-display text-lg font-bold leading-tight">Send selected</h2>
            <p className="mt-0.5 text-[12.5px] text-slate-600">
              Deselect providers you don't want to contact. Each message will be sent from your
              Gmail. Your Gmail signature will be added automatically.
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

        {/* ── Scrollable provider list ────────────────────────────────────── */}
        <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
          {targets.map((t) => {
            const k = key(t);
            const off = excluded.has(k);
            const message = composedMap.get(k)!;
            const result = sentKey(t);
            const isExpanded = expanded === k;

            return (
              <li key={k} className={off ? "opacity-50" : ""}>
                <div className="flex flex-wrap items-start gap-2.5 px-5 py-3">
                  {/* checkbox */}
                  <input
                    type="checkbox"
                    checked={!off}
                    disabled={requests.running || finished}
                    onChange={() => toggle(t)}
                    aria-label={`Include ${t.partnerName} – ${t.eventRef}`}
                    className="mt-0.5 h-3.5 w-3.5 flex-none accent-navy"
                  />

                  {/* name + meta */}
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold">{t.partnerName}</span>
                    <span className="block truncate text-[11.5px] text-slate-500">{t.address}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-[1px] text-[10px] font-medium text-slate-600">
                        {t.eventRef}
                      </span>
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-[1px] text-[10px] font-medium text-amber-800">
                        {describeNeeds(t.needs)}
                      </span>
                    </span>
                  </span>

                  {/* status + preview toggle */}
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

                {/* editable preview */}
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
                        setEdits((prev) => ({
                          ...prev,
                          [k]: { ...message, body: e.target.value },
                        }))
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

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <footer className="flex flex-none flex-wrap items-center gap-2 border-t border-border bg-slate-50 px-5 py-3">
          {requests.running ? (
            <span className="text-[12.5px] text-slate-600">
              {requests.done}/{requests.total} sent…
            </span>
          ) : finished ? (
            <span className="text-[12.5px]">
              <span className="text-emerald-800">{successes.length} successful</span>
              {failures.length > 0 && (
                <span className="ml-2 text-rose-800">{failures.length} failed</span>
              )}
            </span>
          ) : (
            <span className="text-[12.5px] text-slate-600">
              {selected.length} of {targets.length} selected
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
        {finished && failures.length > 0 && (
          <ul className="border-t border-rose-200 bg-rose-50 px-5 py-2 text-xs text-rose-800">
            {failures.map((f) => (
              <li key={f.to}>
                {f.to} — {f.error}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function useRequestDialog() {
  const [targets, setTargets] = useState<RequestTarget[] | null>(null);
  return {
    targets,
    open: (list: RequestTarget[]) => setTargets(list.length > 0 ? list : null),
    close: () => setTargets(null),
  };
}
