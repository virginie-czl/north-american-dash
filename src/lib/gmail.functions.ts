/**
 * Gmail server functions exposed to the tracker UI.
 *
 * Every call resolves the mailbox from the caller's own session — a user can only
 * ever reach their own Gmail, never a colleague's, even though the tracker itself
 * is shared.
 */
import { createServerFn } from "@tanstack/react-start";

export type PartnerEmailStatus = {
  address: string;
  subject: string;
  lastAt: string;
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
  /** True when their most recent message is newer than ours. */
  replied: boolean;
  link: string;
};

export const lookupPartnerEmails = createServerFn({ method: "GET" })
  .validator((input: { addresses: string[] }) => {
    if (!Array.isArray(input?.addresses)) throw new Error("addresses is required");
    const addresses = input.addresses
      .filter((a): a is string => typeof a === "string" && a.includes("@"))
      .slice(0, 12);
    return { addresses };
  })
  .handler(async ({ data }): Promise<PartnerEmailStatus[]> => {
    if (data.addresses.length === 0) return [];
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { findContactThreads } = await import("./gmail.server");
    const threads = await findContactThreads(session.email, data.addresses);
    return threads.map((t) => ({
      address: t.address,
      subject: t.subject,
      lastAt: t.lastAt,
      lastOutboundAt: t.lastOutboundAt,
      lastInboundAt: t.lastInboundAt,
      replied:
        t.lastInboundAt != null &&
        (t.lastOutboundAt == null || t.lastInboundAt > t.lastOutboundAt),
      link: t.link,
    }));
  });

function validateMessage(input: { to: string; subject: string; body: string }) {
  const to = typeof input?.to === "string" ? input.to.trim() : "";
  const subject = typeof input?.subject === "string" ? input.subject.trim() : "";
  const body = typeof input?.body === "string" ? input.body.trim() : "";
  if (!to.includes("@")) throw new Error("A valid recipient address is required");
  if (!subject) throw new Error("A subject is required");
  if (!body) throw new Error("A message body is required");
  if (body.length > 20_000) throw new Error("Message is too long");
  // One recipient per call: no accidental bulk sends from a finance tool.
  if (/[,;]/.test(to)) throw new Error("Send to one recipient at a time");
  return { to, subject, body };
}

export const draftPartnerEmail = createServerFn({ method: "POST" })
  .validator(validateMessage)
  .handler(async ({ data }): Promise<{ draftId: string; link: string }> => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { createDraft } = await import("./gmail.server");
    return createDraft(session.email, data.to, data.subject, data.body);
  });

export const sendPartnerEmail = createServerFn({ method: "POST" })
  .validator(validateMessage)
  .handler(async ({ data }): Promise<{ messageId: string; threadId: string }> => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { sendMessage } = await import("./gmail.server");
    return sendMessage(session.email, data.to, data.subject, data.body);
  });

// ---------------------------------------------------------------------------
// Partner fact scanning
//
// Scanning reads the caller's own mailbox and stores only the derived verdicts
// (contacted / replied / bank / tax / card, with dates and who acted). No subject,
// body or snippet is ever persisted, so every tracker user can read the stickers
// without gaining access to anyone's correspondence.
// ---------------------------------------------------------------------------

export type PartnerFacts = {
  event_ref: string;
  partner_key: string;
  partner_name: string | null;
  matched_by: "email" | "deal_code" | "none";
  contacted_at: string | null;
  contacted_by: string | null;
  replied_at: string | null;
  bank_details: "not_asked" | "asked" | "received";
  bank_asked_at: string | null;
  bank_asked_by: string | null;
  bank_received_at: string | null;
  tax_info: "not_asked" | "asked" | "received";
  tax_asked_at: string | null;
  tax_asked_by: string | null;
  tax_received_at: string | null;
  card_payment: "unknown" | "accepted" | "refused";
  card_decided_at: string | null;
  message_count: number;
  scanned_at: string | null;
  scanned_by: string | null;
};

/**
 * Readable by any signed-in user — these are shared verdicts, not mail.
 * PartnerFacts deliberately has no thread id, link, subject or snippet field:
 * that is what keeps it safe to expose to the whole team.
 */
