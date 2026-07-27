/**
 * Builds the commission request email from Shayma's template.
 *
 * The email goes to the venue/partner (who owes Naboo the commission),
 * addressed to the first name extracted from owner_full_name.
 * One email per booking — multiple partners on the same booking are listed
 * as line items, not separate emails.
 */
import type { CommissionRow, CommissionPartnerLine } from "./commission.functions";

export type CommissionEmailTarget = {
  /** To address: first owner_email or service_owner_email across partners */
  address: string;
  /** Human name for the To field */
  contactName: string | null;
  row: CommissionRow;
};

function firstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  return fullName.trim().split(/\s+/)[0] ?? null;
}

/** Picks the best contact email for a booking (first non-null across partners). */
export function pickContact(partners: CommissionPartnerLine[]): {
  address: string | null;
  name: string | null;
} {
  for (const p of partners) {
    const addr = p.owner_email?.trim() || p.service_owner_email?.trim() || null;
    if (addr?.includes("@")) {
      return { address: addr, name: firstName(p.owner_full_name) };
    }
  }
  return { address: null, name: null };
}

function fmtMoney(amount: number | null, ccy: string | null): string {
  if (amount == null) return "—";
  return (
    Number(amount).toLocaleString("en-CA", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + (ccy ? ` ${ccy}` : "")
  );
}

function fmtPct(rate: number | null): string {
  if (rate == null) return "—";
  return (rate * 100).toFixed(1) + " %";
}

function fmtDateRange(start: string | null, end: string | null): string {
  if (!start && !end) return "";
  const opts: Intl.DateTimeFormatOptions = { month: "long", day: "numeric" };
  const yearOpts: Intl.DateTimeFormatOptions = { ...opts, year: "numeric" };
  try {
    const s = start ? new Date(start) : null;
    const e = end ? new Date(end) : null;
    if (!s) return e ? e.toLocaleDateString("en-CA", yearOpts) : "";
    if (!e || s.getTime() === e.getTime()) return s.toLocaleDateString("en-CA", yearOpts);
    const same_month = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
    const same_year = s.getFullYear() === e.getFullYear();
    if (same_month) {
      return `${s.toLocaleDateString("en-CA", opts)}–${e.toLocaleString("en-CA", yearOpts).replace(/^[^0-9]*/, "").replace(/.*?,\s*/, "").split(",")[0]}, ${e.getFullYear()}`;
    }
    if (same_year) {
      return `${s.toLocaleDateString("en-CA", opts)}–${e.toLocaleDateString("en-CA", yearOpts)}`;
    }
    return `${s.toLocaleDateString("en-CA", yearOpts)}–${e.toLocaleDateString("en-CA", yearOpts)}`;
  } catch {
    return [start, end].filter(Boolean).join(" – ");
  }
}

export type CommissionComposed = { subject: string; body: string };

export function composeCommissionRequest(row: CommissionRow, to: { name: string | null }): CommissionComposed {
  const client = row.company_name ?? "your group";
  const dateRange = fmtDateRange(row.start_date, row.end_date);
  const bookingId = row.readable_id ?? "—";
  const ccy = row.currency_client;
  const firstName = to.name ?? "there";

  const subject = [
    "Commission due —",
    client,
    dateRange ? `, ${dateRange}` : "",
    ` (Booking ${bookingId})`,
  ].join("");

  // Build commission items bullet list (one per partner)
  const partners = (row.partners ?? []).filter(
    (p) => (p.commission_ht ?? 0) > 0.01,
  );

  const commissionItems = partners
    .map((p) => {
      const parts: string[] = [];
      const cats = [
        p.rate_house != null ? `venue ${fmtPct(p.rate_house)}` : null,
        p.rate_food != null ? `F&B ${fmtPct(p.rate_food)}` : null,
        p.rate_activity != null ? `activity ${fmtPct(p.rate_activity)}` : null,
      ].filter(Boolean);
      const rate = cats.length > 0 ? cats.join(", ") : fmtPct(p.commission_rate);
      parts.push(
        `${p.venue_name ?? p.partner_name ?? "Partner"}: ${fmtMoney(p.gmv_ht, p.partner_currency)} × ${rate} = ${fmtMoney(p.commission_ht, p.partner_currency)}`,
      );
      return `   • ${parts.join("; ")}`;
    })
    .join("\n");

  const totalCommission = fmtMoney(row.total_commission_ht, ccy);
  const grossGmv = fmtMoney(row.gross_gmv_ht, ccy);

  // Commissionable base = sum of partner GMVs in partner currency (gross net of our fees)
  const commissionableBase = partners.every((p) => p.partner_currency === ccy)
    ? fmtMoney(
        partners.reduce((s, p) => s + (p.gmv_ht ?? 0), 0),
        ccy,
      )
    : partners
        .map((p) => fmtMoney(p.gmv_ht, p.partner_currency))
        .join(" + ");

  const ach_eft = row.billing_entity === "NABOO_US" ? "ACH" : "EFT";
  const body = `Hi ${firstName},

Hope you're doing well!

Thanks again for taking such good care of the ${client} group!

I'm reaching out about the commission for that program. Here's the breakdown as we have it on our end:

• Total event amount (before tax): ${grossGmv}
• Commissionable base: ${commissionableBase}
• Commission items and rates:
${commissionItems}
• Total commission due: ${totalCommission}

Would you be able to confirm those figures? Once you give me the green light, I'll issue our commission invoice right away and send it over with our wire details.

If your records show something different — a different base, a rate we've got wrong, or line items that shouldn't be commissionable — just let me know and I'll be happy to walk through it with you line by line.

Our standard terms are net 15 from the invoice date, and we can receive payment by wire or ${ach_eft}, whichever is easiest on your side.

Thanks so much, and looking forward to working together on the next one.

Best,`;

  return { subject, body };
}

// ─── Refund request ────────────────────────────────────────────────────────

export type RefundComposed = { subject: string; body: string };

export function composeRefundRequest(
  row: CommissionRow,
  to: { name: string | null },
): RefundComposed | null {
  const overpaidPartners = (row.partners ?? []).filter(
    (p) => (p.outstanding_payable ?? 0) < -0.10,
  );
  if (overpaidPartners.length === 0) return null;

  const client = row.company_name ?? "your group";
  const dateRange = fmtDateRange(row.start_date, row.end_date);
  const bookingId = row.readable_id ?? "—";
  const greeting = to.name ?? "there";

  const subject = `Overpayment on Booking ${bookingId} — ${client}, ${dateRange}`;

  const allSameCcy = overpaidPartners.every(
    (p) => p.partner_currency === overpaidPartners[0].partner_currency,
  );
  const ccy = allSameCcy ? (overpaidPartners[0].partner_currency ?? null) : null;

  const totalNetPayable = overpaidPartners.reduce((s, p) => s + (p.net_payable ?? 0), 0);
  const totalDisbursed = overpaidPartners.reduce((s, p) => s + (p.disbursed_total ?? 0), 0);
  const totalOverpaid = overpaidPartners.reduce(
    (s, p) => s + Math.abs(p.outstanding_payable ?? 0),
    0,
  );
  const depositTotal = overpaidPartners.reduce((s, p) => s + (p.deposit_net_payable ?? 0), 0);
  const balanceTotal = totalDisbursed - depositTotal;
  const depositDate = overpaidPartners.find((p) => p.deposit_payment_date)?.deposit_payment_date;

  const depositPart = depositDate
    ? `deposit ${fmtMoney(depositTotal, ccy)} on ${fmtShortDate(depositDate)}`
    : `deposit ${fmtMoney(depositTotal, ccy)}`;
  const paymentBreakdown = `${depositPart} + balance ${fmtMoney(balanceTotal, ccy)}`;

  const body = `Hi ${greeting},

Hope you're doing well!

I was closing out the file on the ${client} program and caught something on our side — it looks like we overpaid you, so I wanted to flag it and get it squared away.

Here's what we're seeing:
• Total event amount (before tax): ${fmtMoney(Number(row.gross_gmv_ht ?? 0), row.currency_client)}
• Amount due per your final invoice: ${fmtMoney(totalNetPayable, ccy)}
• Amount we paid: ${fmtMoney(totalDisbursed, ccy)} (${paymentBreakdown})
• Overpayment: ${fmtMoney(totalOverpaid, ccy)}

Could you take a look and confirm it matches your records? Once you do, we'd ask for a refund of ${fmtMoney(totalOverpaid, ccy)} and I'll send over a credit note for your files.

If anything looks off in my numbers, just say the word and I'll walk through the payment history with you. Happy to hop on a quick call if that's faster.

Thanks so much for your help on this — and thanks again for a great event.

Best,`;

  return { subject, body };
}

function fmtShortDate(s: string | null | undefined): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
  } catch {
    return s;
  }
}
