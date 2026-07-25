/**
 * Per-event Gmail panel — strictly the signed-in user's own mailbox.
 *
 * INVARIANT: everything shown here (thread links, subjects, dates) is resolved
 * live from the caller's session on the server. No thread id, link or subject is
 * ever persisted, so it cannot reach another user. The shared stickers above this
 * panel are the opposite: derived verdicts only, readable by the whole team.
 * If you ever add a column to `partner_email_facts`, keep it on the verdict side
 * of that line — a stored thread id would hand a colleague a link into a mailbox
 * that is not theirs.
 *
 * Nothing is fetched until the user asks for it — opening an event should not
 * silently query someone's mailbox — and sending always requires a second click.
 */
import { useState } from "react";
import { ExternalLink, Mail, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useDraftEmail,
  useGmailConnection,
  usePartnerEmails,
  useSendEmail,
} from "@/lib/use-gmail";

export type PartnerContact = {
  name: string | null;
  email: string | null;
  /** Outstanding amount, already formatted for display. */
  owed?: string | null;
};

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export function PartnerEmails({
  eventRef,
  partners,
}: {
  eventRef: string;
  partners: PartnerContact[];
}) {
  const { data: connection } = useGmailConnection();
  const [enabled, setEnabled] = useState(false);
  const addresses = partners.map((p) => p.email ?? "").filter(Boolean);
  const { data, isFetching, error, refetch } = usePartnerEmails(addresses, enabled);
  const [composeFor, setComposeFor] = useState<PartnerContact | null>(null);

  if (addresses.length === 0) return null;

  if (!connection?.connected) {
    return (
      <div className="rounded-lg border border-border bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
        <span className="font-medium">Connectez Gmail</span> depuis le menu de votre compte pour
        retrouver vos propres échanges avec ces partenaires et préparer des relances d'ici. Les
        pastilles ci-dessus restent visibles sans cela.
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-3.5 py-2">
        <Mail className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-600">
          Ma boîte Gmail
        </span>
        <span className="text-[10px] text-slate-400">visible uniquement par vous</span>
        <div className="ml-auto flex items-center gap-1.5">
          {enabled && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw
                className={`mr-1 h-3 w-3 ${isFetching ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              Actualiser
            </Button>
          )}
          {!enabled && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => setEnabled(true)}
            >
              Chercher dans ma boîte
            </Button>
          )}
        </div>
      </header>

      {!enabled && (
        <p className="px-3.5 py-2.5 text-[11.5px] text-slate-500">
          Recherche dans votre boîte les {addresses.length} partenaire
          {addresses.length > 1 ? "s" : ""} de cet événement. Rien n'est enregistré : seules les
          pastilles partagées, sans contenu, sont visibles par l'équipe.
        </p>
      )}

      {enabled && isFetching && !data && (
        <p className="px-3.5 py-2.5 text-[11.5px] text-slate-500">Recherche…</p>
      )}

      {error != null && (
        <p role="alert" className="px-3.5 py-2.5 text-[11.5px] text-rose-800">
          {String((error as Error).message ?? error)}
        </p>
      )}

      {enabled && data && (
        <ul className="divide-y divide-border">
          {partners.map((partner) => {
            const address = (partner.email ?? "").toLowerCase();
            if (!address) return null;
            const match = data.find((d) => d.address === address);
            const since = daysAgo(match?.lastOutboundAt ?? null);
            return (
              <li key={address} className="px-3.5 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12.5px] font-medium">{partner.name ?? address}</span>
                  {match == null ? (
                    <span className="pill bg-slate-100 text-slate-600">Rien dans ma boîte</span>
                  ) : match.replied ? (
                    <span className="pill bg-emerald-100 text-emerald-800">
                      Répondu le {fmtWhen(match.lastInboundAt)}
                    </span>
                  ) : (
                    <span className="pill bg-amber-100 text-amber-800">
                      Sans réponse{since != null ? ` · ${since}j` : ""}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1.5">
                    {match && (
                      <a
                        href={match.link}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-slate-600 underline-offset-2 hover:underline"
                      >
                        Ouvrir le fil
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </a>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => setComposeFor(partner)}
                    >
                      Relance
                    </Button>
                  </div>
                </div>
                {match && (
                  <p className="mt-0.5 text-[10.5px] text-slate-400">
                    Dernier envoi {fmtWhen(match.lastOutboundAt)} · {match.subject}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {composeFor && (
        <ComposeReminder
          eventRef={eventRef}
          partner={composeFor}
          onClose={() => setComposeFor(null)}
        />
      )}
    </section>
  );
}

function ComposeReminder({
  eventRef,
  partner,
  onClose,
}: {
  eventRef: string;
  partner: PartnerContact;
  onClose: () => void;
}) {
  const to = partner.email ?? "";
  const [subject, setSubject] = useState(`Naboo — ${eventRef} : coordonnées bancaires`);
  const [body, setBody] = useState(
    `Bonjour,\n\nNous préparons le règlement de votre prestation pour l'événement ${eventRef}` +
      `${partner.owed ? ` (montant restant : ${partner.owed})` : ""}.\n\n` +
      `Pourriez-vous nous transmettre vos coordonnées bancaires ainsi que votre facture, ` +
      `afin que nous puissions procéder au paiement ?\n\nMerci d'avance,\nNaboo — Finance`,
  );
  const [confirmSend, setConfirmSend] = useState(false);
  const draft = useDraftEmail();
  const send = useSendEmail();

  const busy = draft.isPending || send.isPending;
  const result = draft.data;
  const sent = send.data;

  return (
    <div className="space-y-2 border-t border-border bg-slate-50 px-3.5 py-3">
      <div className="flex items-center gap-2 text-[11px] text-slate-600">
        <span className="font-medium">To</span>
        <span className="font-mono">{to}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-[11px] text-slate-500 underline-offset-2 hover:underline"
        >
          Fermer
        </button>
      </div>
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        aria-label="Subject"
        className="w-full rounded-md border border-input bg-card px-2 py-1.5 text-[12px]"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label="Message"
        rows={7}
        className="w-full resize-y rounded-md border border-input bg-card px-2 py-1.5 text-[12px] leading-relaxed"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-[11.5px]"
          disabled={busy}
          onClick={() => draft.mutate({ to, subject, body })}
        >
          {draft.isPending ? "Enregistrement…" : "Enregistrer en brouillon"}
        </Button>
        {confirmSend ? (
          <>
            <Button
              size="sm"
              className="h-7 gap-1.5 bg-naboo text-[11.5px] font-semibold text-navy hover:bg-naboo-hover"
              disabled={busy}
              onClick={() => send.mutate({ to, subject, body })}
            >
              <Send className="h-3 w-3" aria-hidden="true" />
              {send.isPending ? "Envoi…" : `Confirmer l\u2019envoi à ${to}`}
            </Button>
            <button
              type="button"
              onClick={() => setConfirmSend(false)}
              className="text-[11px] text-slate-500 underline-offset-2 hover:underline"
            >
              Cancel
            </button>
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-[11.5px]"
            disabled={busy || sent != null}
            onClick={() => setConfirmSend(true)}
          >
            <Send className="h-3 w-3" aria-hidden="true" />
            Envoyer maintenant
          </Button>
        )}
      </div>
      {result && (
        <p className="text-[11px] text-emerald-800">
          Brouillon enregistré.{" "}
          <a
            href={result.link}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Ouvrir dans Gmail
          </a>
        </p>
      )}
      {sent && <p className="text-[11px] text-emerald-800">Envoyé à {to}.</p>}
      {(draft.isError || send.isError) && (
        <p role="alert" className="text-[11px] text-rose-800">
          {String(
            (draft.error as Error)?.message ?? (send.error as Error)?.message ?? "Request failed",
          )}
        </p>
      )}
    </div>
  );
}