export const fetchPartnerFacts = createServerFn({ method: "GET" }).handler(
  async (): Promise<PartnerFacts[]> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { db, isoOrNull } = await import("./db.server");
    const sql = await db();
    const rows = await sql<Record<string, unknown>[]>`
      SELECT event_ref, partner_key, partner_name, matched_by,
             contacted_at, contacted_by, replied_at,
             bank_details, bank_asked_at, bank_asked_by, bank_received_at,
             tax_info, tax_asked_at, tax_asked_by, tax_received_at,
             card_payment, card_decided_at,
             message_count, scanned_at, scanned_by
      FROM partner_email_facts
    `;
    const dateKeys = [
      "contacted_at",
      "replied_at",
      "bank_asked_at",
      "bank_received_at",
      "tax_asked_at",
      "tax_received_at",
      "card_decided_at",
      "scanned_at",
    ];
    return rows.map((r) => {
      const out = { ...r } as Record<string, unknown>;
      for (const k of dateKeys) out[k] = isoOrNull(r[k]);
      return out as PartnerFacts;
    });
  },
);

export type ScanEventInput = {
  event_ref: string;
  partners: Array<{ name: string; email: string | null }>;
};

export type ScanOutcome = {
  event_ref: string;
  partner_key: string;
  partner_name: string;
  matched_by: "email" | "deal_code" | "none";
  message_count: number;
  /** Rule names that fired — shown to the scanning user only, never stored. */
  signals: string[];
};

/**
 * Scans a small batch of events. The client calls this repeatedly with chunks so
 * each request stays short and the user sees progress, rather than one long
 * request that risks a serverless timeout.
 */
export const scanEventsForFacts = createServerFn({ method: "POST" })
  .validator((input: { events: ScanEventInput[] }) => {
    if (!Array.isArray(input?.events)) throw new Error("events is required");
    const events = input.events
      .filter((e) => e && typeof e.event_ref === "string" && e.event_ref.length > 0)
      .slice(0, 5) // hard cap per request
      .map((e) => ({
        event_ref: e.event_ref,
        partners: (Array.isArray(e.partners) ? e.partners : [])
          .slice(0, 10)
          .map((p) => ({
            name: typeof p?.name === "string" ? p.name : "",
            email: typeof p?.email === "string" && p.email.includes("@") ? p.email : null,
          }))
          .filter((p) => p.name || p.email),
      }));
    return { events };
  })
  .handler(async ({ data }): Promise<ScanOutcome[]> => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { scanEventPartners } = await import("./gmail.server");
    const { extractFacts } = await import("./email-facts");
    const { partnerKey } = await import("./annotations.functions");
    const { db } = await import("./db.server");
    const sql = await db();
    const outcomes: ScanOutcome[] = [];

    for (const event of data.events) {
      const targets = event.partners.map((p) => ({
        partnerKey: partnerKey(p.name || p.email || ""),
        partnerName: p.name || p.email || "",
        address: p.email,
      }));
      if (targets.length === 0) continue;

      const scanned = await scanEventPartners(session.email, event.event_ref, targets);

      for (const result of scanned) {
        const facts = extractFacts(result.messages, session.email);
        await sql`
          INSERT INTO partner_email_facts (
            event_ref, partner_key, partner_name, matched_by,
            contacted_at, contacted_by, replied_at,
            bank_details, bank_asked_at, bank_asked_by, bank_received_at,
            tax_info, tax_asked_at, tax_asked_by, tax_received_at,
            card_payment, card_decided_at,
            message_count, scanned_at, scanned_by
          ) VALUES (
            ${event.event_ref}, ${result.partnerKey}, ${result.partnerName}, ${result.matchedBy},
            ${facts.contactedAt}, ${facts.contactedBy}, ${facts.repliedAt},
            ${facts.bankDetails}, ${facts.bankAskedAt}, ${facts.bankAskedBy}, ${facts.bankReceivedAt},
            ${facts.taxInfo}, ${facts.taxAskedAt}, ${facts.taxAskedBy}, ${facts.taxReceivedAt},
            ${facts.cardPayment}, ${facts.cardDecidedAt},
            ${result.messageCount}, now(), ${session.email}
          )
          ON CONFLICT (event_ref, partner_key) DO UPDATE SET
            partner_name = EXCLUDED.partner_name,
            matched_by = EXCLUDED.matched_by,
            -- Keep the earliest known contact and the latest of everything else,
            -- so one person's scan never erases what another's found.
            contacted_at = LEAST(
              COALESCE(partner_email_facts.contacted_at, EXCLUDED.contacted_at),
              COALESCE(EXCLUDED.contacted_at, partner_email_facts.contacted_at)
            ),
            contacted_by = COALESCE(EXCLUDED.contacted_by, partner_email_facts.contacted_by),
            replied_at = GREATEST(
              COALESCE(partner_email_facts.replied_at, EXCLUDED.replied_at),
              COALESCE(EXCLUDED.replied_at, partner_email_facts.replied_at)
            ),
            bank_details = CASE
              WHEN EXCLUDED.bank_details = 'received' OR partner_email_facts.bank_details = 'received'
                THEN 'received'
              WHEN EXCLUDED.bank_details = 'asked' OR partner_email_facts.bank_details = 'asked'
                THEN 'asked'
              ELSE 'not_asked' END,
            bank_asked_at = COALESCE(partner_email_facts.bank_asked_at, EXCLUDED.bank_asked_at),
            bank_asked_by = COALESCE(partner_email_facts.bank_asked_by, EXCLUDED.bank_asked_by),
            bank_received_at = COALESCE(EXCLUDED.bank_received_at, partner_email_facts.bank_received_at),
            tax_info = CASE
              WHEN EXCLUDED.tax_info = 'received' OR partner_email_facts.tax_info = 'received'
                THEN 'received'
              WHEN EXCLUDED.tax_info = 'asked' OR partner_email_facts.tax_info = 'asked'
                THEN 'asked'
              ELSE 'not_asked' END,
            tax_asked_at = COALESCE(partner_email_facts.tax_asked_at, EXCLUDED.tax_asked_at),
            tax_asked_by = COALESCE(partner_email_facts.tax_asked_by, EXCLUDED.tax_asked_by),
            tax_received_at = COALESCE(EXCLUDED.tax_received_at, partner_email_facts.tax_received_at),
            card_payment = CASE
              WHEN EXCLUDED.card_payment <> 'unknown' THEN EXCLUDED.card_payment
              ELSE partner_email_facts.card_payment END,
            card_decided_at = COALESCE(EXCLUDED.card_decided_at, partner_email_facts.card_decided_at),
            message_count = EXCLUDED.message_count,
            scanned_at = now(),
            scanned_by = EXCLUDED.scanned_by
        `;
        outcomes.push({
          event_ref: event.event_ref,
          partner_key: result.partnerKey,
          partner_name: result.partnerName,
          matched_by: result.matchedBy,
          message_count: result.messageCount,
          signals: facts.signals,
        });
      }
    }
    return outcomes;
  });

