/**
 * Card tracking North America — one row per service provider, and whether they take
 * card. No I/O, so every rule below is unit-tested directly.
 *
 * Two fields in the data say the opposite of the truth if you read them as
 * acceptance, and both are load-bearing enough to state here:
 *
 *  1. `partner_payment_method` is **not** acceptance. 435 of the 447 providers with
 *     an accepted North American booking carry `CREDIT_CARD` — 97%. It records the
 *     method Naboo intends to use, not what the provider agreed to. Nothing in this
 *     module reads it; it is carried through for display only.
 *  2. A Slack refusal is **Naboo** refusing. `#finance-paiement-by-card` posts
 *     `Credit Card Request Refused / Refused by: <approver>` — that is our own
 *     approver declining to issue a card, for our own reasons. Only
 *     `Credit Card Request Approved` is evidence, and only in the positive
 *     direction, which is why CardEvidence carries no refusal from Slack at all.
 *
 * The provider's willingness and Naboo's decision are two different questions and
 * never collapse into one value: `cardStatus` answers the first, `naboo_pays_card`
 * the second. The interesting row is the divergence — they accept and we still say
 * no — and that is the one place a written reason is mandatory.
 */

// ── The manual layer ────────────────────────────────────────────────────────

export type CardYesNo = "yes" | "no";

/** One row of provider_card_terms, as edited in the table. */
export type CardTerms = {
  owner_code: string;
  /** Manual override of the derived status. Null falls back to the evidence. */
  accepts_card: CardYesNo | null;
  /** Percentage, e.g. 2.5 for 2.5%. */
  fee_percent: number | null;
  /** A flat amount on top of, or instead of, the percentage. */
  fee_fixed: number | null;
  fee_currency: string | null;
  /** Why the provider refuses — their reason, not ours. */
  refusal_reason: string | null;
  /** Naboo's own decision. Null means nobody has decided yet. */
  naboo_pays_card: CardYesNo | null;
  /** Required when they accept and we decline. */
  naboo_reason: string | null;
  updated_by: string | null;
  /** ISO timestamp. */
  updated_at: string | null;
};

export function emptyTerms(ownerCode: string): CardTerms {
  return {
    owner_code: ownerCode,
    accepts_card: null,
    fee_percent: null,
    fee_fixed: null,
    fee_currency: null,
    refusal_reason: null,
    naboo_pays_card: null,
    naboo_reason: null,
    updated_by: null,
    updated_at: null,
  };
}

// ── The evidence ────────────────────────────────────────────────────────────

/**
 * What we know about this provider from sources that were already built.
 *
 * `slackApproved` is an approved card request for this provider's `O-` code — an
 * exact match, no name fuzzing. `emailVerdict` is `partner_email_facts.card_payment`
 * across all of their bookings, where acceptance already requires an explicit
 * affirmative directed at the card (loose keyword matching was removed for producing
 * false positives). There is deliberately no `slackRefused`: see the header.
 */
export type CardEvidence = {
  slackApproved: boolean;
  emailVerdict: "accepted" | "refused" | "unknown";
  /**
   * How many approved cards the provider has, and when the most recent one was.
   * Display only — one approval and forty both mean "they take card", but the reader
   * deciding whether to pay by card wants to know which of the two it is.
   */
  approvalCount?: number;
  /** ISO day. */
  lastApprovedAt?: string | null;
};

export const NO_EVIDENCE: CardEvidence = { slackApproved: false, emailVerdict: "unknown" };

export type CardStatus = "card_ok" | "card_ok_if_fee" | "refuses" | "unknown";

export const CARD_STATUS_LABEL: Record<CardStatus, string> = {
  card_ok: "Card OK",
  card_ok_if_fee: "Card OK if fee",
  refuses: "Refuses card",
  unknown: "Unknown",
};

/** Where the status came from, so an override is never mistaken for evidence. */
export type CardStatusSource = "manual" | "slack" | "email" | "none";

