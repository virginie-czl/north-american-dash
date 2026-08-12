/**
 * Collapsing a booking's raw provider lines into one row per provider.
 *
 * Both free-invoicing trackers (L'Oréal Canada, Veolia) read the same shape:
 * one line per quote, plus trade-name shells coming from the quotes table, so
 * the same provider can arrive several times over. This module is the single
 * place that decides how those lines become one, and — the part that has bitten
 * us — how their amounts add up.
 *
 * Pure, no I/O: exercised by partner-merge.test.mjs.
 */

/** The provider fields the merge reads. Both trackers' PartnerLine match it. */
export interface MergeablePartner {
  name: string | null;
  email: string | null;
  phone: string | null;
  owner_code: string | null;
  vat_raw: string | null;
  tax_identifier: string | null;
  country: string | null;
  currency: string | null;
  amount_due: number | null;
  amount_paid: number | null;
  net_payable_ttc: number | null;
  is_outstanding: boolean | null;
  is_cancelled: boolean | null;
  payout_fx_date: string | null;
}

/** A provider being assembled, and every source line that fed it. */
type Group<T extends MergeablePartner> = { line: T; members: T[] };

const round2 = (v: number) => Math.round(v * 100) / 100;

export function mergePartners<T extends MergeablePartner>(list: T[]): T[] {
  // Pass 1: bucket entries by name key.
  const byName = new Map<string, Group<T>>();
  const noName: Group<T>[] = [];
  for (const p of list) {
    const nameKey = (p.name ?? "").trim().toLowerCase();
    if (!nameKey) {
      noName.push({ line: { ...p }, members: [p] });
      continue;
    }
    const existing = byName.get(nameKey);
    if (!existing) {
      byName.set(nameKey, { line: { ...p }, members: [p] });
    } else {
      absorb(existing, p);
    }
  }

  // Pass 2: collapse entries that share an email (different name variants
  // — e.g. legal entity vs trade name — sourced from quotes + service_providers).
  const byEmail = new Map<string, Group<T>>();
  const result: Group<T>[] = [];
  for (const g of byName.values()) {
    const emailKey = (g.line.email ?? "").trim().toLowerCase();
    if (!emailKey) {
      result.push(g);
      continue;
    }
    const existing = byEmail.get(emailKey);
    if (!existing) {
      byEmail.set(emailKey, g);
      result.push(g);
    } else {
      absorbGroup(existing, g);
    }
  }
  for (const g of noName) {
    const emailKey = (g.line.email ?? "").trim().toLowerCase();
    const existing = emailKey ? byEmail.get(emailKey) : undefined;
    if (existing) absorbGroup(existing, g);
    else result.push(g);
  }
  // Drop "ghost" rows that came from quotes but carry no contact and no
  // amounts — they're duplicate trade-name shells of a service_providers row
  // we already kept under the legal name.
  return result.map(providerTotals).filter((p) => {
    const noAmounts =
      (p.amount_due ?? 0) === 0 && (p.amount_paid ?? 0) === 0 && (p.net_payable_ttc ?? 0) === 0;
    const noContact = !p.email && !p.phone;
    return !(noAmounts && noContact);
  });
}

function absorb<T extends MergeablePartner>(group: Group<T>, p: T) {
  mergeInto(group.line, p);
  group.members.push(p);
}

function absorbGroup<T extends MergeablePartner>(target: Group<T>, incoming: Group<T>) {
  mergeInto(target.line, incoming.line);
  target.members.push(...incoming.members);
}

/**
 * What the provider is still owed, once all of its lines are in hand.
 *
 * The two amounts on a line have different scopes, which is what makes this
 * worth its own pass:
 *   - net_payable_ttc belongs to that quote alone, so the amounts add up.
 *     F-B658 carries three lines for the same provider — 887,50 + 50 + 100 GBP
 *     — and owes 1 037,50, not the 887,50 that picking the largest line gave.
 *   - amount_paid on an outstanding line is the provider's running total for
 *     the whole booking, repeated on every one of its lines (verified: the
 *     disbursed total is identical across every line of a provider). It is
 *     therefore counted once, and subtracted once.
 *
 * A line that is no longer outstanding is already settled upstream — it owes
 * nothing and its paid figure is its own quote's, not a repeated total — so it
 * only contributes through mergeInto's running totals.
 */
function providerTotals<T extends MergeablePartner>({ line, members }: Group<T>): T {
  const outstanding = members.filter((m) => m.is_outstanding);
  const paidOnce = outstanding.reduce((best, m) => {
    const v = m.amount_paid ?? 0;
    return Math.abs(v) > Math.abs(best) ? v : best;
  }, 0);
  const gross = outstanding.reduce((total, m) => total + (m.net_payable_ttc ?? 0), 0);
  return { ...line, amount_due: Math.max(round2(gross - Math.abs(paidOnce)), 0) };
}

function mergeInto<T extends MergeablePartner>(existing: T, p: T) {
  // Prefer the variant that actually carries amounts (service_providers row)
  // for the display name.
  const existingHasAmounts =
    (existing.amount_due ?? 0) !== 0 ||
    (existing.amount_paid ?? 0) !== 0 ||
    (existing.net_payable_ttc ?? 0) !== 0;
  const incomingHasAmounts =
    (p.amount_due ?? 0) !== 0 || (p.amount_paid ?? 0) !== 0 || (p.net_payable_ttc ?? 0) !== 0;
  if (!existingHasAmounts && incomingHasAmounts && p.name) existing.name = p.name;

  // amount_due is recomputed from every line in providerTotals; this running
  // value only feeds the name preference above.
  const existingDue = existing.amount_due ?? 0;
  const incomingDue = Math.max(p.amount_due ?? 0, 0);
  existing.amount_due = Math.abs(incomingDue) > Math.abs(existingDue) ? incomingDue : existingDue;

  // Paid stays the single largest figure rather than a sum: on an outstanding
  // provider it is the same booking-level total repeated on each line.
  const existingPaid = existing.amount_paid ?? 0;
  const incomingPaid = p.amount_paid ?? 0;
  existing.amount_paid =
    Math.abs(incomingPaid) > Math.abs(existingPaid) ? incomingPaid : existingPaid;

  existing.net_payable_ttc = (existing.net_payable_ttc ?? 0) + (p.net_payable_ttc ?? 0);
  existing.is_outstanding = Boolean(existing.is_outstanding) || Boolean(p.is_outstanding);
  existing.is_cancelled = Boolean(existing.is_cancelled) && Boolean(p.is_cancelled);
  if (!existing.email && p.email) existing.email = p.email;
  if (!existing.phone && p.phone) existing.phone = p.phone;
  if (!existing.owner_code && p.owner_code) existing.owner_code = p.owner_code;
  if (!existing.vat_raw && p.vat_raw) existing.vat_raw = p.vat_raw;
  if (!existing.tax_identifier && p.tax_identifier) existing.tax_identifier = p.tax_identifier;
  if (!existing.country && p.country) existing.country = p.country;
  if (!existing.currency && p.currency) existing.currency = p.currency;
  if (
    !existing.payout_fx_date ||
    (p.payout_fx_date && p.payout_fx_date > existing.payout_fx_date)
  ) {
    existing.payout_fx_date = p.payout_fx_date;
  }
}
