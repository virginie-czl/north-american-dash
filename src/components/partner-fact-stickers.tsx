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
  missingQstForCanada,
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
  card_to_debit: "pending",
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
  "card_to_debit",
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
    const noQst = missingQstForCanada(registration, country);
    // Recognised formats are shown parsed; anything else shows the raw value so
    // the number can still be checked at a glance.
    const detail = ids || registration.unparsed || "";
    return (
      <Sticker
        icon={<Receipt className={ICON} aria-hidden="true" />}
        label="Taxes en base"
        tone="good"
        title={
          `Enregistré dans Naboo : ${detail}` +
          (noQst ? "\nGST présent, TVQ absent — à vérifier avant facturation." : "")
        }
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
      title="Aucun numéro en base et aucune demande retrouvée"
    />
  );
}

// --- Contact sticker (only when a scan has actually run) ---------------------

function ContactSticker({ facts }: { facts: PartnerFacts }) {
  const viaDealCode =
    facts.matched_by === "deal_code" ? " (rapproché via le code deal, pas l'adresse)" : "";
  if (facts.replied_at) {
    return (
      <Sticker
        icon={<Mail className={ICON} aria-hidden="true" />}
        label="A répondu"
        tone="good"
        title={`A répondu le ${shortDate(facts.replied_at)}${viaDealCode}`}
      />
    );
  }
  if (facts.contacted_at) {
    return (
      <Sticker
        icon={<Mail className={ICON} aria-hidden="true" />}
        label="Sans réponse"
        tone="pending"
        title={`Contacté par ${who(facts.contacted_by)} le ${shortDate(
          facts.contacted_at,
        )} — pas de réponse${viaDealCode}`}
      />
    );
  }
  return (
    <Sticker
      icon={<Mail className={ICON} aria-hidden="true" />}
      label="Jamais contacté"
      tone="none"
      title={`Aucun échange trouvé lors du dernier scan${viaDealCode}`}
    />
  );
}

// --- Payment method (single verdict — never card AND bank at once) ----------
// A partner is paid one way or the other, never both, so there is never a
// reason to show a bank sticker next to a card sticker: whichever one answers
// "how do we pay them" wins, and everything else collapses into one pending
// placeholder rather than two separate "we don't know" tags.

function paymentMethodVerdict(
  facts: PartnerFacts | undefined,
  cardReady: boolean,
  cardSource?: "slack" | "email",
): { label: string; tone: Tone; icon: React.ReactNode; title: string; isUnknown: boolean } {
  if (cardReady) {
    return {
      label: "Card OK",
      tone: "good",
      icon: <CreditCard className={ICON} aria-hidden="true" />,
      title:
        cardSource === "slack"
          ? "Carte approuvée dans #finance-paiement-by-card — coordonnées bancaires inutiles"
          : `Accepte explicitement la carte${
              facts?.card_decided_at ? ` (indiqué le ${shortDate(facts.card_decided_at)})` : ""
            } — coordonnées bancaires inutiles`,
      isUnknown: false,
    };
  }
  if (facts?.bank_details === "received") {
    return {
      label: "Bank OK",
      tone: "good",
      icon: <Landmark className={ICON} aria-hidden="true" />,
      title: `Coordonnées bancaires reçues le ${shortDate(facts.bank_received_at)}`,
      isUnknown: false,
    };
  }
  if (facts?.bank_details === "asked") {
    return {
      label: "Bank asked",
      tone: "pending",
      icon: <Landmark className={ICON} aria-hidden="true" />,
      title: `Demandé par ${who(facts.bank_asked_by)} le ${shortDate(facts.bank_asked_at)}`,
      isUnknown: false,
    };
  }
  return {
    label: "Card 🚦 pending",
    tone: "pending",
    icon: <CreditCard className={ICON} aria-hidden="true" />,
    title:
      facts?.card_payment === "refused"
        ? `Refuse la carte${
            facts.card_decided_at ? ` (indiqué le ${shortDate(facts.card_decided_at)})` : ""
          } — coordonnées bancaires pas encore demandées`
        : "Aucune acceptation de carte connue, ni coordonnées bancaires en main",
    isUnknown: true,
  };
}

function PaymentMethodSticker({
  facts,
  cardReady,
  cardSource,
  hideWhenUnknown,
}: {
  facts: PartnerFacts | undefined;
  /** True when the partner is payable by card, from Slack approval or an explicit email reply. */
  cardReady: boolean;
  /** Where the card verdict came from, for the hover text. */
  cardSource?: "slack" | "email";
  /** Skip rendering entirely for the "nothing known yet" fallback state. */
  hideWhenUnknown?: boolean;
}) {
  const v = paymentMethodVerdict(facts, cardReady, cardSource);
  if (v.isUnknown && hideWhenUnknown) return null;
  return <Sticker icon={v.icon} label={v.label} tone={v.tone} title={v.title} />;
}

