/**
 * Joins the three sources of truth for a partner — the warehouse (amounts, tax
 * registration), the email scan (what was asked and answered) and cross-event
 * memory (has this partner ever taken a card?) — into a single verdict.
 */
import { useCallback, useMemo } from "react";
import { decidePartnerAction, type PartnerAction } from "@/lib/partner-actions";
import { partnerKey } from "@/lib/annotations.functions";
import { usePartnerFacts, type PartnerFacts } from "@/lib/use-gmail";

export type ActionablePartner = {
  name: string | null;
  email: string | null;
  amount_due: number | null;
  vat_raw: string | null;
  tax_identifier: string | null;
  country: string | null;
  is_cancelled?: boolean | null;
};

export function useActionIndex() {
  const { data: factsMap } = usePartnerFacts();

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
      });
    },
    [factsMap, cardEverAccepted],
  );

  /** True when at least one partner on the event still has an open question. */
  const eventNeedsScan = useCallback(
    (eventRef: string, partners: ActionablePartner[], hasPo: boolean): boolean =>
      partners.some((p) => !p.is_cancelled && actionFor(eventRef, p, hasPo).scanUseful),
    [actionFor],
  );

  return { factsMap, actionFor, eventNeedsScan, cardEverAccepted };
}
