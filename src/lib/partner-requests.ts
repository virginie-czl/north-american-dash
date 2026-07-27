/**
 * Builds information-request emails from the templates Shayma defined.
 *
 * One email per booking × partner combination — not grouped across bookings.
 * The caller's Gmail signature is injected by Gmail itself (insertSignature flag),
 * so it does not appear in the composed body.
 */
import type { PartnerAction } from "./partner-actions";
import { taxComplete } from "./partner-actions";

export type Needs = {
  bank: boolean;
  tax: boolean;
};

export type RequestTarget = {
  address: string;
  partnerName: string;
  country: string | null;
  eventRef: string;
  eventDate: string | null;
  currency: string | null;
  amountDue: number | null;
  needs: Needs;
};

export type PartnerInput = {
  eventRef: string;
  eventDate: string | null;
  name: string | null;
  email: string | null;
  country: string | null;
  currency: string | null;
  amountDue: number | null;
  action: PartnerAction;
  isCancelled?: boolean | null;
};

/** What this partner still needs, or null when nothing is missing. */
export function needsOf(action: PartnerAction, country: string | null): Needs | null {
  const taxMissing = !taxComplete(action.tax, country);
  const bankMissing =
    action.code === "ask_bank" ||
    action.code === "ask_bank_and_tax" ||
    action.code === "ask_card"; // card-first: still might need bank if they decline
  if (!taxMissing && !bankMissing) return null;
  return { bank: bankMissing, tax: taxMissing };
}

/** One request per partner × booking (not grouped). */
export function buildTargets(partners: PartnerInput[]): RequestTarget[] {
  return partners
    .filter((p) => {
      if (p.isCancelled) return false;
      const address = (p.email ?? "").trim().toLowerCase();
      if (!address.includes("@")) return false;
      return needsOf(p.action, p.country) != null;
    })
    .map((p) => ({
      address: (p.email ?? "").trim().toLowerCase(),
      partnerName: p.name ?? p.email ?? "",
      country: p.country,
      eventRef: p.eventRef,
      eventDate: p.eventDate,
      currency: p.currency,
      amountDue: p.amountDue,
      needs: needsOf(p.action, p.country)!,
    }));
}

function fmtEventDate(date: string | null): string {
  if (!date) return "";
  try {
    return new Date(date).toLocaleDateString("en-CA", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return date;
  }
}

export type Composed = { subject: string; body: string };

export function composeRequest(target: RequestTarget): Composed {
  const ref = target.eventRef;
  const date = fmtEventDate(target.eventDate);
  const dateStr = date ? ` – ${date}` : "";

  const { bank, tax } = target.needs;

  // ── Bank only ──────────────────────────────────────────────────────────────
  if (bank && !tax) {
    return {
      subject: `Your payment from Naboo – ${ref}`,
      body: `Hi,

Hope you're doing well! ☀️

I'm reaching out from Naboo regarding your payment for the L'Oréal Canada event (${ref}${dateStr}).

The easiest way for us to pay you is by credit card — if that works for you, just let me know and I can arrange that quickly!

If you'd prefer a bank transfer instead, could you send over your banking details?

• Bank name
• Account holder name
• Address
• Institution number
• Transit number
• Account number

Either way, we want to get this sorted for you as soon as possible. Just reply here and we'll take it from there!

Thanks so much!`,
    };
  }

  // ── Tax only ───────────────────────────────────────────────────────────────
  if (!bank && tax) {
    return {
      subject: `Tax number request – ${ref}`,
      body: `Hi,

Hope you're doing well! ☀️

I'm reaching out from Naboo regarding your payment for the L'Oréal Canada event (${ref}${dateStr}).

Could you share your tax number (GST/HST and provincial if applicable)? We need it for our records.

Thanks so much!`,
    };
  }

  // ── Both ───────────────────────────────────────────────────────────────────
  return {
    subject: `Your payment from Naboo – ${ref}`,
    body: `Hi,

Hope you're doing well! ☀️

I'm reaching out from Naboo regarding your payment for the L'Oréal Canada event (${ref}${dateStr}).

The easiest way for us to pay you is by credit card — if that works for you, just let me know and I can arrange that quickly!

If you'd prefer a bank transfer instead, could you send over your banking details?

• Bank name
• Account holder name
• Address
• Institution number
• Transit number
• Account number

Also, could you share your tax number (GST/HST and provincial if applicable)? We need it for our records.

Either way, we want to get this sorted for you as soon as possible. Just reply here and we'll take it from there!

Thanks so much!`,
  };
}

/** Short label for what will be asked — used in buttons and the dialog. */
export function describeNeeds(needs: Needs): string {
  if (needs.bank && needs.tax) return "bank + tax";
  if (needs.bank) return "bank details";
  return "tax number";
}
