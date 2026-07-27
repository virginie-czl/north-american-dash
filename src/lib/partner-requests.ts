/**
 * Builds the "please send us X" emails from what the tracker knows is missing.
 *
 * Pure and testable: no Gmail, no network. Two rules matter here.
 *
 * 1. Requests are grouped by email address, not by event. The same provider turns
 *    up on several bookings (Casino de Montréal appears three times), and sending
 *    them three near-identical emails is how a chase becomes spam.
 * 2. What is asked follows the action engine, so a provider who already accepted a
 *    card is never asked for an IBAN, and a partner whose numbers are on file is
 *    never asked for them again.
 */
import type { PartnerAction } from "./partner-actions";
import { taxComplete } from "./partner-actions";

export type Needs = {
  bank: boolean;
  tax: boolean;
  /** Known to accept card previously — propose that instead of asking for an IBAN. */
  card: boolean;
};

export type RequestTarget = {
  address: string;
  partnerName: string;
  country: string | null;
  /** Every booking this provider is involved in, for the email body. */
  events: string[];
  /** Outstanding per currency, summed across those bookings. */
  amounts: Record<string, number>;
  needs: Needs;
};

export type PartnerInput = {
  eventRef: string;
  name: string | null;
  email: string | null;
  country: string | null;
  currency: string | null;
  amountDue: number | null;
  action: PartnerAction;
  isCancelled?: boolean | null;
};

/** What is still missing for this partner, or null when nothing is. */
export function needsOf(action: PartnerAction, country: string | null): Needs | null {
  const tax = !taxComplete(action.tax, country);
  const bank = action.code === "ask_bank" || action.code === "ask_bank_and_tax";
  const card = action.code === "ask_card";
  if (!tax && !bank && !card) return null;
  return { bank, tax, card };
}

/** Groups partners into one request per email address. */
export function buildTargets(partners: PartnerInput[]): RequestTarget[] {
  const byAddress = new Map<string, RequestTarget>();

  for (const p of partners) {
    if (p.isCancelled) continue;
    const address = (p.email ?? "").trim().toLowerCase();
    if (!address.includes("@")) continue;
    const needs = needsOf(p.action, p.country);
    if (!needs) continue;

    const existing = byAddress.get(address);
    const owed = Math.max(p.amountDue ?? 0, 0);
    const ccy = p.currency ?? "";

    if (!existing) {
      byAddress.set(address, {
        address,
        partnerName: p.name ?? address,
        country: p.country,
        events: [p.eventRef],
        amounts: owed > 0.01 && ccy ? { [ccy]: owed } : {},
        needs,
      });
      continue;
    }
    if (!existing.events.includes(p.eventRef)) existing.events.push(p.eventRef);
    if (owed > 0.01 && ccy) existing.amounts[ccy] = (existing.amounts[ccy] ?? 0) + owed;
    existing.needs = {
      bank: existing.needs.bank || needs.bank,
      tax: existing.needs.tax || needs.tax,
      card: existing.needs.card || needs.card,
    };
    if (!existing.country && p.country) existing.country = p.country;
  }

  return [...byAddress.values()].sort((a, b) => a.partnerName.localeCompare(b.partnerName));
}

const FRENCH_SPEAKING = new Set(["CA", "FR", "BE", "LU", "CH", "MC", "MA", "TN", "SN"]);

function writesFrench(country: string | null): boolean {
  // Quebec-heavy vendor base; default to French unless clearly elsewhere.
  return country == null || FRENCH_SPEAKING.has(country.toUpperCase());
}

function fmtAmounts(amounts: Record<string, number>): string {
  const parts = Object.entries(amounts)
    .filter(([, v]) => v > 0.01)
    .map(([ccy, v]) => `${v.toLocaleString("fr-CA", { minimumFractionDigits: 2 })} ${ccy}`);
  return parts.join(" · ");
}

export type Composed = { subject: string; body: string };

/** The email itself, in the provider's likely language, asking only for gaps. */
export function composeRequest(target: RequestTarget, senderName: string | null): Composed {
  const fr = writesFrench(target.country);
  const refs = target.events.join(", ");
  const amount = fmtAmounts(target.amounts);
  const isCanadian = (target.country ?? "").toUpperCase() === "CA";
  const signature = senderName ? `${senderName}\nNaboo — Finance` : "Naboo — Finance";

  const asks: string[] = [];
  if (fr) {
    if (target.needs.card) {
      asks.push(
        "confirmer que nous pouvons procéder au règlement par carte de crédit, comme lors de nos précédentes collaborations",
      );
    } else if (target.needs.bank) {
      asks.push(
        "vos coordonnées bancaires complètes (IBAN, ou numéros de transit, institution et compte au Canada)",
      );
    }
    if (target.needs.tax) {
      asks.push(
        isCanadian
          ? "vos numéros de taxes : TPS/GST et TVQ/QST"
          : "votre numéro de TVA (ou identifiant fiscal équivalent)",
      );
    }
  } else {
    if (target.needs.card) {
      asks.push("confirmation that we may settle by credit card, as we have previously");
    } else if (target.needs.bank) {
      asks.push("your full bank details (IBAN, or transit, institution and account numbers)");
    }
    if (target.needs.tax) {
      asks.push("your VAT or tax registration number");
    }
  }

  const list = asks.map((a) => `— ${a}`).join("\n");

  if (fr) {
    const subject =
      target.events.length > 1
        ? `Naboo — informations manquantes pour le règlement (${refs})`
        : `Naboo — ${refs} : informations manquantes pour le règlement`;
    const body = [
      "Bonjour,",
      "",
      target.events.length > 1
        ? `Nous préparons le règlement de vos prestations pour les événements suivants : ${refs}.`
        : `Nous préparons le règlement de votre prestation pour l'événement ${refs}.`,
      amount ? `Montant restant à régler : ${amount}.` : "",
      "",
      asks.length > 1
        ? "Afin de pouvoir procéder, il nous manque les éléments suivants :"
        : "Afin de pouvoir procéder, il nous manque l'élément suivant :",
      list,
      "",
      "Merci de nous les transmettre en réponse à ce message ; le paiement sera lancé dès réception.",
      "",
      "Bien cordialement,",
      signature,
    ]
      .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
      .join("\n");
    return { subject, body };
  }

  const subject =
    target.events.length > 1
      ? `Naboo — missing details for payment (${refs})`
      : `Naboo — ${refs}: missing details for payment`;
  const body = [
    "Hello,",
    "",
    target.events.length > 1
      ? `We are preparing payment for your services on the following events: ${refs}.`
      : `We are preparing payment for your services on event ${refs}.`,
    amount ? `Outstanding amount: ${amount}.` : "",
    "",
    asks.length > 1
      ? "Before we can proceed, we are still missing:"
      : "Before we can proceed, we are still missing:",
    list,
    "",
    "Could you send these in reply to this message? Payment will be released on receipt.",
    "",
    "Kind regards,",
    signature,
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");
  return { subject, body };
}

/** Short human summary of what a target will be asked for. */
export function describeNeeds(needs: Needs): string {
  const bits: string[] = [];
  if (needs.card) bits.push("confirmation carte");
  else if (needs.bank) bits.push("coordonnées bancaires");
  if (needs.tax) bits.push("numéros de taxes");
  return bits.join(" + ") || "—";
}
