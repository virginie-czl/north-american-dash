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
 * never collapse into one value: `cardStatus` answers the first, `nabooPays` the
 * second. The interesting row is the divergence — they accept and we still say no —
 * and that is the one place a written reason is mandatory.
 *
 * Only one of the two is ever assumed. A provider who takes card **at no fee** is
 * answered yes without being asked, because there is nothing to weigh: see `nabooPays`.
 * The provider's own willingness is never assumed in either direction.
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
  /**
   * Naboo's own decision, as stored. Null means nobody has typed one — which is not
   * the same as undecided: read it through `nabooPays`, which answers yes for a
   * provider who takes card at no fee.
   */
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
  /**
   * The provider is an airline.
   *
   * Not evidence about this provider at all — a category, from which acceptance is
   * inferred. Airlines take card as a matter of course and do not surcharge a corporate
   * booking, so asking Air Canada whether they accept Visa is a question nobody should
   * spend a morning on. It ranks below every real signal (see `cardStatus`), so an
   * approval or a refusal about *this* airline still decides the row.
   */
  airline?: boolean;
  /**
   * A card has already been created for this provider, at no fee.
   *
   * The strongest evidence there is, and the only kind that is a fact rather than an
   * inference: a Slack approval is a decision to issue a card, an email verdict is what
   * somebody wrote, and a card that exists has been used. It therefore ranks above both
   * in `cardStatus` — see CARDS_CREATED for where the list comes from.
   */
  cardCreated?: boolean;
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
export type CardStatusSource = "manual" | "card" | "slack" | "email" | "airline" | "none";

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
  // Above Slack: an approval says a card should be issued, this says one was.
  if (evidence.cardCreated) {
    return { status: withFee("card_ok"), source: "card", overridden: false };
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
  // Last, so anything actually known about this provider outranks the category.
  if (evidence.airline) {
    return { status: withFee("card_ok"), source: "airline", overridden: false };
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
  /** HOTEL, ACTIVITY, TRANSPORT, RESTAURANT… as classified on the quote. */
  venue_type: string | null;
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
  /** Every venue type this provider has been booked under. */
  venue_types: string[];
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
      types: Set<string>;
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
          venue_types: [],
        },
        amounts: new Map(),
        refs: new Set(),
        aliases: new Set(),
        methods: new Set(),
        types: new Set(),
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
    if (r.venue_type) entry.types.add(r.venue_type.trim().toUpperCase());
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
    p.venue_types = [...entry.types].sort();
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

// ── Airlines ────────────────────────────────────────────────────────────────

/**
 * Carriers whose name carries no airline word at all.
 *
 * Half the ones we book do not: WestJet, IBERIA, Ryanair, Air Transat's "Transat", and
 * Delta's Canadian entity, which is recorded simply as "Delta Canada". A pattern alone
 * would have quietly missed four of the thirteen airlines in this data, and a missed
 * airline is a row somebody chases for no reason. Kept as a plain list because that is
 * what it is — extend it when a new carrier turns up.
 *
 * "delta" leans on the TRANSPORT scope below: Delta Hotels is a Marriott brand and is
 * classified as a hotel, so it can never reach this list.
 */
export const AIRLINE_CARRIERS = [
  "westjet",
  "iberia",
  "ryanair",
  "transat",
  "delta",
  "jetblue",
  "aeromexico",
  "lufthansa",
  "klm",
  "easyjet",
  "porter airlines",
];

/**
 * Providers a card has already been created for, at no fee.
 *
 * The list is finance's own — the cards actually issued to service providers, given as
 * booking/provider pairs and reduced here to the distinct owner codes in them. Eleven lines
 * named only the house (H-) and one only the quote (Q-); those were resolved to their owner
 * through `raw_naboo_data.houses.owner_id` and `quotes.house_id`, one owner each, no
 * ambiguity — so the eight codes that added are in here on the same footing as the rest. A
 * created card is the strongest thing this page can know: an approval in Slack is a
 * decision to issue one, and this is one that exists and has been used. So it decides the
 * status ahead of both Slack and the email scan, and because there is no fee the row
 * answers its own second question — see `nabooPays`, which turns "Card OK and no fee" into
 * a standing yes without asking anybody to confirm it.
 *
 * In code rather than in `provider_card_terms` for two reasons. It is evidence, not a
 * decision, and evidence belongs with the other derivations where it is reviewable in a
 * diff and cannot be half-applied by a failed migration. And it stays overridable: a
 * stored `accepts_card` or `naboo_pays_card` still wins, so if one of these providers
 * later refuses a card or Pliant declines them, the human answer holds.
 *
 * A recorded fee also still wins. Any provider here with a fee in `provider_card_terms`
 * shows as "Card OK if fee" and returns to the queue as a judgement — which is right: the
 * claim below is "a card was created at no fee", and a fee on file contradicts it.
 *
 * Sorted, one to a line — the formatter's own layout for an array this long, and the one
 * that makes adding a code a one-line diff and a duplicate impossible to miss.
 */
export const CARDS_CREATED: string[] = [
  "O-A014",
  "O-A0357",
  "O-A6468",
  "O-A6587",
  "O-A6655",
  "O-A6801",
  "O-A6993",
  "O-A8518",
  "O-A8866",
  "O-A8982",
  "O-A9998",
  "O-B0181",
  "O-B0183",
  "O-B0306",
  "O-B0446",
  "O-B0753",
  "O-B0939",
  "O-B1073",
  "O-B1429",
  "O-B1466",
  "O-B1523",
  "O-B1649",
  "O-B1977",
  "O-B2163",
  "O-B2550",
  "O-B2923",
  "O-B3137",
  "O-B3398",
  "O-B3843",
  "O-B3846",
  "O-B4363",
  "O-B4399",
  "O-B4494",
  "O-B9120",
  "O-B9240",
  "O-B9275",
  "O-B9366",
  "O-B9418",
  "O-B9530",
  "O-B9591",
  "O-B9625",
  "O-B9695",
  "O-B9721",
  "O-B9776",
  "O-C3411",
  "O-C3452",
  "O-C3454",
  "O-C9683",
  "O-C9690",
  "O-C9780",
  "O-C9868",
  "O-D4721",
  "O-D7871",
  "O-D7927",
  "O-D7928",
  "O-D9031",
  "O-D9053",
  "O-D9126",
  "O-D9146",
  "O-D9193",
  "O-E4896",
  "O-E4913",
  "O-E4925",
  "O-E4953",
  "O-E8821",
  "O-E9369",
  "O-E9427",
  "O-E9606",
  "O-F3850",
  "O-F3958",
  "O-F3962",
  "O-F4045",
  "O-F4050",
  "O-F4140",
  "O-F4248",
  "O-F4261",
  "O-F4262",
  "O-F4271",
  "O-F4318",
  "O-F4325",
  "O-F4328",
  "O-F4381",
  "O-F4406",
  "O-F4411",
  "O-F4415",
  "O-F8275",
  "O-F8278",
  "O-F8286",
  "O-F8373",
  "O-F8522",
  "O-F8539",
  "O-F8554",
  "O-F8676",
  "O-F8884",
  "O-F8926",
  "O-F8929",
  "O-F8980",
  "O-F9027",
  "O-F9156",
  "O-F9157",
  "O-F9187",
  "O-F9276",
  "O-F9350",
  "O-F9380",
  "O-F9709",
  "O-F9851",
  "O-F9936",
  "O-F9937",
  "O-F9943",
  "O-G0090",
  "O-G0276",
  "O-G0938",
  "O-G1074",
  "O-G1539",
  "O-G1629",
  "O-G1858",
  "O-G1860",
  "O-G1861",
  "O-G1862",
  "O-G1863",
  "O-G1942",
  "O-G2013",
  "O-G2018",
  "O-G2080",
  "O-G2372",
  "O-G4053",
  "O-I637",
  "O-J050",
  "O-Q105",
  "O-Q448",
  "O-Q568",
  "O-Q911",
  "O-R360",
  "O-U611",
  "O-U667",
  "O-U733",
  "O-V468",
  "O-V588",
  "O-V653",
  "O-V839",
  "O-V849",
  "O-W438",
  "O-X265",
  "O-X801",
];

const CREATED_CARD_SET = new Set(CARDS_CREATED);

/** Has a card already been created for this provider? Owner code, exactly as BigQuery gives it. */
export function hasCreatedCard(ownerCode: string | null | undefined): boolean {
  return CREATED_CARD_SET.has((ownerCode ?? "").trim());
}

/** "Airlines", "Airways", or "Air" as a word — Air Canada, Delta Air Lines. */
const AIRLINE_WORDS = /\bair\s?lines?\b|\bairways\b|\bair\b/;

/**
 * Is this provider an airline?
 *
 * There is no field for it. `venue_type` is the closest the data comes, and TRANSPORT
 * is far wider than airlines: of the forty transport providers on accepted North
 * American bookings, twenty-seven are coaches, limousines, shuttles, Uber, Via Rail, a
 * freight forwarder, a travel agency — and NABOO GROUP's own entity. Treating the
 * category as a proxy would have assumed card acceptance for all of them, including
 * ourselves.
 *
 * So it is the two together: classified as transport **and** named like a carrier. The
 * scope is what makes the name test safe — measured across all 450 providers, every
 * airline-sounding name in this data is a transport provider, so no hotel or restaurant
 * can match, and it is what lets a bare "delta" be an airline here and nowhere else.
 *
 * A wrong yes is correctable by hand — the manual override outranks this — and shows in
 * the ledger as an assumption rather than as somebody's decision.
 */
export function isAirline(provider: Pick<CardProvider, "provider_name" | "venue_types">): boolean {
  if (!provider.venue_types.includes("TRANSPORT")) return false;
  const name = (provider.provider_name ?? "").toLowerCase();
  if (!name) return false;
  return AIRLINE_WORDS.test(name) || AIRLINE_CARRIERS.some((carrier) => name.includes(carrier));
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
    // The airline flag belongs to the provider, not to the evidence lookup, so it is
    // folded in here rather than travelling over the wire from the server.
    const evidence: CardEvidence = {
      ...(evidenceByOwner.get(provider.owner_code) ?? NO_EVIDENCE),
      airline: isAirline(provider),
      cardCreated: hasCreatedCard(provider.owner_code),
    };
    return { provider, terms, verdict: cardStatus(evidence, terms), evidence };
  });
}

