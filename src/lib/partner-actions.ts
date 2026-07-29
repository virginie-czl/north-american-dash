/**
 * Decides, for one partner line, what actually needs doing — and therefore
 * whether searching the mailbox would tell us anything new.
 *
 * The point is to avoid scanning events where the ball is in our court. If a
 * partner is fully paid and registered, or has already sent everything and only
 * the payment remains, no email search can change that; the action is ours.
 *
 * Pure and dependency-free so the rules can be tested directly.
 */

export type TaxRegistration = {
  /** Canadian GST / business number, e.g. 123456789RT0001. */
  gst: string | null;
  /** Quebec sales tax, e.g. 1234567890TQ0001. */
  qst: string | null;
  /** EU-style VAT identifier. */
  vat: string | null;
  /** Something is recorded but no known format could be read out of it. */
  unparsed: string | null;
  /** True when at least one identifier was recognised. */
  usable: boolean;
};

const GST_RE = /(\d{8,9})\W{0,3}RT\W{0,3}(\d{4,5})/i;
const QST_RE = /(\d{10})\W{0,3}TQ\W{0,3}(\d{4})/i;
/**
 * EU VAT, matched after separators are stripped. Some countries insert letters
 * (Spanish `ESB97894372`, Dutch `NL123456789B01`), so the body is alphanumeric.
 */
const EU_VAT_RE = /\b(FR|BE|DE|ES|IT|NL|LU|IE|PT|AT|PL|GB|DK|SE|FI|CZ|RO|HU|GR|EL)([0-9A-Z]{8,13})\b/;

/**
 * Values people type to get past a required field. These mean "not filled in",
 * not "invalid": flagging 300 partners as unreadable because someone typed "//"
 * would bury the handful of records that genuinely need correcting.
 */
const PLACEHOLDERS = new Set([
  "0", "00", "000", "x", "xx", "xxx", "n", "na", "nan", "none", "no", "nil",
  "neant", "aucun", "tbc", "tbd", "sansobjet", "notapplicable",
]);

function isPlaceholder(text: string): boolean {
  // Strip accents first, so "néant" reduces to "neant".
  const squashed = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
  if (squashed === "" || PLACEHOLDERS.has(squashed)) return true;
  return /^[^a-z0-9]*$/i.test(text);
}

/**
 * `owners.vat_number` is free text — it holds anything from a clean
 * `121107726RT0001` to `TPS/GST : 819512187RT0001 - TVQ/PST : 1222113845TQ0001`
 * to `7886 41132`, plus plenty of empty strings. Read out what we can.
 */
export function parseTaxRegistration(...sources: Array<string | null | undefined>): TaxRegistration {
  const text = sources.filter(Boolean).join(" ").trim();
  if (!text || isPlaceholder(text)) {
    return { gst: null, qst: null, vat: null, unparsed: null, usable: false };
  }

  // Match against a separator-free copy so "FR32 904 443 462" and "FR32904443462"
  // are the same number, while keeping the original text for display.
  const squashed = text.toUpperCase().replace(/[\s.\-_/]/g, "");

  const gstMatch = squashed.match(GST_RE) ?? text.match(GST_RE);
  const qstMatch = squashed.match(QST_RE) ?? text.match(QST_RE);
  const vatMatch = squashed.match(EU_VAT_RE);

  const gst = gstMatch ? `${gstMatch[1]}RT${gstMatch[2]}` : null;
  const qst = qstMatch ? `${qstMatch[1]}TQ${qstMatch[2]}` : null;
  const vat = vatMatch ? `${vatMatch[1]}${vatMatch[2]}` : null;
  const recognised = Boolean(gst || qst || vat);

  // A registration counts as on file when the field holds real digits, whether or
  // not the format is one we recognise: the operational question is "must we chase
  // this partner?", not "does this validate?". Strings of zeros are excluded —
  // "0000" is the same gesture as "//", someone clearing a required field.
  const usable = recognised || /[1-9]/.test(text);

  // `unparsed` means "we hold something we could not parse" — it only applies
  // when the value counts as present at all, so zeros and placeholders stay null.
  return { gst, qst, vat, unparsed: usable && !recognised ? text : null, usable };
}

/**
 * Whether we hold a tax registration for this partner.
 *
 * Presence is the test, not validity: if the field holds real digits we stop
 * asking. Whether a Canadian partner has both GST and QST still matters for
 * invoicing, so `missingQstForCanada` surfaces it as information — but it no
 * longer triggers a chase.
 */
export function taxComplete(reg: TaxRegistration, _country: string | null): boolean {
  return reg.usable;
}

/** Informational: a Canadian partner with a GST but no QST. */
export function missingQstForCanada(reg: TaxRegistration, country: string | null): boolean {
  if ((country ?? "").toUpperCase() !== "CA") return false;
  return Boolean(reg.gst) && !reg.qst;
}

export type PaymentReadiness = "card" | "bank" | "none";

export type ActionCode =
  | "settled" // paid and registered — nothing to do
  | "ours_pay" // we have what we need; paying is our move
  | "ours_record_tax" // partner sent everything; recording the tax number is our move
  | "ask_card" // known to accept card previously — offer it before asking for bank details
  | "ask_bank" // need bank details
  | "ask_tax" // need tax identifiers
  | "ask_bank_and_tax"
  | "await_reply" // asked already, waiting
  | "blocked_no_po"; // nothing can be asked until the PO exists

