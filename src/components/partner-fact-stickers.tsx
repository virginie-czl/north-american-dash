/**
 * The shared stickers. Two independent sources feed them:
 *
 *  - BigQuery (tax registration, amounts) — always available, needs no Gmail.
 *  - The email scan (contacted / replied / bank / card) — only once someone has run
 *    a search, and only ever as derived verdicts.
 *
 * Keeping them separate matters: the tax and action stickers must show up for a
 * user who has never touched Gmail, and the email stickers must stay silent rather
 * than assert "never contacted" when the truth is "nobody has looked yet".
 *
 * Hover text names who acted and when; message content is never exposed here.
 */
import { CreditCard, Landmark, Mail, Receipt } from "lucide-react";
import type { PartnerFacts } from "@/lib/use-gmail";
import { partnerKey } from "@/lib/annotations.functions";
import {
  parseTaxRegistration,
  taxComplete,
  type PartnerAction,
  type TaxRegistration,
} from "@/lib/partner-actions";

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
  return email
    .split("@")[0]
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

type Tone = "none" | "pending" | "good" | "bad" | "info";

const TONE: Record<Tone, string> = {
  none: "bg-slate-100 text-slate-500",
  pending: "bg-amber-100 text-amber-800",
  good: "bg-emerald-100 text-emerald-800",
  bad: "bg-rose-100 text-rose-800",
  info: "bg-sky-100 text-sky-800",
};

const ICON = "h-2.5 w-2.5 shrink-0";