// ── Naboo's own answer ──────────────────────────────────────────────────────

export type NabooDecisionSource = "manual" | "automatic" | "none";

export type NabooDecision = {
  value: CardYesNo | null;
  source: NabooDecisionSource;
};

/**
 * Whether Naboo pays this provider by card, and on whose word.
 *
 * A provider who takes card at no fee is not a decision. Paying by card costs us
 * nothing there and is the outcome this whole page exists to increase, so **yes** is
 * the standing answer and nobody is asked to confirm it. `card_ok` already carries
 * "and no fee": recording a fee promotes the status to `card_ok_if_fee`, which turns
 * the question from "why not?" into "is it worth it?" — a judgement, left to a human.
 *
 * A stored value always wins, in both directions. That includes a stored **no** on a
 * fee-free provider, which is the divergence this page is built to surface — over the
 * card limit, or Pliant refused them before — and it still demands a written reason.
 * Nothing here writes to the database: the default is derived on every read, so a fee
 * arriving later withdraws it rather than leaving a stale "yes" behind that looks like
 * somebody's decision.
 */
export function nabooPays(
  status: CardStatus,
  terms: Pick<CardTerms, "naboo_pays_card">,
): NabooDecision {
  if (terms.naboo_pays_card != null) return { value: terms.naboo_pays_card, source: "manual" };
  if (status === "card_ok") return { value: "yes", source: "automatic" };
  return { value: null, source: "none" };
}