// ---------------------------------------------------------------------------
// Batch requests to providers
//
// Sent one at a time, sequentially, with a per-recipient result. A partial failure
// must be visible: knowing that 11 of 14 went out, and which three did not, is the
// difference between a usable tool and one you cannot trust with a chase round.
// ---------------------------------------------------------------------------

export type OutgoingMessage = { to: string; subject: string; body: string };

export type BatchResult = {
  to: string;
  ok: boolean;
  /** Present on success when drafting. */
  link?: string;
  error?: string;
};

function validateBatch(input: { messages: OutgoingMessage[]; mode: "draft" | "send" }) {
  if (!Array.isArray(input?.messages)) throw new Error("messages is required");
  if (input.mode !== "draft" && input.mode !== "send") throw new Error("Invalid mode");
  const seen = new Set<string>();
  const messages = input.messages
    .map((m) => ({
      to: typeof m?.to === "string" ? m.to.trim() : "",
      subject: typeof m?.subject === "string" ? m.subject.trim() : "",
      body: typeof m?.body === "string" ? m.body.trim() : "",
    }))
    .filter((m) => {
      if (!m.to.includes("@") || /[,;]/.test(m.to)) return false;
      if (!m.subject || !m.body || m.body.length > 20_000) return false;
      // One message per address per run, whatever the caller sent.
      const key = m.to.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (messages.length === 0) throw new Error("Aucun destinataire valide");
  if (messages.length > 60) throw new Error("Trop de destinataires en une fois (60 maximum)");
  return { messages, mode: input.mode };
}

export const sendPartnerRequests = createServerFn({ method: "POST" })
  .validator(validateBatch)
  .handler(async ({ data }): Promise<BatchResult[]> => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { createDraft, sendMessage } = await import("./gmail.server");

    const results: BatchResult[] = [];
    for (const message of data.messages) {
      try {
        if (data.mode === "draft") {
          const draft = await createDraft(session.email, message.to, message.subject, message.body);
          results.push({ to: message.to, ok: true, link: draft.link });
        } else {
          await sendMessage(session.email, message.to, message.subject, message.body);
          results.push({ to: message.to, ok: true });
        }
      } catch (error) {
        // Keep going: one bad address should not abort the rest of the round.
        results.push({ to: message.to, ok: false, error: String((error as Error).message) });
      }
    }
    return results;
  });
