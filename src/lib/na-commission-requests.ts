/**
 * Commission / refund request emails for Marketplace NA.
 *
 * Mirrors the tone and structure of the Commissions NA templates
 * (commission-requests.ts), but with two differences dictated by this
 * tracker's data and shape:
 *
 *  - Built only from what NaPartnerLine actually has (totals — gmv_ttc, paid,
 *    commission), not a per-category rate breakdown or deposit dates, so
 *    those lines are left out entirely rather than rendered as blanks.
 *  - One email per PARTNER, not per booking. A Marketplace NA booking can
 *    have several unrelated vendors (a venue, a caterer, a transport
 *    provider); a combined per-booking email would put one vendor's contact
 *    on the hook for figures that belong to a completely different vendor.
 *
 * A partner who was paid more than they were owed splits into two buckets:
 * up to the commission amount is ours to recover (we still owe ourselves
 * that cut), and whatever overpayment remains beyond that is a genuine
 * refund to ask the partner for.
 */
import type { NaRow, NaPartnerLine } from "./na.functions";

export type NaClawback = { commission: number; refund: number };

/** One partner's split, or zero/zero when they were not overpaid. */
export function partnerClawback(p: NaPartnerLine): NaClawback {
  if (p.is_provision) return { commission: 0, refund: 0 };
  const ro = p.raw_outstanding ?? 0;
  if (ro >= -0.01) return { commission: 0, refund: 0 };
  const overpaid = Math.abs(ro);
  const comm = Math.max(p.commission ?? 0, 0);
  const commPart = Math.min(overpaid, comm);
  const refundPart = Math.max(overpaid - comm, 0);
  return { commission: commPart, refund: refundPart };
}

export type NaClawbackSplit = { commission: Map<string, number>; refund: Map<string, number> };

/** Same split, summed by currency across every partner on the booking — used for the StatusCell display. */
export function rowClawbackSplit(partners: NaPartnerLine[]): NaClawbackSplit {
  const commission = new Map<string, number>();
  const refund = new Map<string, number>();
  for (const p of partners) {
    const { commission: comm, refund: ref } = partnerClawback(p);
    const c = p.currency ?? "—";
    if (comm > 0.01) commission.set(c, (commission.get(c) ?? 0) + comm);
    if (ref > 0.01) refund.set(c, (refund.get(c) ?? 0) + ref);
  }
  return { commission, refund };
}

function firstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  return fullName.trim().split(/\s+/)[0] ?? null;
}

/** This partner's own contact — never another partner's on the same booking. */
export function naContactFor(p: NaPartnerLine): { address: string | null; name: string | null } {
  const addr = p.email?.trim() || null;
  if (!addr?.includes("@")) return { address: null, name: null };
  // owners.firstname is the actual contact person, when recorded — otherwise
  // fall back to the first word of the venue/company name.
  const name = p.contact_first_name?.trim() || firstName(p.name);
  return { address: addr, name };
}

function fmtMoney(amount: number | null | undefined, ccy: string | null): string {
  if (amount == null) return "—";
  return (
    Number(amount).toLocaleString("en-CA", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + (ccy ? ` ${ccy}` : "")
  );
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
    const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
    const sameYear = s.getFullYear() === e.getFullYear();
    if (sameMonth) {
      return `${s.toLocaleDateString("en-CA", opts)}–${e.toLocaleDateString("en-CA", yearOpts)}`;
    }
    if (sameYear) {
      return `${s.toLocaleDateString("en-CA", opts)}–${e.toLocaleDateString("en-CA", yearOpts)}`;
    }
    return `${s.toLocaleDateString("en-CA", yearOpts)}–${e.toLocaleDateString("en-CA", yearOpts)}`;
  } catch {
    return [start, end].filter(Boolean).join(" – ");
  }
}

export type NaComposed = { subject: string; body: string };

/**
 * The commission section, spelled out: which lines carry a commission, the base
 * they are computed on, the rate, and the resulting amount. A bare total invites
 * a "where does that come from?" reply and a second round trip.
 */
function commissionBlock(partner: NaPartnerLine, commission: number): string {
  const ccy = partner.currency;
  const items = partner.commissionable ?? [];
  const names = items
    .map((i) => i.label)
    .filter(Boolean)
    .join(", ");
  const base = partner.commissionable_base_ht ?? null;
  const rates = [...new Set(items.map((i) => i.rate_pct).filter((r) => r != null))];
  const rate =
    rates.length === 1
      ? `${rates[0]}%`
      : rates.length > 1
        ? rates.map((r) => `${r}%`).join(" / ")
        : "—";

  const lines: string[] = [];
  if (names) lines.push(`• Commissionable items: ${names}`);
  if (base != null && base > 0.01) lines.push(`• Commissionable base: ${fmtMoney(base, ccy)}`);
  if (rate !== "—") lines.push(`• Commission rate: ${rate}`);
  lines.push(`• Commission due incl. tax: ${fmtMoney(commission, ccy)}`);
  return lines.join("\n");
}

/**
 * Every payment we made, listed. Naming the date, the method and the bank
 * reference is what lets the other side find it in their own ledger instead of
 * disputing the total.
 */