export type PartnerSituation = {
  outstanding: number;
  hasPo: boolean;
  country: string | null;
  taxRaw: string | null;
  taxIdentifier: string | null;
  /** From the email scan, on this event. */
  bankDetails: "not_asked" | "asked" | "received";
  taxAsked: boolean;
  contacted: boolean;
  replied: boolean;
  cardOnThisEvent: "unknown" | "accepted" | "refused";
  /** From the email scan on ANY event — a partner who took card once will again. */
  cardEverAccepted: boolean;
  /**
   * A credit card was actually approved for this partner in
   * #finance-paiement-by-card. Strongest evidence there is: a Pliant card was
   * issued, not merely discussed.
   */
  cardApprovedInSlack?: boolean;
};

export type PartnerAction = {
  code: ActionCode;
  /** Who has to move next. */
  owner: "us" | "partner" | "nobody";
  /** Whether searching the mailbox could still change this verdict. */
  scanUseful: boolean;
  label: string;
  detail: string;
  tax: TaxRegistration;
};

/**
 * The decision tree. Order matters: card acceptance is checked before bank
 * details are demanded, because a partner who takes card never needs to send
 * an IBAN at all.
 */
export function decidePartnerAction(s: PartnerSituation): PartnerAction {
  const tax = parseTaxRegistration(s.taxRaw, s.taxIdentifier);
  const taxOk = taxComplete(tax, s.country);
  const owes = s.outstanding > 0.01;
  const base = { tax };

  // Money settled and registration on file: closed.
  if (!owes && taxOk) {
    return {
      ...base,
      code: "settled",
      owner: "nobody",
      scanUseful: false,
      label: "Rien à faire",
      detail: "Payé et numéros de taxes enregistrés.",
    };
  }

  // Settled but registration missing — that is a data-entry job on our side,
  // unless we have never actually asked them for it.
  if (!owes && !taxOk) {
    if (s.taxAsked || tax.unparsed) {
      return {
        ...base,
        code: "ours_record_tax",
        owner: "us",
        scanUseful: false,
        label: "Enregistrer les taxes",
        detail: tax.unparsed
          ? `Numéro présent mais illisible : « ${tax.unparsed} » — à corriger en base.`
          : "Déjà demandé au partenaire ; il reste à saisir le numéro.",
      };
    }
    return {
      ...base,
      code: "ask_tax",
      owner: "partner",
      scanUseful: true,
      label: "Demander les taxes",
      detail: "Payé, mais aucun numéro de taxes et aucune demande retrouvée.",
    };
  }

  // Something is owed. Can we pay at all?
  const cardReady =
    s.cardApprovedInSlack === true || s.cardOnThisEvent === "accepted" || s.cardEverAccepted;
  const readiness: PaymentReadiness = cardReady
    ? "card"
    : s.bankDetails === "received"
      ? "bank"
      : "none";

  if (readiness !== "none") {
    if (!taxOk && !s.taxAsked) {
      return {
        ...base,
        code: "ask_tax",
        owner: "partner",
        scanUseful: true,
        label: "Demander les taxes",
        detail:
          readiness === "card"
            ? "Payable par carte ; il manque seulement les numéros de taxes."
            : "Coordonnées bancaires reçues ; il manque les numéros de taxes.",
      };
    }
    return {
      ...base,
      code: "ours_pay",
      owner: "us",
      scanUseful: false,
      label: readiness === "card" ? "À payer (carte)" : "À payer (virement)",
      detail:
        readiness === "card"
          ? s.cardApprovedInSlack === true
            ? "Carte approuvée dans #finance-paiement-by-card — pas besoin de coordonnées bancaires."
            : "Le partenaire a explicitement accepté la carte — pas besoin de coordonnées bancaires."
          : "Coordonnées bancaires en main ; le paiement est de notre côté.",
    };
  }

  // We cannot pay yet. Without a PO nothing can be asked.
  if (!s.hasPo) {
    return {
      ...base,
      code: "blocked_no_po",
      owner: "us",
      scanUseful: false,
      label: "Bloqué — pas de PO",
      detail: "Rien à demander au partenaire avant réception du bon de commande.",
    };
  }

  // Card refused and bank details already requested: waiting on them.
  const needTax = !taxOk;
  if (s.bankDetails === "asked" && (!needTax || s.taxAsked)) {
    if (s.replied) {
      return {
        ...base,
        code: "await_reply",
        owner: "us",
        scanUseful: true,
        label: "Réponse à traiter",
        detail: "Le partenaire a répondu — vérifier ce qu'il a envoyé.",
      };
    }
    return {
      ...base,
      code: "await_reply",
      owner: "partner",
      scanUseful: true,
      label: "En attente de réponse",
      detail: "Demande envoyée, pas encore de réponse.",
    };
  }

  // Nothing asked yet. If they have taken card before, offer that first.
  if (s.cardApprovedInSlack === true || s.cardEverAccepted) {
    return {
      ...base,
      code: "ask_card",
      owner: "partner",
      scanUseful: true,
      label: "Proposer la carte",
      detail:
        s.cardApprovedInSlack === true
          ? "Une carte a déjà été approuvée pour ce prestataire — inutile de demander un IBAN."
          : "A déjà accepté la carte par le passé — inutile de demander un IBAN.",
    };
  }

  if (needTax) {
    return {
      ...base,
      code: "ask_bank_and_tax",
      owner: "partner",
      scanUseful: true,
      label: "Demander bancaire + taxes",
      detail: s.contacted
        ? "Contact établi, mais ni coordonnées bancaires ni numéros de taxes."
        : "Jamais contacté pour le paiement.",
    };
  }

  return {
    ...base,
    code: "ask_bank",
    owner: "partner",
    scanUseful: true,
    label: "Demander le bancaire",
    detail: s.contacted
      ? "Contact établi, coordonnées bancaires toujours manquantes."
      : "Jamais contacté pour le paiement.",
  };
}