/** The same answer for a whole row. */
export function rowNabooPays(row: CardRow): NabooDecision {
  return nabooPays(row.verdict.status, row.terms);
}

// ── The queue and the ledger ────────────────────────────────────────────────

/**
 * Does this row still need a human?
 *
 * Two shapes: nobody has established whether the provider takes card, or they take it
 * for a fee and nobody has weighed that fee. A fee-free provider answers itself — see
 * `nabooPays` — and everything else has been decided, so both go to the ledger.
 *
 * This is the page's spine — the queue, the count beside it and the KPI all call it, so
 * they cannot disagree about what "open" means. The scope predicate below delegates
 * here for the same reason.
 */
export function needsDecision(row: CardRow): boolean {
  return (
    row.verdict.status === "unknown" ||
    (accepts(row.verdict.status) && rowNabooPays(row).value == null)
  );
}

/** The two zones, in one pass. */
export function partitionRows(rows: CardRow[]): { open: CardRow[]; settled: CardRow[] } {
  const open: CardRow[] = [];
  const settled: CardRow[] = [];
  for (const row of rows) (needsDecision(row) ? open : settled).push(row);
  return { open, settled };
}

export type CardExposure = { currency: string; amount: number; provider: string };

export type CardKpis = {
  /** Open decisions, split by which of the two questions is unanswered. */
  open: { total: number; neverAsked: number; waitingOnUs: number };
  payableByCard: { total: number; withFee: number };
  weDecline: { total: number; withReason: number };
  /**
   * The largest single exposure inside one named currency.
   *
   * The currency is chosen by how many providers carry it, never by size. Picking the
   * biggest number on the page would compare currencies, which is the one thing this
   * data cannot survive: BizAway's 281,000,000 IDR wins that comparison outright and
   * means far less than a six-figure CAD balance. A count is not a comparison of value,
   * so the card lands on the currency the market actually trades in and says which one
   * it is — and a second currency, if it is ever wanted, gets its own card.
   */
  largestExposure: CardExposure | null;
};