function paymentsBlock(partner: NaPartnerLine): string {
  const rows = partner.disbursements ?? [];
  if (rows.length === 0) {
    return `• Total paid by Naboo: ${fmtMoney(partner.paid, partner.currency)}`;
  }
  const listed = rows
    .map((d) => {
      const method = d.method ? ` by ${d.method}` : "";
      const ref = d.reference ? ` (ref: ${d.reference})` : "";
      return `   • ${fmtMoney(d.amount, d.currency ?? partner.currency)} paid on ${d.paid_on ?? "—"}${method}${ref}`;
    })
    .join("\n");
  const total = rows.reduce((t, d) => t + (d.amount ?? 0), 0);
  return `• Amounts paid by Naboo:\n${listed}\n• Total paid by Naboo: ${fmtMoney(total, partner.currency)}`;
}

/** What the provider actually invoiced us: the payable before our commission. */
function invoiceDue(partner: NaPartnerLine): number {
  return (partner.payable ?? 0) + (partner.commission ?? 0);
}

/** Commission-only email, about this one partner's commission alone. */
export function composeNaCommissionRequest(
  row: NaRow,
  partner: NaPartnerLine,
  to: { name: string | null },
): NaComposed | null {
  const { commission } = partnerClawback(partner);
  if (commission <= 0.01) return null;

  const client = row.company_name ?? "your group";
  const dateRange = fmtDateRange(row.start_date, row.end_date);
  const bookingId = row.readable_id ?? "—";
  const ccy = partner.currency;

  const subject = `Commission due — ${client}${dateRange ? `, ${dateRange}` : ""} (Booking ${bookingId})`;
  const achEft = row.billing_entity === "NABOO_US" ? "ACH" : "EFT";

  const body = `Hi team,

Hope you're doing well!

Thanks again for taking such good care of the ${client} group!

I'm reaching out about the commission for that program. Here's what we have on our end:

${commissionBlock(partner, commission)}

Would you be able to confirm those figures? Once you give me the green light, I'll issue our commission invoice right away and send it over with our wire details.

If your records show something different, just let me know and I'll be happy to walk through it with you.

Our standard terms are net 15 from the invoice date, and we can receive payment by wire or ${achEft}, whichever is easiest on your side.

Thanks so much, and looking forward to working together on the next one.

Best,`;

  return { subject, body };
}

/** Refund-only email — an overpayment beyond what our commission absorbs, for this one partner. */
export function composeNaRefundRequest(
  row: NaRow,
  partner: NaPartnerLine,
  to: { name: string | null },
): NaComposed | null {
  const { refund } = partnerClawback(partner);
  if (refund <= 0.01) return null;

  const client = row.company_name ?? "your group";
  const dateRange = fmtDateRange(row.start_date, row.end_date);
  const bookingId = row.readable_id ?? "—";
  const ccy = partner.currency;

  const subject = `Overpayment on Booking ${bookingId} — ${client}${dateRange ? `, ${dateRange}` : ""}`;

  const body = `Hi team,

Hope you're doing well!

I was closing out the file on the ${client} program and caught something on our side — it looks like we overpaid you, so I wanted to flag it and get it squared away.

Here's what we're seeing:
• Total invoice due: ${fmtMoney((partner.payable ?? 0) + (partner.commission ?? 0), ccy)}
• Total paid by Naboo: ${fmtMoney(partner.paid, ccy)}
• Overpayment: ${fmtMoney(refund, ccy)}

Could you take a look and confirm it matches your records? Once you do, we'd ask for a refund of ${fmtMoney(refund, ccy)} and I'll send over a credit note for your files.

If anything looks off in my numbers, just say the word and I'll walk through the payment history with you. Happy to hop on a quick call if that's faster.

Thanks so much for your help on this — and thanks again for a great event.

Best,`;

  return { subject, body };
}

/** Both commission and a refund apply to this same partner — one email covering both. */
export function composeNaCombinedRequest(
  row: NaRow,
  partner: NaPartnerLine,
  to: { name: string | null },
): NaComposed | null {
  const { commission, refund } = partnerClawback(partner);
  if (commission <= 0.01 || refund <= 0.01) return null;

  const client = row.company_name ?? "your group";
  const dateRange = fmtDateRange(row.start_date, row.end_date);
  const bookingId = row.readable_id ?? "—";
  const ccy = partner.currency;
  const subject = `${client} — commission + overpayment to settle (Booking ${bookingId})`;
  const achEft = row.billing_entity === "NABOO_US" ? "ACH" : "EFT";

  const body = `Hi team,

Hope you're doing well!

I've just finished reconciling the ${client} program and wanted to send you everything in one place rather than in pieces. There are two items open on our side — the commission we're owed, and an overpayment on the invoice.

1) Commission
• Commission due incl. tax: ${fmtMoney(commission, ccy)}

2) Overpayment
• Total invoice due: ${fmtMoney(invoiceDue(partner), ccy)}
${paymentsBlock(partner)}
• Refund due to Naboo: ${fmtMoney(refund, ccy)}

Total to be paid to Naboo (commission + overpayment): ${fmtMoney(commission + refund, ccy)}

Could you confirm the figures match your records? Once you do, I'll issue our commission invoice and send over a credit note for the overpayment so both sides tie out cleanly in your books — payable by wire or ${achEft}, whichever is easiest on your side.

If anything looks off — send me your version and I'll go through it with you line by line. Happy to jump on a quick call if that's easier.

Thanks so much, and thanks again for hosting the group.

Best,`;

  return { subject, body };
}
