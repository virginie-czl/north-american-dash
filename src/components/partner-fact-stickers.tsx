/**
 * The shared "stickers": a compact read-out of what the email scan established
 * about a partner. Visible to every tracker user; the hover text names who acted
 * and when, but never reveals any message content.
 */
import { CreditCard, Landmark, Mail, Receipt } from "lucide-react";
import type { PartnerFacts } from "@/lib/use-gmail";
import type { PartnerAction } from "@/lib/partner-actions";

function shortDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function who(email: string | null): string {
  if (!email) return "un membre de l'équipe";
  const local = email.split("@")[0];
  return local
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

type Tone = "none" | "pending" | "good" | "bad";

const TONE: Record<Tone, string> = {
  none: "bg-slate-100 text-slate-400",
  pending: "bg-amber-100 text-amber-800",
  good: "bg-emerald-100 text-emerald-800",
  bad: "bg-rose-100 text-rose-800",
};

function Sticker({
  icon,
  label,
  tone,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  tone: Tone;
  title: string;
}) {
  return (
    <span
      title={title}
      aria-label={title}
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[10px] font-medium leading-tight ${TONE[tone]}`}
    >
      {icon}
      {label}
    </span>
  );
}

const ICON = "h-2.5 w-2.5 shrink-0";


/** Colour by who owes the next move: amber = partner, navy = us, grey = closed. */
const ACTION_TONE: Record<string, string> = {
  settled: "bg-slate-100 text-slate-500",
  ours_pay: "bg-sky-100 text-sky-800",
  ours_record_tax: "bg-sky-100 text-sky-800",
  ask_card: "bg-amber-100 text-amber-800",
  ask_bank: "bg-amber-100 text-amber-800",
  ask_tax: "bg-amber-100 text-amber-800",
  ask_bank_and_tax: "bg-rose-100 text-rose-800",
  await_reply: "bg-amber-100 text-amber-800",
  blocked_no_po: "bg-slate-100 text-slate-500",
};

export function ActionSticker({ action }: { action: PartnerAction }) {
  const tax = action.tax;
  const taxNote = tax.usable
    ? `Taxes en base : ${[tax.gst, tax.qst, tax.vat].filter(Boolean).join(" / ")}`
    : tax.unparsed
      ? `Taxes en base illisibles : « ${tax.unparsed} »`
      : "Aucun numéro de taxes en base";
  return (
    <span
      title={`${action.detail}\n${taxNote}`}
      aria-label={`${action.label} — ${action.detail}`}
      className={`inline-flex items-center rounded-full px-1.5 py-[1px] text-[10px] font-medium leading-tight ${
        ACTION_TONE[action.code] ?? "bg-slate-100 text-slate-500"
      }`}
    >
      {action.label}
    </span>
  );
}

/** Builds the four stickers for one partner, or null when never scanned. */
export function PartnerFactStickers({ facts }: { facts: PartnerFacts | undefined }) {
  if (!facts) return null;

  const viaDealCode =
    facts.matched_by === "deal_code" ? " (rapproché via le code deal, pas l'adresse)" : "";

  // Contact / reply
  let contactTone: Tone = "none";
  let contactLabel = "Jamais contacté";
  let contactTitle = "Aucun échange trouvé dans les emails scannés";
  if (facts.replied_at) {
    contactTone = "good";
    contactLabel = "A répondu";
    contactTitle = `A répondu le ${shortDate(facts.replied_at)}${viaDealCode}`;
  } else if (facts.contacted_at) {
    contactTone = "pending";
    contactLabel = "Sans réponse";
    contactTitle = `Contacté par ${who(facts.contacted_by)} le ${shortDate(
      facts.contacted_at,
    )} — pas de réponse${viaDealCode}`;
  }

  // Bank details
  const bankTone: Tone =
    facts.bank_details === "received" ? "good" : facts.bank_details === "asked" ? "pending" : "none";
  const bankLabel =
    facts.bank_details === "received"
      ? "Bancaire reçu"
      : facts.bank_details === "asked"
        ? "Bancaire demandé"
        : "Bancaire —";
  const bankTitle =
    facts.bank_details === "received"
      ? `Coordonnées bancaires reçues le ${shortDate(facts.bank_received_at)}`
      : facts.bank_details === "asked"
        ? `Demandé par ${who(facts.bank_asked_by)} le ${shortDate(facts.bank_asked_at)}`
        : "Coordonnées bancaires jamais demandées";

  // Tax info
  const taxTone: Tone =
    facts.tax_info === "received" ? "good" : facts.tax_info === "asked" ? "pending" : "none";
  const taxLabel =
    facts.tax_info === "received"
      ? "Taxes reçu"
      : facts.tax_info === "asked"
        ? "Taxes demandé"
        : "Taxes —";
  const taxTitle =
    facts.tax_info === "received"
      ? `Numéros de taxes reçus le ${shortDate(facts.tax_received_at)}`
      : facts.tax_info === "asked"
        ? `Demandé par ${who(facts.tax_asked_by)} le ${shortDate(facts.tax_asked_at)}`
        : "Numéros de taxes jamais demandés";

  // Card
  const cardTone: Tone =
    facts.card_payment === "accepted" ? "good" : facts.card_payment === "refused" ? "bad" : "none";
  const cardLabel =
    facts.card_payment === "accepted"
      ? "Carte OK"
      : facts.card_payment === "refused"
        ? "Carte refusée"
        : "Carte —";
  const cardTitle =
    facts.card_payment === "accepted"
      ? `Accepte le paiement par carte (indiqué le ${shortDate(facts.card_decided_at)})`
      : facts.card_payment === "refused"
        ? `Refuse le paiement par carte (indiqué le ${shortDate(facts.card_decided_at)})`
        : "Position sur le paiement par carte inconnue";

  return (
    <span className="mt-1 flex flex-wrap gap-1">
      <Sticker
        icon={<Mail className={ICON} aria-hidden="true" />}
        label={contactLabel}
        tone={contactTone}
        title={contactTitle}
      />
      <Sticker
        icon={<Landmark className={ICON} aria-hidden="true" />}
        label={bankLabel}
        tone={bankTone}
        title={bankTitle}
      />
      <Sticker
        icon={<Receipt className={ICON} aria-hidden="true" />}
        label={taxLabel}
        tone={taxTone}
        title={taxTitle}
      />
      <Sticker
        icon={<CreditCard className={ICON} aria-hidden="true" />}
        label={cardLabel}
        tone={cardTone}
        title={cardTitle}
      />
    </span>
  );
}

/** Row-level roll-up for the table: the most actionable gap, as one sticker set. */
export function EventFactStickers({
  eventRef,
  partnerKeys,
  factsMap,
}: {
  eventRef: string;
  partnerKeys: string[];
  factsMap: Map<string, PartnerFacts> | undefined;
}) {
  if (!factsMap || partnerKeys.length === 0) return null;
  const rows = partnerKeys
    .map((k) => factsMap.get(`${eventRef}::${k}`))
    .filter((f): f is PartnerFacts => f != null);
  if (rows.length === 0) return null;

  // Worst state across the event's partners drives the row sticker.
  const rank = { not_asked: 0, asked: 1, received: 2 } as const;
  const worst = <T extends "bank_details" | "tax_info">(field: T) =>
    rows.reduce<PartnerFacts[T]>(
      (acc, r) => (rank[r[field]] < rank[acc] ? r[field] : acc),
      "received" as PartnerFacts[T],
    );

  const summary: PartnerFacts = {
    ...rows[0],
    contacted_at: rows.every((r) => r.contacted_at) ? rows[0].contacted_at : null,
    replied_at: rows.every((r) => r.replied_at) ? rows[0].replied_at : null,
    bank_details: worst("bank_details"),
    tax_info: worst("tax_info"),
    card_payment: rows.some((r) => r.card_payment === "refused")
      ? "refused"
      : rows.every((r) => r.card_payment === "accepted")
        ? "accepted"
        : "unknown",
  };
  return <PartnerFactStickers facts={summary} />;
}