/** The currency the most providers are owed in. Ties broken by name, for stability. */
export function dominantCurrency(rows: CardRow[]): string | null {
  const providersPerCurrency = new Map<string, number>();
  for (const row of rows) {
    for (const currency of new Set(row.provider.amounts.map((a) => a.currency))) {
      providersPerCurrency.set(currency, (providersPerCurrency.get(currency) ?? 0) + 1);
    }
  }
  let best: { currency: string; providers: number } | null = null;
  for (const [currency, providers] of [...providersPerCurrency].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (best == null || providers > best.providers) best = { currency, providers };
  }
  return best?.currency ?? null;
}

export function cardKpis(rows: CardRow[]): CardKpis {
  const open = rows.filter(needsDecision);
  const payable = rows.filter((r) => accepts(r.verdict.status));
  const decline = payable.filter((r) => rowNabooPays(r).value === "no");

  const currency = dominantCurrency(rows);
  let largest: CardExposure | null = null;
  for (const row of rows) {
    for (const a of row.provider.amounts) {
      if (a.currency !== currency) continue;
      if (largest == null || Math.abs(a.amount) > Math.abs(largest.amount)) {
        largest = { currency: a.currency, amount: a.amount, provider: row.provider.provider_name };
      }
    }
  }

  return {
    open: {
      total: open.length,
      neverAsked: open.filter((r) => r.verdict.status === "unknown").length,
      waitingOnUs: open.filter((r) => accepts(r.verdict.status)).length,
    },
    payableByCard: {
      total: payable.length,
      withFee: payable.filter((r) => hasFee(r.terms)).length,
    },
    weDecline: {
      total: decline.length,
      withReason: decline.filter((r) => (r.terms.naboo_reason ?? "").trim().length > 0).length,
    },
    largestExposure: largest,
  };
}

/** "4 never asked · 2 waiting on us" — the shape of the backlog, not just its size. */
export function openDecisionsNote(open: CardKpis["open"]): string {
  if (open.total === 0) return "nothing waiting on anyone";
  const parts: string[] = [];
  if (open.neverAsked > 0) parts.push(`${open.neverAsked} never asked`);
  if (open.waitingOnUs > 0) parts.push(`${open.waitingOnUs} waiting on us`);
  return parts.join(" · ");
}