function Sticker({
  icon,
  label,
  tone,
  title,
}: {
  icon?: React.ReactNode;
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

// --- Action -----------------------------------------------------------------

/** Colour by who owes the next move: amber/rose = partner, sky = us, grey = closed. */
const ACTION_TONE: Record<string, Tone> = {
  settled: "none",
  ours_pay: "info",
  ours_record_tax: "info",
  ask_card: "pending",
  ask_bank: "pending",
  ask_tax: "pending",
  ask_bank_and_tax: "bad",
  await_reply: "pending",
  blocked_no_po: "none",
};

/** Most urgent first — drives which partner's action represents the whole event. */
const ACTION_PRIORITY = [
  "ask_bank_and_tax",
  "ask_bank",
  "ask_tax",
  "ask_card",
  "await_reply",
  "ours_record_tax",
  "ours_pay",
  "blocked_no_po",
  "settled",
];

export function ActionSticker({ action }: { action: PartnerAction }) {
  const tax = action.tax;
  const taxNote = tax.usable
    ? `Taxes en base : ${[tax.gst, tax.qst, tax.vat].filter(Boolean).join(" / ")}`
    : tax.unparsed
      ? `Taxes en base illisibles : « ${tax.unparsed} »`
      : "Aucun numéro de taxes en base";
  return (
    <Sticker
      label={action.label}
      tone={ACTION_TONE[action.code] ?? "none"}
      title={`${action.detail}\n${taxNote}`}
    />
  );
}

// --- Tax (BigQuery, no Gmail required) --------------------------------------

export function TaxSticker({
  registration,
  country,
  emailReceivedAt,
  emailAskedAt,
  emailAskedBy,
}: {
  registration: TaxRegistration;
  country: string | null;
  emailReceivedAt?: string | null;
  emailAskedAt?: string | null;
  emailAskedBy?: string | null;
}) {
  const onFile = taxComplete(registration, country);
  const ids = [registration.gst, registration.qst, registration.vat].filter(Boolean).join(" / ");

  if (onFile) {
    return (
      <Sticker
        icon={<Receipt className={ICON} aria-hidden="true" />}
        label="Taxes en base"
        tone="good"
        title={`Enregistré dans Naboo : ${ids}`}
      />
    );
  }
  // Partial registration is worth calling out: a Canadian partner with only a GST
  // still cannot be invoiced correctly.
  if (registration.usable) {
    return (
      <Sticker
        icon={<Receipt className={ICON} aria-hidden="true" />}
        label="Taxes incomplet"
        tone="pending"
        title={`En base : ${ids} — il manque ${
          (country ?? "").toUpperCase() === "CA"
            ? registration.gst
              ? "le TVQ"
              : "le GST/TPS"
            : "un identifiant valide"
        }`}
      />
    );
  }
  if (registration.unparsed) {
    return (
      <Sticker
        icon={<Receipt className={ICON} aria-hidden="true" />}
        label="Taxes illisible"
        tone="bad"
        title={`Valeur en base non reconnue : « ${registration.unparsed} » — à corriger`}
      />
    );
  }
  if (emailReceivedAt) {
    return (
      <Sticker
        icon={<Receipt className={ICON} aria-hidden="true" />}
        label="Taxes à saisir"
        tone="pending"
        title={`Reçus par email le ${shortDate(emailReceivedAt)} — pas encore enregistrés dans Naboo`}
      />
    );
  }
  if (emailAskedAt) {
    return (
      <Sticker
        icon={<Receipt className={ICON} aria-hidden="true" />}
        label="Taxes demandé"
        tone="pending"
        title={`Demandé par ${who(emailAskedBy ?? null)} le ${shortDate(emailAskedAt)} — rien reçu`}
      />
    );
  }
  return (
    <Sticker
      icon={<Receipt className={ICON} aria-hidden="true" />}
      label="Taxes absent"
      tone="none"
      title="Rien en base et aucune demande retrouvée"
    />
  );
}

// --- Email-derived stickers (only when a scan has actually run) --------------

export function EmailStickers({ facts }: { facts: PartnerFacts | undefined }) {
  if (!facts) {
    return (
      <Sticker
        label="Emails non scannés"
        tone="none"
        title="Personne n'a encore lancé de recherche email pour ce partenaire"
      />
    );
  }
  const viaDealCode =
    facts.matched_by === "deal_code" ? " (rapproché via le code deal, pas l'adresse)" : "";

  let contactTone: Tone = "none";
  let contactLabel = "Jamais contacté";
  let contactTitle = "Aucun échange trouvé lors du dernier scan";
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

  const bankTone: Tone =
    facts.bank_details === "received" ? "good" : facts.bank_details === "asked" ? "pending" : "none";
  const bankLabel =
    facts.bank_details === "received"
      ? "Bancaire reçu"
      : facts.bank_details === "asked"
        ? "Bancaire demandé"
        : "Bancaire absent";
  const bankTitle =
    facts.bank_details === "received"
      ? `Coordonnées bancaires reçues le ${shortDate(facts.bank_received_at)}`
      : facts.bank_details === "asked"
        ? `Demandé par ${who(facts.bank_asked_by)} le ${shortDate(facts.bank_asked_at)}`
        : "Jamais demandé";

  const cardTone: Tone =
    facts.card_payment === "accepted" ? "good" : facts.card_payment === "refused" ? "bad" : "none";
  const cardLabel =
    facts.card_payment === "accepted"
      ? "Carte OK"
      : facts.card_payment === "refused"
        ? "Carte refusée"
        : "Carte inconnue";
  const cardTitle =
    facts.card_payment === "accepted"
      ? `Accepte la carte (indiqué le ${shortDate(facts.card_decided_at)})`
      : facts.card_payment === "refused"
        ? `Refuse la carte (indiqué le ${shortDate(facts.card_decided_at)})`
        : "Position sur le paiement par carte inconnue";

  return (
    <>
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
        icon={<CreditCard className={ICON} aria-hidden="true" />}
        label={cardLabel}
        tone={cardTone}
        title={cardTitle}
      />
    </>
  );
}

// --- Composites -------------------------------------------------------------

export type StickerPartner = {
  name: string | null;
  email: string | null;
  amount_due: number | null;
  vat_raw: string | null;
  tax_identifier: string | null;
  country: string | null;
  is_cancelled?: boolean | null;
};

/** One partner, inside the event drawer. */
export function PartnerStickers({
  action,
  facts,
  partner,
}: {
  action: PartnerAction;
  facts: PartnerFacts | undefined;
  partner: StickerPartner;
}) {
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      <ActionSticker action={action} />
      <TaxSticker
        registration={action.tax}
        country={partner.country}
        emailReceivedAt={facts?.tax_received_at}
        emailAskedAt={facts?.tax_asked_at}
        emailAskedBy={facts?.tax_asked_by}
      />
      <EmailStickers facts={facts} />
    </span>
  );
}

/**
 * Row-level roll-up. Renders from BigQuery alone when no scan has ever run, so the
 * tax and action state is visible without Gmail.
 */
export function EventStickers({
  eventRef,
  partners,
  hasPo,
  factsMap,
  actionFor,
}: {
  eventRef: string;
  partners: StickerPartner[];
  hasPo: boolean;
  factsMap: Map<string, PartnerFacts> | undefined;
  actionFor: (eventRef: string, partner: StickerPartner, hasPo: boolean) => PartnerAction;
  }) {
  const live = partners.filter((p) => !p.is_cancelled);
  if (live.length === 0) return null;

  const entries = live.map((p) => {
    const key = partnerKey(p.name ?? p.email ?? "");
    return {
      partner: p,
      facts: factsMap?.get(`${eventRef}::${key}`),
      action: actionFor(eventRef, p, hasPo),
      registration: parseTaxRegistration(p.vat_raw, p.tax_identifier),
    };
  });

  // The event inherits its most urgent partner's action.
  const lead = entries.reduce((worst, e) =>
    ACTION_PRIORITY.indexOf(e.action.code) < ACTION_PRIORITY.indexOf(worst.action.code) ? e : worst,
  );

  // Tax: the least complete partner decides, so a 9-partner event with one gap
  // does not read as done.
  const taxLead = entries.reduce((worst, e) => {
    const score = (x: typeof e) =>
      taxComplete(x.registration, x.partner.country) ? 3 : x.registration.usable ? 2 : x.registration.unparsed ? 1 : 0;
    return score(e) < score(worst) ? e : worst;
  });

  const anyScanned = entries.some((e) => e.facts != null);

  return (
    <span className="mt-1 flex flex-wrap gap-1">
      <ActionSticker action={lead.action} />
      <TaxSticker
        registration={taxLead.registration}
        country={taxLead.partner.country}
        emailReceivedAt={taxLead.facts?.tax_received_at}
        emailAskedAt={taxLead.facts?.tax_asked_at}
        emailAskedBy={taxLead.facts?.tax_asked_by}
      />
      {anyScanned ? (
        <EmailStickers facts={lead.facts} />
      ) : (
        <Sticker
          label="Emails non scannés"
          tone="none"
          title="Lancez « Rechercher dans mes emails » pour compléter le contact, le bancaire et la carte"
        />
      )}
    </span>
  );
}
