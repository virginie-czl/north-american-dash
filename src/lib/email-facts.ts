/**
 * Derives partner-onboarding facts from email text.
 *
 * Deliberately pure and dependency-free so it can be reasoned about and tested
 * without touching Gmail. The rules are heuristics over the vocabulary Naboo's
 * finance team actually uses (FR + EN) plus a few high-confidence identifier
 * formats; they are meant to be tuned against real mail, not treated as truth.
 *
 * Direction matters: vocabulary in a message *we* sent means "asked", the same
 * vocabulary (or an identifier) coming *from* the partner means "received".
 *
 * Card is the one fact that also reads silence. Everywhere else, not finding the
 * vocabulary just leaves the state at its default — but once we have directly
 * asked a partner whether they take card, a reply that neither says yes nor sends
 * a way to charge one (a payment link) *is* the answer: bank details, a shrug, a
 * reply about something else entirely all mean no in practice, because a partner
 * who takes card says so or sends the link. So a reply after the ask that carries
 * no explicit acceptance resolves to `refused`, not `unknown` — see the bottom of
 * `extractFacts`. Silence with **no reply at all** stays `unknown`: they have not
 * been given the chance to answer yet.
 */

export type AskState = "not_asked" | "asked" | "received";
export type CardState = "unknown" | "accepted" | "refused";

export type MessageInput = {
  /** true when the message was sent by us. */
  outbound: boolean;
  at: string;
  from: string;
  subject: string;
  body: string;
  attachmentNames?: string[];
};

export type ExtractedFacts = {
  contactedAt: string | null;
  contactedBy: string | null;
  repliedAt: string | null;
  bankDetails: AskState;
  bankAskedAt: string | null;
  bankAskedBy: string | null;
  bankReceivedAt: string | null;
  taxInfo: AskState;
  taxAskedAt: string | null;
  taxAskedBy: string | null;
  taxReceivedAt: string | null;
  cardPayment: CardState;
  cardDecidedAt: string | null;
  /** Rule names that fired — returned to the scanning user only, never stored. */
  signals: string[];
};

// --- Vocabulary -------------------------------------------------------------

const ASK_BANK =
  /(coordonn[ée]es|d[ée]tails|informations?|infos?)\s+bancaires?|\bRIB\b|\bIBAN\b|bank(ing)?\s+(details|information|info|account)|wire\s+(details|information|instructions)|void\s+ch[e|è]que|sp[ée]cimen\s+de\s+ch[èe]que|direct\s+deposit\s+form|d[ée]p[ôo]t\s+direct/i;