export type CardVerdict = {
  status: CardStatus;
  source: CardStatusSource;
  /** True when a human set accepts_card and it is what decided the status. */
  overridden: boolean;
};

function pluralise(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A fee is recorded when either part of it is non-zero. */
export function hasFee(terms: Pick<CardTerms, "fee_percent" | "fee_fixed">): boolean {
  return (terms.fee_percent ?? 0) > 0 || (terms.fee_fixed ?? 0) > 0;
}

/**
 * Does the provider take card, and on whose word.
 *
 * A manual override wins over both sources — someone phoned them — and says so, so
 * nobody has to wonder why the derived status disagrees.
 */
export function cardStatus(evidence: CardEvidence, terms: CardTerms | null): CardVerdict {
  const t = terms ?? emptyTerms("");
  const withFee = (status: CardStatus): CardStatus =>
    // "Card OK if fee" is a display of "Card OK" plus a fee, never a stored fourth
    // state: recording a fee promotes the row and clearing it demotes it, so the
    // status and the fee cannot contradict each other.
    status === "card_ok" && hasFee(t) ? "card_ok_if_fee" : status;

  if (t.accepts_card === "yes") {
    return { status: withFee("card_ok"), source: "manual", overridden: true };
  }
  if (t.accepts_card === "no") {
    return { status: "refuses", source: "manual", overridden: true };
  }
  if (evidence.slackApproved) {
    return { status: withFee("card_ok"), source: "slack", overridden: false };
  }
  if (evidence.emailVerdict === "accepted") {
    return { status: withFee("card_ok"), source: "email", overridden: false };
  }
  if (evidence.emailVerdict === "refused") {
    return { status: "refuses", source: "email", overridden: false };
  }
  // The honest default. Most providers have never been asked.
  return { status: "unknown", source: "none", overridden: false };
}

/**
 * "4 approvals, last 31 Jul 2026" — the strength of the evidence, in a phrase.
 *
 * Null when there is nothing to say, so a caller can render it or not without
 * inspecting the shape.
 */
export function approvalNote(evidence: CardEvidence | null | undefined): string | null {
  const count = evidence?.approvalCount ?? 0;
  if (!evidence?.slackApproved || count < 1) return null;
  const when = evidence.lastApprovedAt ? `, last ${fmtDay(evidence.lastApprovedAt)}` : "";
  return `${pluralise(count, "approval")}${when}`;
}

export function accepts(status: CardStatus): boolean {
  return status === "card_ok" || status === "card_ok_if_fee";
}

// ── Aggregating the bookings ────────────────────────────────────────────────

/**
 * One row as the query returns it: a provider on one quote.
 *
 * The quote is the grain, not the row and not the booking. The reconciliation master
 * emits the same quote more than once (847 raw rows for 609 owner/quote pairs), and a
 * booking can carry two quotes from the same provider with two genuinely different
 * payables — Pknik on F-B333 is −500.00 and −6,239.65 CAD. Deduplicating on the
 * booking would drop one of those; summing the raw rows would count both twice.
 */
export type CardQuoteRow = {
  owner_code: string;
  quote_id: string;
  provider_name: string | null;
  country: string | null;
  email: string | null;
  /** Other names the same provider is known by — used to match the Gmail scan. */
  venue_name: string | null;
  partner_name: string | null;
  event_ref: string | null;
  currency: string | null;
  outstanding: number | null;
  /** ISO day. */
  start_date: string | null;
  /** Carried for display only — never read as acceptance. */
  payment_method: string | null;
};

export type CardAmount = { currency: string; amount: number };

/** One provider, across every accepted North American booking they appear on. */
export type CardProvider = {
  owner_code: string;
  provider_name: string;
  country: string | null;
  email: string | null;
  /** Every name this provider trades under, for matching the email scan. */
  aliases: string[];
  bookings: number;
  event_refs: string[];
  /** ISO day of the most recent booking. */
  latest_start: string | null;
  /**
   * Outstanding by currency. Never one total: this data mixes USD, CAD, EUR and IDR
   * — BizAway alone carries 281,000,000 IDR — and a single sum across them would be
   * a number that means nothing to whoever reads it.
   */
  amounts: CardAmount[];
  payment_methods: string[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The largest single-currency exposure, for sorting. Never a cross-currency sum. */
export function peakAmount(p: Pick<CardProvider, "amounts">): number {
  return p.amounts.reduce((max, a) => Math.max(max, Math.abs(a.amount)), 0);
}

export function aggregateProviders(rows: CardQuoteRow[]): CardProvider[] {
  const byOwner = new Map<
    string,
    {
      p: CardProvider;
      amounts: Map<string, number>;
      refs: Set<string>;
      aliases: Set<string>;
      methods: Set<string>;
      quotes: Set<string>;
    }
  >();

  for (const r of rows) {
    const code = (r.owner_code ?? "").trim().toUpperCase();
    if (!code) continue;
    let entry = byOwner.get(code);
    if (!entry) {
      entry = {
        p: {
          owner_code: code,
          provider_name: "",
          country: null,
          email: null,
          aliases: [],
          bookings: 0,
          event_refs: [],
          latest_start: null,
          amounts: [],
          payment_methods: [],
        },
        amounts: new Map(),
        refs: new Set(),
        aliases: new Set(),
        methods: new Set(),
        quotes: new Set(),
      };
      byOwner.set(code, entry);
    }

    // First non-empty name wins, and the rest become aliases: the same owner is
    // recorded as "BizAway", "BizAway United States" and "Bizaway Indonesia".
    const name = (r.provider_name ?? "").trim();
    if (name && !entry.p.provider_name) entry.p.provider_name = name;
    for (const alias of [r.provider_name, r.venue_name, r.partner_name]) {
      const a = (alias ?? "").trim();
      if (a) entry.aliases.add(a);
    }
    if (!entry.p.country && r.country) entry.p.country = r.country.trim().toUpperCase() || null;
    if (!entry.p.email && r.email) entry.p.email = r.email.trim() || null;
    if (r.event_ref) entry.refs.add(r.event_ref);
    if (r.payment_method) entry.methods.add(r.payment_method);
    if (r.start_date && (entry.p.latest_start == null || r.start_date > entry.p.latest_start)) {
      entry.p.latest_start = r.start_date;
    }

    // One amount per quote. A repeated quote is the view's own duplication, not a
    // second payable.
    const quote = (r.quote_id ?? "").trim();
    if (quote && entry.quotes.has(quote)) continue;
    if (quote) entry.quotes.add(quote);
    if (r.outstanding != null && r.currency) {
      const ccy = r.currency.trim().toUpperCase();
      entry.amounts.set(ccy, (entry.amounts.get(ccy) ?? 0) + Number(r.outstanding));
    }
  }

  const out: CardProvider[] = [];
  for (const entry of byOwner.values()) {
    const p = entry.p;
    p.provider_name = p.provider_name || p.owner_code;
    p.bookings = entry.refs.size;
    p.event_refs = [...entry.refs].sort();
    p.aliases = [...entry.aliases].sort();
    p.payment_methods = [...entry.methods].sort();
    p.amounts = [...entry.amounts]
      .map(([currency, amount]) => ({ currency, amount: round2(amount) }))
      // Zero is not an exposure; dropping it keeps "amount at stake" readable.
      .filter((a) => a.amount !== 0)
      .sort(
        (a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.currency.localeCompare(b.currency),
      );
    out.push(p);
  }
  return out.sort((a, b) => a.provider_name.localeCompare(b.provider_name));
}

// ── The row as the page sees it ─────────────────────────────────────────────

export type CardRow = {
  provider: CardProvider;
  terms: CardTerms;
  verdict: CardVerdict;
  evidence: CardEvidence;
};

export function buildRows(
  providers: CardProvider[],
  termsByOwner: Map<string, CardTerms>,
  evidenceByOwner: Map<string, CardEvidence>,
): CardRow[] {
  return providers.map((provider) => {
    const terms = termsByOwner.get(provider.owner_code) ?? emptyTerms(provider.owner_code);
    const evidence = evidenceByOwner.get(provider.owner_code) ?? NO_EVIDENCE;
    return { provider, terms, verdict: cardStatus(evidence, terms), evidence };
  });
}

// ── Scopes ──────────────────────────────────────────────────────────────────

export type CardScopeKey =
  "needs_decision" | "card_ok" | "card_ok_if_fee" | "refuses" | "we_decline" | "all";

/**
 * One predicate per chip, used for both the filter and the count.
 *
 * They share this table on purpose: on Marketplace NA the two drifted apart and a
 * chip claimed a number the list below it did not show.
 */
export const CARD_SCOPES: Array<{
  key: CardScopeKey;
  label: string;
  hint: string;
  match: (row: CardRow) => boolean;
}> = [
  {
    key: "needs_decision",
    label: "Needs a decision",
    hint: "Status unknown, or they accept and nobody has decided whether we pay by card",
    match: (r) =>
      r.verdict.status === "unknown" ||
      (accepts(r.verdict.status) && r.terms.naboo_pays_card == null),
  },
  {
    key: "card_ok",
    label: "Card OK",
    hint: "Accepted, no fee recorded",
    match: (r) => r.verdict.status === "card_ok",
  },
  {
    key: "card_ok_if_fee",
    label: "Card OK if fee",
    hint: "Accepted, with a fee recorded",
    match: (r) => r.verdict.status === "card_ok_if_fee",
  },
  {
    key: "refuses",
    label: "Refuses card",
    hint: "The provider said no — never inferred from a Slack refusal",
    match: (r) => r.verdict.status === "refuses",
  },
  {
    key: "we_decline",
    label: "We decline",
    hint: "They take card and we have decided not to",
    match: (r) => accepts(r.verdict.status) && r.terms.naboo_pays_card === "no",
  },
  {
    key: "all",
    label: "All",
    hint: "Every provider with an accepted NA booking",
    match: () => true,
  },
];

export function scopeMatcher(key: CardScopeKey): (row: CardRow) => boolean {
  return CARD_SCOPES.find((s) => s.key === key)?.match ?? (() => true);
}

export function scopeCounts(rows: CardRow[]): Record<CardScopeKey, number> {
  const counts = {} as Record<CardScopeKey, number>;
  for (const scope of CARD_SCOPES) counts[scope.key] = rows.filter(scope.match).length;
  return counts;
}

/** Provider name, `O-` code and country — the three things worth searching. */
export function matchesSearch(row: CardRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    row.provider.provider_name,
    row.provider.owner_code,
    row.provider.country,
    ...row.provider.aliases,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export type CardSortKey = "provider" | "amount" | "bookings";

export function sortRows(rows: CardRow[], key: CardSortKey, desc: boolean): CardRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    switch (key) {
      case "amount":
        return peakAmount(a.provider) - peakAmount(b.provider);
      case "bookings":
        return a.provider.bookings - b.provider.bookings;
      default:
        return a.provider.provider_name.localeCompare(b.provider.provider_name);
    }
  });
  return desc ? sorted.reverse() : sorted;
}

// ── Saving ──────────────────────────────────────────────────────────────────

export type CardTermsInput = {
  owner_code: string;
  accepts_card: CardYesNo | null;
  fee_percent: number | null;
  fee_fixed: number | null;
  fee_currency: string | null;
  refusal_reason: string | null;
  naboo_pays_card: CardYesNo | null;
  naboo_reason: string | null;
};

/**
 * What must hold before a row can be saved, checked in the UI and again on the
 * server so a stale tab cannot store a contradiction.
 *
 * The mandatory reason is the point of the page. When the provider takes card and we
 * still say no, the reason — their fee is not worth it, the amount is over the card
 * limit, Pliant refused them before — is the only thing that will answer "why is
 * this one being wired?" in three months. When the provider refuses, no
 * justification is asked for: the answer is obvious, and forcing text there would
 * produce a column of "n/a".
 */
export function validateCardTerms(input: CardTermsInput, status: CardStatus): string | null {
  const filled = (v: string | null | undefined) => (v ?? "").trim().length > 0;

  if (accepts(status) && input.naboo_pays_card === "no" && !filled(input.naboo_reason)) {
    return "Say why we are not paying this provider by card — they accept it, so the reason is the only record of the decision.";
  }
  if (input.accepts_card === "no" && hasFee(input)) {
    return "A provider that refuses card cannot have a card fee. Clear the fee, or set them back to accepting.";
  }
  if (input.accepts_card === "yes" && filled(input.refusal_reason)) {
    return "A reason for refusal makes no sense on a provider that accepts card. Clear it, or set them to refusing.";
  }
  if ((input.fee_percent ?? 0) < 0 || (input.fee_fixed ?? 0) < 0) {
    return "A card fee cannot be negative.";
  }
  if ((input.fee_percent ?? 0) > 100) {
    return "A card fee of more than 100% is not a fee — check the figure.";
  }
  return null;
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function fmtAmount(amount: number, currency?: string | null): string {
  const text = amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${text} ${currency}` : text;
}

/** Every currency, listed. "—" when nothing is outstanding. */
export function fmtAmounts(amounts: CardAmount[]): string {
  if (amounts.length === 0) return "—";
  return amounts.map((a) => fmtAmount(a.amount, a.currency)).join(" · ");
}

export function fmtFee(terms: CardTerms): string {
  const parts: string[] = [];
  if ((terms.fee_percent ?? 0) > 0) parts.push(`${Number(terms.fee_percent).toFixed(2)}%`);
  if ((terms.fee_fixed ?? 0) > 0) {
    parts.push(fmtAmount(Number(terms.fee_fixed), terms.fee_currency ?? null));
  }
  // Both can apply at once — a percentage plus a flat charge — so both are shown
  // rather than one being folded into the other.
  return parts.length > 0 ? parts.join(" + ") : "—";
}

export function fmtDay(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((iso ?? "").trim());
  if (!m) return "—";
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

/** `synced 3 h ago` — the mirror's staleness, said out loud rather than assumed. */
export function fmtAge(seconds: number | null): string {
  if (seconds == null) return "never synced";
  if (seconds < 90) return "synced just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `synced ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `synced ${hours} h ago`;
  return `synced ${Math.round(hours / 24)} d ago`;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export const CSV_HEADER = [
  "Provider",
  "Owner code",
  "Country",
  "Bookings",
  "Latest booking",
  "Amount at stake",
  "Provider takes card",
  "Status source",
  "Fee %",
  "Fee fixed",
  "Fee currency",
  "Reason for refusal",
  "Naboo pays by card",
  "Why not",
  "Last updated by",
  "Last updated at",
];

export function csvRows(rows: CardRow[]): string[][] {
  return rows.map((r) => [
    r.provider.provider_name,
    r.provider.owner_code,
    r.provider.country ?? "",
    String(r.provider.bookings),
    r.provider.latest_start ?? "",
    fmtAmounts(r.provider.amounts),
    CARD_STATUS_LABEL[r.verdict.status] + (r.verdict.overridden ? " (override)" : ""),
    r.verdict.source,
    r.terms.fee_percent == null ? "" : String(r.terms.fee_percent),
    r.terms.fee_fixed == null ? "" : String(r.terms.fee_fixed),
    r.terms.fee_currency ?? "",
    r.terms.refusal_reason ?? "",
    r.terms.naboo_pays_card ?? "",
    r.terms.naboo_reason ?? "",
    r.terms.updated_by ?? "",
    r.terms.updated_at ?? "",
  ]);
}
