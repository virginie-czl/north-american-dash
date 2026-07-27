/**
 * Review step for provider information requests.
 *
 * Nothing leaves the mailbox until the list has been seen: who receives it, what
 * each one is asked for, and which bookings it covers. Recipients can be
 * unticked, each message can be read and edited, and drafting is offered next to
 * sending so a whole round can be reviewed in Gmail first.
 */
import { useMemo, useState } from "react";
import { AlertCircle, Check, ExternalLink, FileText, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePartnerRequests, type OutgoingMessage } from "@/lib/use-gmail";
import { composeRequest, describeNeeds, type RequestTarget } from "@/lib/partner-requests";

export function RequestInfoDialog({
  targets,
  senderName,
  onClose,
}: {
  targets: RequestTarget[];
  senderName: string | null;
  onClose: () => void;
}) {
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, OutgoingMessage>>({});
  const [confirmSend, setConfirmSend] = useState(false);
  const requests = usePartnerRequests();

  const composed = useMemo(() => {
    const map = new Map<string, OutgoingMessage>();
    for (const t of targets) {
      const draft = edits[t.address] ?? {
        to: t.address,
        ...composeRequest(t, senderName),
      };
      map.set(t.address, draft);
    }
    return map;
  }, [targets, senderName, edits]);

  const selected = targets.filter((t) => !excluded.has(t.address));
  const messages = selected.map((t) => composed.get(t.address)!).filter(Boolean);
  const finished = !requests.running && requests.results.length > 0;
  const failures = requests.results.filter((r) => !r.ok);

  function toggle(address: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Demander les informations manquantes"
        className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
      >
        <header className="flex flex-none items-start gap-3 border-b border-border px-5 py-3.5">
          <span className="min-w-0">
            <h2 className="font-display text-lg font-bold leading-tight">
              Demander les informations manquantes
            </h2>
            <p className="mt-0.5 text-[12.5px] text-slate-600">
              {targets.length} prestataire{targets.length > 1 ? "s" : ""} — un seul email par
              adresse, même si le prestataire intervient sur plusieurs événements. Envoyé depuis
              votre Gmail.
            </p>
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="ml-auto rounded-md p-1 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto">
          <ul className="divide-y divide-border">
            {targets.map((t) => {
              const message = composed.get(t.address)!;
              const off = excluded.has(t.address);
              const result = requests.results.find(
                (r) => r.to.toLowerCase() === t.address.toLowerCase(),
              );
              return (
                <li key={t.address} className={off ? "bg-slate-50/60 opacity-60" : ""}>
                  <div className="flex flex-wrap items-start gap-2.5 px-5 py-2.5">
                    <input
                      type="checkbox"
                      checked={!off}
                      disabled={requests.running || finished}
                      onChange={() => toggle(t.address)}
                      aria-label={`Inclure ${t.partnerName}`}
                      className="mt-1 h-3.5 w-3.5 accent-navy"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium">{t.partnerName}</span>
                      <span className="block truncate text-[11.5px] text-slate-500">
                        {t.address} · {t.events.join(", ")}
                      </span>
                      <span className="mt-0.5 inline-flex items-center rounded-full bg-amber-100 px-2 py-[1px] text-[10px] font-medium text-amber-800">
                        {describeNeeds(t.needs)}
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
                                Brouillon
                              </a>
                            ) : (
                              "Envoyé"
                            )}
                          </span>
                        ) : (
                          <span
                            title={result.error}
                            className="inline-flex items-center gap-1 text-[11px] text-rose-800"
                          >
                            <AlertCircle className="h-3 w-3" aria-hidden="true" />
                            Échec
                          </span>
                        ))}
                      <button
                        type="button"
                        onClick={() => setExpanded(expanded === t.address ? null : t.address)}
                        className="text-[11px] text-slate-600 underline-offset-2 hover:underline"
                      >
                        {expanded === t.address ? "Masquer" : "Relire"}
                      </button>
                    </span>
                  </div>

                  {expanded === t.address && (
                    <div className="space-y-2 border-t border-border bg-slate-50 px-5 py-3">
                      <input
                        value={message.subject}
                        disabled={requests.running || finished}
                        onChange={(e) =>
                          setEdits((prev) => ({
                            ...prev,
                            [t.address]: { ...message, subject: e.target.value },
                          }))
                        }
                        aria-label="Objet"
                        className="w-full rounded-md border border-input bg-white px-2 py-1.5 text-[12px]"
                      />
                      <textarea
                        value={message.body}
                        rows={12}
                        disabled={requests.running || finished}
                        onChange={(e) =>
                          setEdits((prev) => ({
                            ...prev,
                            [t.address]: { ...message, body: e.target.value },
                          }))
                        }
                        aria-label="Message"
                        className="w-full resize-y rounded-md border border-input bg-white px-2 py-1.5 text-[12px] leading-relaxed"
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <footer className="flex flex-none flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          {requests.running ? (
            <span className="text-[12.5px] text-slate-600">
              Envoi en cours… {requests.done}/{requests.total}
            </span>
          ) : finished ? (
            <span className="text-[12.5px] text-slate-700">
              {requests.results.filter((r) => r.ok).length} réussi
              {requests.results.filter((r) => r.ok).length > 1 ? "s" : ""}
              {failures.length > 0 && `, ${failures.length} en échec`}.
            </span>
          ) : (
            <span className="text-[12.5px] text-slate-600">
              {selected.length} destinataire{selected.length > 1 ? "s" : ""} sélectionné
              {selected.length > 1 ? "s" : ""}
            </span>
          )}

          <span className="ml-auto flex flex-wrap items-center gap-2">
            {finished ? (
              <Button size="sm" className="h-8" onClick={onClose}>
                Fermer
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5"
                  disabled={requests.running || messages.length === 0}
                  onClick={() => requests.run(messages, "draft")}
                >
                  <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  Créer {messages.length} brouillon{messages.length > 1 ? "s" : ""}
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
                      Confirmer l'envoi à {messages.length} prestataire
                      {messages.length > 1 ? "s" : ""}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setConfirmSend(false)}
                      className="text-[11.5px] text-slate-500 underline-offset-2 hover:underline"
                    >
                      Annuler
                    </button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5"
                    disabled={requests.running || messages.length === 0}
                    onClick={() => setConfirmSend(true)}
                  >
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    Envoyer maintenant
                  </Button>
                )}
              </>
            )}
          </span>
        </footer>

        {requests.error && (
          <p role="alert" className="border-t border-rose-200 bg-rose-50 px-5 py-2 text-xs text-rose-800">
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

/** Small helper so callers can open the dialog with a single target. */
export function useRequestDialog() {
  const [targets, setTargets] = useState<RequestTarget[] | null>(null);
  return {
    targets,
    open: (list: RequestTarget[]) => setTargets(list.length > 0 ? list : null),
    close: () => setTargets(null),
    Icon: ExternalLink,
  };
}