/** How many of the accepting providers charge for it. */
export function payableNote(payable: CardKpis["payableByCard"]): string {
  if (payable.total === 0) return "none established yet";
  if (payable.withFee === 0) return "none of them charge a fee";
  return `${payable.withFee} of them charge a fee`;
}

/**
 * Whether the declines are on the record.
 *
 * A written reason is mandatory on this divergence, so the honest reading of this note
 * is a check that the rule held — it should say all of them, always.
 */
export function declineNote(decline: CardKpis["weDecline"]): string {
  if (decline.total === 0) return "nothing declined that they would accept";
  if (decline.withReason === decline.total) {
    return decline.total === 2 ? "both with a written reason" : "all with a written reason";
  }
  return `${decline.withReason} of ${decline.total} with a written reason`;
}

/**
 * The next move, in prose, for a row in the queue.
 *
 * Deliberately a sentence and not a status: the status says where the row is, this says
 * what to do about it. Null for a settled row, which has no next move.
 */
export function nextMove(row: CardRow): string | null {
  if (!needsDecision(row)) return null;
  if (row.verdict.status === "unknown") {
    return "Never asked — no Slack approval, nothing in the email scan.";
  }
  const pct = row.terms.fee_percent ?? 0;
  if (pct > 0) {
    const fee = Number(pct.toFixed(2)).toString();
    return `They accept at ${fee}% — decide whether the fee is worth it or wire instead.`;
  }
  // A fee-free provider is answered by nabooPays and never arrives here.
  return "Fee recorded, nobody has said yes or no on our side.";
}

/** Where the status came from, in three or four words. */
export function provenance(row: CardRow): string {
  switch (row.verdict.source) {
    case "card":
      return "Card already created";
    case "slack":
      return "Approved card in Slack";
    case "email":
      return "From the email scan";
    case "manual":
      return "Set by hand";
    case "airline":
      return "Airlines take card";
    default:
      return "Never asked";
  }
}

/**
 * The card question, as an email to the provider.
 *
 * Pure so the wording is reviewable without a mailbox. Sent through the same Gmail
 * draft path the other trackers use, so it lands in the sender's own drafts for a read
 * before it goes.
 */
export function cardOutreach(provider: Pick<CardProvider, "provider_name" | "bookings">): {
  subject: string;
  body: string;
} {
  return {
    subject: `Card payment for your upcoming Naboo booking${
      provider.bookings > 1 ? "s" : ""
    } — ${provider.provider_name}`,
    body: `Hi,

Hope you're doing well! ☀️

We are settling ${pluralise(provider.bookings, "booking")} with you and would like to pay by corporate credit card if that works on your side.

Two questions:

• Do you accept payment by credit card?
• If you do, is there a card fee — a percentage, a flat amount, or both?

If card is not an option we will arrange a bank transfer instead, so either answer is fine — we just need to know which.

Thanks so much!`,
  };
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
    hint: "Status unknown, or they charge a fee and nobody has weighed it",
    // The queue, the count and the KPI all read this through needsDecision above.
    match: needsDecision,
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
    match: (r) => accepts(r.verdict.status) && rowNabooPays(r).value === "no",
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

/**
 * A headline figure: grouped, no cents.
 *
 * The KPI band is read at a glance and two decimal places on a six-figure balance are
 * noise there. Every other amount on the page keeps its cents.
 */
export function fmtRound(amount: number): string {
  return Math.round(amount).toLocaleString("en-US");
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

/**
 * The answer as the CSV states it.
 *
 * The effective value, because a reconciliation that read "" for a provider we do pay
 * by card would be wrong — and marked, because "who decided this?" has a different
 * answer when nobody did.
 */
function nabooPaysCell(row: CardRow): string {
  const decision = rowNabooPays(row);
  if (decision.value == null) return "";
  return decision.source === "automatic" ? `${decision.value} (automatic)` : decision.value;
}

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
    nabooPaysCell(r),
    r.terms.naboo_reason ?? "",
    r.terms.updated_by ?? "",
    r.terms.updated_at ?? "",
  ]);
}
