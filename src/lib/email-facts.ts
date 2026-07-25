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

const ASK_CARD =
  /(paiement|pay(er|é|ment)?|r[èe]glement|r[ée]gler)\s+(par\s+)?(carte|cb|credit\s+card)|(carte|credit\s+card)\s+(de\s+)?(cr[ée]dit|bancaire)?\s*(possible|accept)/i;

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
const CARD_YES =
  /(accept|possible|ok|d'accord|d’accord|oui|sans\s+probl[èe]me|pas\s+de\s+probl[èe]me|convient|fine|works|we\s+can)/i;
const CARD_NO =
  /(n'accept|n’accept|pas\s+accept|refus|impossible|malheureusement|ne\s+prenons\s+pas|do\s+not\s+accept|don'?t\s+accept|cannot\s+accept|virement\s+(uniquement|seulement|obligatoire)|only\s+(by\s+)?(bank\s+)?transfer|transfer\s+only|ch[èe]que\s+uniquement)/i;

/** Looks for the card verdict in the sentence(s) that mention a card at all. */
function cardVerdict(text: string): CardState {
  const sentences = text.split(/(?<=[.!?\n])/);
  let verdict: CardState = "unknown";
  for (const sentence of sentences) {
    if (!CARD_WORD.test(sentence)) continue;
    // A refusal is the more consequential reading, so it wins within a sentence.
    if (CARD_NO.test(sentence)) return "refused";
    if (CARD_YES.test(sentence)) verdict = "accepted";
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
export function extractFacts(
  messages: MessageInput[],
  selfAddress: string,
): ExtractedFacts {
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
      if (ASK_CARD.test(text)) signals.add("card:asked");
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