// --- Composites -------------------------------------------------------------

export type StickerPartner = {
  name: string | null;
  owner_code?: string | null;
  email: string | null;
  amount_due: number | null;
  vat_raw: string | null;
  tax_identifier: string | null;
  country: string | null;
  is_cancelled?: boolean | null;
  /** Card acceptance already known from the source data (e.g. payment_method), passed through to actionFor. */
  cardOnThisEvent?: "accepted" | "refused";
};

/** One partner, inside the event drawer. */
export function PartnerStickers({
  action,
  facts,
  partner,
  cardApprovedInSlack,
  hideTax,
  hideCardPending,
}: {
  action: PartnerAction;
  facts: PartnerFacts | undefined;
  partner: StickerPartner;
  cardApprovedInSlack?: boolean;
  /** Skip the tax-registration sticker — for trackers that don't record tax numbers at all. */
  hideTax?: boolean;
  /** Skip the payment sticker when no payment method is known yet, rather than showing a "pending" placeholder. */
  hideCardPending?: boolean;
}) {
  const cardReady =
    cardApprovedInSlack === true ||
    facts?.card_payment === "accepted" ||
    action.payableBy === "card";

  // Nothing left to do: the contact and bank stickers are noise at that point.
  // Only the two facts worth keeping visible remain — the tax registration and
  // whether this partner is paid by card.
  const settled = action.code === "settled";

  return (
    <span className="mt-1 flex flex-wrap gap-1">
      <ActionSticker action={action} />
      {!hideTax && (
        <TaxSticker
          registration={action.tax}
          country={partner.country}
          emailReceivedAt={facts?.tax_received_at}
          emailAskedAt={facts?.tax_asked_at}
          emailAskedBy={facts?.tax_asked_by}
        />
      )}
      {!settled &&
        (facts ? (
          <ContactSticker facts={facts} />
        ) : (
          <Sticker
            label="Emails non scannés"
            tone="none"
            title="Personne n'a encore lancé de recherche email pour ce partenaire"
          />
        ))}
      <PaymentMethodSticker
        facts={facts}
        cardReady={cardReady}
        cardSource={cardApprovedInSlack ? "slack" : "email"}
        hideWhenUnknown={hideCardPending}
      />
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
  cardApprovedCodes,
  hideTax,
  hideCardPending,
}: {
  eventRef: string;
  partners: StickerPartner[];
  hasPo: boolean;
  factsMap: Map<string, PartnerFacts> | undefined;
  actionFor: (eventRef: string, partner: StickerPartner, hasPo: boolean) => PartnerAction;
  /** Owner codes with an approved card in #finance-paiement-by-card. */
  cardApprovedCodes?: Set<string>;
  /** Skip the tax-registration sticker — for trackers that don't record tax numbers at all. */
  hideTax?: boolean;
  /** Skip the payment sticker when no payment method is known yet, rather than showing a "pending" placeholder. */
  hideCardPending?: boolean;
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
    const score = (x: typeof e) => (taxComplete(x.registration, x.partner.country) ? 1 : 0);
    return score(e) < score(worst) ? e : worst;
  });

  const leadCardReady =
    (lead.partner.owner_code != null &&
      cardApprovedCodes?.has(lead.partner.owner_code) === true) ||
    lead.facts?.card_payment === "accepted";
  const leadCardSource =
    lead.partner.owner_code != null && cardApprovedCodes?.has(lead.partner.owner_code)
      ? "slack"
      : "email";

  return (
    <span className="mt-1 flex flex-wrap gap-1">
      <ActionSticker action={lead.action} />
      {!hideTax && (
        <TaxSticker
          registration={taxLead.registration}
          country={taxLead.partner.country}
          emailReceivedAt={taxLead.facts?.tax_received_at}
          emailAskedAt={taxLead.facts?.tax_asked_at}
          emailAskedBy={taxLead.facts?.tax_asked_by}
        />
      )}
      {lead.action.code !== "settled" &&
        (lead.facts ? (
          <ContactSticker facts={lead.facts} />
        ) : (
          <Sticker
            label="Emails non scannés"
            tone="none"
            title="Lancez « Rechercher dans mes emails » pour compléter le contact, le bancaire et la carte"
          />
        ))}
      <PaymentMethodSticker
        facts={lead.facts}
        cardReady={leadCardReady}
        cardSource={leadCardSource}
        hideWhenUnknown={hideCardPending}
      />
    </span>
  );
}
