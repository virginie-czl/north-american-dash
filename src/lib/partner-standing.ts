/**
 * What a partner line's status actually is, from all three things that know something
 * about it — pure, so the pill, the row tag and the KPI cannot end up disagreeing.
 *
 * Three sources, and they answer different questions:
 *
 *  - **The money.** Paid or part-paid is a fact from the ledger and outranks everything:
 *    nobody is waiting on bank details for a partner who has already been paid.
 *  - **The email scan.** `bank_details = "received"` is a dated observation — an inbound
 *    message carrying an IBAN, Canadian transit coordinates or a bank attachment.
 *  - **The dropdown.** A note somebody left about what they had done, at the time they
 *    left it. It is the weakest of the three, because it is the only one that cannot
 *    notice that the world moved on.
 *
 * The bug this exists for: the L'Oréal tracker read `derived ?? stored`, so a partner
 * whose bank details had arrived and been scanned still showed "Waiting bank details"
 * until a human went back and changed the dropdown by hand — on F-B645 among others. The
 * scan was already loaded on that screen and passed to the stickers beside the pill; the
 * pill just never asked it.
 *
 * A received-details status is deliberately derived-only and not settable by hand: it
 * asserts that a document arrived, which is the scan's business to know, and a dropdown
 * that could claim it would be a way to record something nobody has seen.
 */
import type { PartnerStatusValue } from "./annotations.functions";

/** The four stored values, plus the one only evidence can produce. */
export type PartnerStanding = PartnerStatusValue | "bank_received";

export type StandingSource = "money" | "scan" | "manual" | "default";

export type PartnerStandingResult = {
  status: PartnerStanding;
  source: StandingSource;
  /** ISO timestamp behind a scanned standing, for the tooltip. */
  at: string | null;
};

export type StandingInput = {
  /** Positive: what the partner is owed on this line. */
  due: number | null | undefined;
  /** Signed either way in the source; magnitude is what counts. */
  paid: number | null | undefined;
  /** From partner_email_facts, when the scan has run for this partner. */
  facts?: {
    bank_details?: string | null;
    bank_received_at?: string | null;
    contacted_at?: string | null;
  } | null;
  /** From the dropdown, when somebody has set one. */
  stored?: PartnerStatusValue | null;
};

export function partnerStanding(input: StandingInput): PartnerStandingResult {
  const due = Math.max(input.due ?? 0, 0);
  const paid = Math.abs(input.paid ?? 0);

  // The ledger first. Nothing about outreach can be true over a payment that happened.
  if (due <= 0.01) return { status: "fully_paid", source: "money", at: null };
  if (paid + 0.01 >= due) return { status: "fully_paid", source: "money", at: null };
  if (paid > 0.01) return { status: "partially_paid", source: "money", at: null };

  // Then the scan: the details came back, so this line is a payout, not a chase.
  if (input.facts?.bank_details === "received") {
    return { status: "bank_received", source: "scan", at: input.facts.bank_received_at ?? null };
  }

  if (input.stored && input.stored !== "not_contacted") {
    return { status: input.stored, source: "manual", at: null };
  }
  // An email demonstrably went out, whatever the dropdown says.
  if (input.facts?.contacted_at) {
    return { status: "waiting_bank", source: "scan", at: input.facts.contacted_at };
  }
  return { status: input.stored ?? "not_contacted", source: "default", at: null };
}

/** Is this line still waiting on the partner for their details? */
export function isWaitingOnDetails(standing: PartnerStanding): boolean {
  return standing === "waiting_bank";
}

/** Do we hold what we need to pay this line? */
export function isPayable(standing: PartnerStanding): boolean {
  return standing === "bank_received" || standing === "partially_paid";
}

/** Where the pill's value came from, said in a sentence for its tooltip. */
export function standingNote(result: PartnerStandingResult): string {
  const day = result.at ? result.at.slice(0, 10) : null;
  switch (result.source) {
    case "money":
      return "From the amounts on the booking.";
    case "scan":
      return result.status === "bank_received"
        ? `Bank details found in the email scan${day ? ` on ${day}` : ""} — this line is payable.`
        : `An email went out${day ? ` on ${day}` : ""}, found by the scan.`;
    case "manual":
      return "Set by hand on this screen.";
    default:
      return "Nobody has contacted this partner and the scan found nothing.";
  }
}