const ASK_TAX =
  /num[ée]ros?\s+(de\s+)?(tva|tps|tvq|gst|qst|hst)|\b(tps|tvq|gst|qst|hst)\b\s*(\/|et|and)?\s*(tps|tvq|gst|qst|hst)?\s*(number|num[ée]ro)?|tax\s+(id|number|information|info|details)|\bw-?9\b|\bw-?8\s?ben\b|business\s+number|num[ée]ro\s+d('|’)entreprise|\bNEQ\b|num[ée]ro\s+de\s+taxes?/i;

const ASK_CARD_PATTERNS = [
  // French
  /(paiement|pay(er|é|ment)?|r[èe]glement|r[ée]gler)\s+(par\s+)?(carte|cb|credit\s+card)/i,
  /(carte|credit\s+card)\s+(de\s+)?(cr[ée]dit|bancaire)?\s*(possible|accept)/i,
  // English — order-flexible, since "accept ... card" and "card ... accepted" are
  // both common and the French patterns above assume the French word order.
  /\b(accept|take)s?\b[^.!?\n]{0,40}(payment\s+(by|via|with)\s+)?(credit\s+cards?|\bcards?\b)/i,
  /\bpay\b[^.!?\n]{0,10}(by|via|with)[^.!?\n]{0,20}(credit\s+cards?|\bcards?\b)/i,
];

function asksAboutCard(text: string): boolean {
  return ASK_CARD_PATTERNS.some((re) => re.test(text));
}

// --- High-confidence identifier formats -------------------------------------

/** IBAN: 2 letters, 2 check digits, then 10–30 alphanumerics. */
const IBAN = /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/;
/** Canadian bank coordinates: transit (5) + institution (3) + account. */
const CA_BANK =
  /\b(transit|institution)\b[^\n]{0,40}\d{3,5}|\bnum[ée]ro\s+de\s+compte\b|\baccount\s+(number|no\.?)\b[^\n]{0,20}\d{5,}/i;
/** GST/BN business number: 9 digits + RT + 4 digits. */
const GST_BN = /\b\d{9}\s?RT\s?\d{4}\b/i;
/** Quebec QST: 10 digits + TQ + 4 digits. */
const TVQ = /\b\d{10}\s?TQ\s?\d{4}\b/i;
/** EU VAT. */
const EU_VAT = /\b(FR|BE|DE|ES|IT|NL|LU|IE|PT|AT|PL)\s?\d{8,12}\b/;

const ATTACH_BANK = /rib|iban|bank|banc|ch[èe]que|cheque|deposit|d[ée]p[ôo]t|void/i;
const ATTACH_TAX = /w-?9|w-?8|tax|tva|tps|tvq|gst|qst|attestation/i;

// --- Card polarity ----------------------------------------------------------

const CARD_WORD = /(carte|credit\s+card|\bcb\b|\bcard\b)/i;

/**
 * Explicit acceptance only. Loose matching produced false positives — "le paiement
 * par carte serait possible" or our own question echoed in a reply both read as a
 * yes under keyword matching. A card verdict changes whether we ever ask for an
 * IBAN, so it has to be earned: an affirmative directed at the card, from them.
 */
const CARD_YES_EXPLICIT = [
  // French
  /\b(oui|d'accord|d’accord|parfait|tr[èe]s bien|c'est bon|c’est bon)\b[^.!?\n]{0,60}(carte|cb\b)/i,
  /(carte|cb\b)[^.!?\n]{0,60}\b(nous convient|me convient|convient|c'est parfait|c’est parfait|pas de probl[èe]me|sans probl[èe]me|aucun probl[èe]me)\b/i,
  /\bnous (acceptons|prenons|pouvons accepter)\b[^.!?\n]{0,40}(carte|cb\b)/i,
  /\b(vous pouvez|tu peux|possible de)\s+(donc\s+)?(nous\s+)?(r[ée]gler|payer)\b[^.!?\n]{0,40}(par\s+)?(carte|cb\b)/i,
  /(carte|cb\b)[^.!?\n]{0,40}\baccept[ée]e?\b/i,
  // English
  /\b(yes|sure|absolutely|that works|works for us|happy to)\b[^.!?\n]{0,60}(credit\s+card|\bcard\b)/i,
  /\bwe (accept|can accept|do accept|take)\b[^.!?\n]{0,40}(credit\s+cards?|\bcards?\b)/i,
  /(credit\s+card|\bcard\b)[^.!?\n]{0,40}\b(is fine|works|is accepted|no problem)\b/i,
];

const CARD_NO =
  /(n'accept|n’accept|pas\s+accept|refus|impossible|malheureusement|ne\s+prenons\s+pas|do\s+not\s+accept|don'?t\s+accept|cannot\s+accept|unable\s+to\s+accept|virement\s+(uniquement|seulement|obligatoire)|only\s+(by\s+)?(bank\s+)?transfer|transfer\s+only|ch[èe]que\s+uniquement)/i;

/**
 * A hosted payment page — the one thing that is stronger evidence than words: a
 * partner cannot send a link that charges a card without being able to take one.
 * Scoped to the gateways Naboo's partners actually use, not a bare "http" test,
 * so an unrelated link in the same message (a quote, a brochure) never counts.
 */
const PAYMENT_LINK =
  /https?:\/\/\S*(buy\.stripe\.com|invoice\.stripe\.com|checkout\.stripe\.com|paypal\.me|paypal\.com\/(invoice|checkoutnow)|squareup\.com|checkout\.square\.site|square\.link)\S*|\b(payment|checkout)\s+link\b|\blien\s+de\s+paiement\b/i;

/**
 * Looks for the card verdict in sentences that mention a card. A refusal wins over
 * an acceptance in the same sentence, and acceptance requires one of the explicit
 * patterns above rather than any nearby positive word.
 *
 * A payment link decides the message on its own, checked over the whole text rather
 * than sentence by sentence — the link is rarely in the same sentence as the word
 * "card" at all ("Here's the link: https://buy.stripe.com/..."), so the per-sentence
 * `CARD_WORD` gate below would otherwise miss it.
 */
function cardVerdict(text: string): CardState {
  if (PAYMENT_LINK.test(text)) return "accepted";
  const sentences = text.split(/(?<=[.!?\n])/);
  let verdict: CardState = "unknown";
  for (const sentence of sentences) {
    if (!CARD_WORD.test(sentence)) continue;
    if (CARD_NO.test(sentence)) return "refused";
    if (CARD_YES_EXPLICIT.some((re) => re.test(sentence))) verdict = "accepted";
  }
  return verdict;
}

function newer(a: string | null, b: string): boolean {
  return a == null || b > a;
}

/**
 * Folds a partner's messages (any order) into a single set of facts.
 * `selfAddress` is the mailbox owner, used as a fallback attribution.
 */
export function extractFacts(messages: MessageInput[], selfAddress: string): ExtractedFacts {
  const facts: ExtractedFacts = {
    contactedAt: null,
    contactedBy: null,
    repliedAt: null,
    bankDetails: "not_asked",
    bankAskedAt: null,
    bankAskedBy: null,
    bankReceivedAt: null,
    taxInfo: "not_asked",
    taxAskedAt: null,
    taxAskedBy: null,
    taxReceivedAt: null,
    cardPayment: "unknown",
    cardDecidedAt: null,
    signals: [],
  };
  const signals = new Set<string>();
  // The earliest time we asked about card — used below to find a reply that had the
  // chance to answer but didn't say yes. Earliest, not latest: a partner who never
  // accepted across a whole thread of asks and replies is still a no.
  let cardAskedAt: string | null = null;

  for (const m of messages) {
    const text = `${m.subject}\n${m.body}`;
    const attachments = (m.attachmentNames ?? []).join(" ");

    if (m.outbound) {
      if (newer(facts.contactedAt, m.at)) {
        facts.contactedAt = m.at;
        facts.contactedBy = m.from || selfAddress;
      }
      if (ASK_BANK.test(text) && newer(facts.bankAskedAt, m.at)) {
        facts.bankAskedAt = m.at;
        facts.bankAskedBy = m.from || selfAddress;
        signals.add("bank:asked");
      }
      if (ASK_TAX.test(text) && newer(facts.taxAskedAt, m.at)) {
        facts.taxAskedAt = m.at;
        facts.taxAskedBy = m.from || selfAddress;
        signals.add("tax:asked");
      }
      if (asksAboutCard(text)) {
        signals.add("card:asked");
        if (cardAskedAt == null || m.at < cardAskedAt) cardAskedAt = m.at;
      }
    } else {
      if (newer(facts.repliedAt, m.at)) facts.repliedAt = m.at;

      const bankIdentifier =
        IBAN.test(m.body) || CA_BANK.test(text) || ATTACH_BANK.test(attachments);
      if (bankIdentifier && newer(facts.bankReceivedAt, m.at)) {
        facts.bankReceivedAt = m.at;
        signals.add("bank:received");
      }

      const taxIdentifier =
        GST_BN.test(text) || TVQ.test(text) || EU_VAT.test(text) || ATTACH_TAX.test(attachments);
      if (taxIdentifier && newer(facts.taxReceivedAt, m.at)) {
        facts.taxReceivedAt = m.at;
        signals.add("tax:received");
      }

      const verdict = cardVerdict(text);
      if (verdict !== "unknown" && newer(facts.cardDecidedAt, m.at)) {
        facts.cardPayment = verdict;
        facts.cardDecidedAt = m.at;
        signals.add(`card:${verdict}`);
      }
    }
  }

  // Nothing explicit was said either way, but they were asked directly and have
  // since replied — bank details, a different topic, no answer at all on card. In
  // practice that reply is the no: a partner who takes card says so or sends a link,
  // so anything else, once asked, resolves the same way. Silence with no reply yet
  // is left at `unknown` — they have not had the chance to answer.
  if (facts.cardPayment === "unknown" && cardAskedAt != null) {
    const repliesAfterAsk = messages
      .filter((m) => !m.outbound && m.at > cardAskedAt!)
      .map((m) => m.at)
      .sort();
    const lastReply = repliesAfterAsk[repliesAfterAsk.length - 1];
    if (lastReply != null) {
      facts.cardPayment = "refused";
      facts.cardDecidedAt = lastReply;
      signals.add("card:refused_implicit");
    }
  }

  facts.bankDetails =
    facts.bankReceivedAt != null ? "received" : facts.bankAskedAt != null ? "asked" : "not_asked";
  facts.taxInfo =
    facts.taxReceivedAt != null ? "received" : facts.taxAskedAt != null ? "asked" : "not_asked";
  facts.signals = [...signals];
  return facts;
}

/** Deal codes look like F-B694 / C-V785 / NABI-FR26-01962. */
export function dealCodePattern(ref: string): string {
  return ref.trim();
}
