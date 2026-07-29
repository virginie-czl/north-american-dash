/**
 * Joins the three sources of truth for a partner — the warehouse (amounts, tax
 * registration), the email scan (what was asked and answered) and cross-event
 * memory (has this partner ever taken a card?) — into a single verdict.
 */
import { useCallback, useMemo } from "react";
import { decidePartnerAction, taxComplete, type PartnerAction } from "@/lib/partner-actions";
import { partnerKey } from "@/lib/annotations.functions";
import { useQuery } from "@tanstack/react-query";
import { usePartnerFacts, type PartnerFacts } from "@/lib/use-gmail";
import { fetchCardApprovals } from "@/lib/slack-cards.functions";

export type ActionablePartner = {
  name: string | null;
  email: string | null;
  amount_due: number | null;
  owner_code?: string | null;
  vat_raw: string | null;
  tax_identifier: string | null;
  country: string | null;
  is_cancelled?: boolean | null;
};

export function useActionIndex() {
  const { data: factsMap, error: factsError } = usePartnerFacts();

  // Approved cards from #finance-paiement-by-card. Matched on the O- owner code, so
  // exact. A failure here must not break the page — the email signal still works.
  const { data: cardApprovedCodes } = useQuery({
    queryKey: ["slack-card-approvals"],
    queryFn: async () => {
      const rows = await fetchCardApprovals();
      const set = new Set<string>();
      (Array.isArray(rows) ? rows : []).forEach((r) => set.add(r.owner_code.toUpperCase()));
      return set;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  // A partner who accepted a card once will accept it again — that memory has to
  // span events, otherwise we keep asking for an IBAN we do not need.
  const cardEverAccepted = useMemo(() => {
    const set = new Set<string>();
    factsMap?.forEach((f) => {
      if (f.card_payment === "accepted") set.add(f.partner_key);
    });
    return set;
  }, [factsMap]);

  const actionFor = useCallback(
    (eventRef: string, partner: ActionablePartner, hasPo: boolean): PartnerAction => {
      const key = partnerKey(partner.name ?? partner.email ?? "");
      const facts: PartnerFacts | undefined = factsMap?.get(`${eventRef}::${key}`);
      return decidePartnerAction({
        outstanding: Math.max(partner.amount_due ?? 0, 0),
        hasPo,
        country: partner.country,
        taxRaw: partner.vat_raw,
        taxIdentifier: partner.tax_identifier,
        bankDetails: facts?.bank_details ?? "not_asked",
        taxAsked: facts?.tax_info === "asked" || facts?.tax_info === "received",
        contacted: facts?.contacted_at != null,
        replied: facts?.replied_at != null,
        cardOnThisEvent: facts?.card_payment ?? "unknown",
        cardEverAccepted: cardEverAccepted.has(key),
        cardApprovedInSlack:
          partner.owner_code != null &&
          cardApprovedCodes?.has(partner.owner_code.toUpperCase()) === true,
      });
    },
    [factsMap, cardEverAccepted, cardApprovedCodes],
  );

  /** True when at least one partner on the event still has an open question. */
  const eventNeedsScan = useCallback(
    (eventRef: string, partners: ActionablePartner[], hasPo: boolean): boolean =>
      partners.some((p) => !p.is_cancelled && actionFor(eventRef, p, hasPo).scanUseful),
    [actionFor],
  );

  return { factsMap, factsError, actionFor, eventNeedsScan, cardEverAccepted, cardApprovedCodes };
}

// --- Tag derivation (for filtering) ------------------------------------------

/**
 * The tag keys a partner currently carries, matching what the stickers display.
 * Kept here rather than in the component so the table can filter on the same
 * truth the user sees — a filter that disagrees with the badges is worse than none.
 */
export type TagKey =
  | `action:${string}`
  | "tax:on_file"
  | "tax:to_record"
  | "tax:asked"
  | "tax:absent"
  | "bank:received"
  | "bank:asked"
  | "bank:absent"
  | "card:ok"
  | "card:refused"
  | "card:unknown"
  | "contact:replied"
  | "contact:no_reply"
  | "contact:never"
  | "contact:unscanned";

export function tagsForPartner(
  action: PartnerAction,
  facts: PartnerFacts | undefined,
  country: string | null,
  cardApprovedInSlack: boolean,
): Set<TagKey> {
  const tags = new Set<TagKey>();
  tags.add(`action:${action.code}` as TagKey);

  // Tax mirrors TaxSticker
  if (taxComplete(action.tax, country)) tags.add("tax:on_file");
  else if (facts?.tax_received_at) tags.add("tax:to_record");
  else if (facts?.tax_asked_at) tags.add("tax:asked");
  else tags.add("tax:absent");

  const cardReady = cardApprovedInSlack || facts?.card_payment === "accepted";
  if (cardReady) tags.add("card:ok");
  else if (facts?.card_payment === "refused") tags.add("card:refused");
  else tags.add("card:unknown");

  // Bank is only a gap when the partner is not payable by card
  if (facts?.bank_details === "received") tags.add("bank:received");
  else if (!cardReady) {
    if (facts?.bank_details === "asked") tags.add("bank:asked");
    else tags.add("bank:absent");
  }

  if (!facts) tags.add("contact:unscanned");
  else if (facts.replied_at) tags.add("contact:replied");
  else if (facts.contacted_at) tags.add("contact:no_reply");
  else tags.add("contact:never");

  return tags;
}

/** Every tag present across an event's live partners. */
export function tagsForEvent(
  eventRef: string,
  partners: ActionablePartner[],
  hasPo: boolean,
  actionFor: (ref: string, p: ActionablePartner, hasPo: boolean) => PartnerAction,
  factsMap: Map<string, PartnerFacts> | undefined,
  cardApprovedCodes: Set<string> | undefined,
): Set<TagKey> {
  const all = new Set<TagKey>();
  for (const p of partners) {
    if (p.is_cancelled) continue;
    const key = partnerKey(p.name ?? p.email ?? "");
    const approved =
      p.owner_code != null && cardApprovedCodes?.has(p.owner_code.toUpperCase()) === true;
    tagsForPartner(
      actionFor(eventRef, p, hasPo),
      factsMap?.get(`${eventRef}::${key}`),
      p.country,
      approved,
    ).forEach((t) => all.add(t));
  }
  return all;
}

/** Filter options, grouped for the dropdown. */
export const TAG_FILTER_GROUPS: Array<{ label: string; options: Array<{ value: TagKey; label: string }> }> = [
  {
    label: "Action",
    options: [
      { value: "action:ask_bank_and_tax", label: "Demander bancaire + taxes" },
      { value: "action:ask_bank", label: "Demander le bancaire" },
      { value: "action:ask_tax", label: "Demander les taxes" },
      { value: "action:ask_card", label: "Proposer la carte" },
      { value: "action:await_reply", label: "En attente de réponse" },
      { value: "action:card_to_debit", label: "Card created, service provider to debit" },
      { value: "action:ours_record_tax", label: "Enregistrer les taxes" },
      { value: "action:ours_pay", label: "Payout TBD" },
      { value: "action:blocked_no_po", label: "Bloqué — pas de PO" },
      { value: "action:settled", label: "Rien à faire" },
    ],
  },
  {
    label: "Taxes",
    options: [
      { value: "tax:absent", label: "Taxes absent" },
      { value: "tax:asked", label: "Taxes demandé" },
      { value: "tax:to_record", label: "Taxes à saisir" },
      { value: "tax:on_file", label: "Taxes en base" },
    ],
  },
  {
    label: "Bancaire",
    options: [
      { value: "bank:absent", label: "Bancaire absent" },
      { value: "bank:asked", label: "Bancaire demandé" },
      { value: "bank:received", label: "Bancaire reçu" },
    ],
  },
  {
    label: "Carte",
    options: [
      { value: "card:ok", label: "Carte OK" },
      { value: "card:refused", label: "Carte refusée" },
      { value: "card:unknown", label: "Carte inconnue" },
    ],
  },
  {
    label: "Contact",
    options: [
      { value: "contact:never", label: "Jamais contacté" },
      { value: "contact:no_reply", label: "Sans réponse" },
      { value: "contact:replied", label: "A répondu" },
      { value: "contact:unscanned", label: "Emails non scannés" },
    ],
  },
];
