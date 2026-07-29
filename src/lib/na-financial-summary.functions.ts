/**
 * AI-written financial summary of a partner's email thread (Marketplace NA).
 *
 * Unlike partner_email_facts (derived yes/no verdicts only, no content ever
 * persisted), this reads the actual thread from the caller's own mailbox and
 * asks an LLM to paraphrase the financial parts of it, then stores that
 * paraphrase — shared with the whole team on purpose, so a colleague without
 * Gmail access still sees why a booking is flagged. Generated on click, never
 * automatically, and only for the one partner being looked at.
 */
import { createServerFn } from "@tanstack/react-start";

export type NaFinancialSummary = {
  event_ref: string;
  partner_key: string;
  partner_name: string | null;
  summary: string;
  message_count: number;
  generated_at: string | null;
  generated_by: string | null;
};

/** Shared, readable by any signed-in user — same principle as partner_email_facts. */
export const fetchNaFinancialSummaries = createServerFn({ method: "GET" }).handler(
  async (): Promise<NaFinancialSummary[]> => {
    const { requireTracker } = await import("./session.server");
    await requireTracker("na");
    const { db, isoOrNull } = await import("./db.server");
    const sql = await db();
    const rows = await sql<Record<string, unknown>[]>`
      SELECT event_ref, partner_key, partner_name, summary, message_count, generated_at, generated_by
      FROM na_financial_summary
    `;
    return rows.map((r) => ({
      ...r,
      generated_at: isoOrNull(r.generated_at),
    })) as NaFinancialSummary[];
  },
);

function buildPrompt(
  partnerName: string,
  messages: Array<{ outbound: boolean; at: string; subject: string; body: string }>,
): string {
  const thread = messages
    .map((m) => {
      const who = m.outbound ? "Naboo" : partnerName;
      const date = m.at.slice(0, 10);
      // Cap each message so one very long email cannot crowd out the rest of the thread.
      const body = m.body.slice(0, 3000);
      return `[${date}] ${who} — ${m.subject}\n${body}`;
    })
    .join("\n\n---\n\n")
    .slice(0, 12_000);

  return `You are helping a finance team track a marketplace booking. Below is an email thread between Naboo and a service provider ("${partnerName}").

Summarize ONLY the financially relevant parts: amounts confirmed, disputed, or still pending (commission, refund, invoice, payout), payment method or bank details status, and any explicit commitments or dates. Write 2-4 plain sentences, no markdown, no bullet points. If nothing financially relevant was discussed, say so plainly instead of inventing anything.

Thread:
${thread}`;
}

export const generateNaFinancialSummary = createServerFn({ method: "POST" })
  .validator((input: { event_ref: string; partner_name: string; partner_email: string | null }) => {
    if (!input?.event_ref) throw new Error("event_ref is required");
    if (!input?.partner_name) throw new Error("partner_name is required");
    return {
      event_ref: input.event_ref,
      partner_name: input.partner_name,
      partner_email:
        typeof input.partner_email === "string" && input.partner_email.includes("@")
          ? input.partner_email
          : null,
    };
  })
  .handler(async ({ data }): Promise<NaFinancialSummary> => {
    const { requireTracker } = await import("./session.server");
    const session = await requireTracker("na");
    const { scanEventPartners } = await import("./gmail.server");
    const { partnerKey } = await import("./annotations.functions");

    const key = partnerKey(data.partner_name || data.partner_email || "");
    const [result] = await scanEventPartners(session.email, data.event_ref, [
      { partnerKey: key, partnerName: data.partner_name, address: data.partner_email },
    ]);

    const messageCount = result?.messages.length ?? 0;
    let summary: string;
    if (messageCount === 0) {
      summary = "No email exchange found with this partner for this event.";
    } else {
      const { generateText } = await import("ai");
      const { text } = await generateText({
        model: "anthropic/claude-sonnet-5",
        prompt: buildPrompt(data.partner_name, result.messages),
      });
      summary = text.trim();
    }

    const { db } = await import("./db.server");
    const sql = await db();
    await sql`
      INSERT INTO na_financial_summary (event_ref, partner_key, partner_name, summary, message_count, generated_at, generated_by)
      VALUES (${data.event_ref}, ${key}, ${data.partner_name}, ${summary}, ${messageCount}, now(), ${session.email})
      ON CONFLICT (event_ref, partner_key) DO UPDATE SET
        partner_name = EXCLUDED.partner_name,
        summary = EXCLUDED.summary,
        message_count = EXCLUDED.message_count,
        generated_at = now(),
        generated_by = EXCLUDED.generated_by
    `;

    return {
      event_ref: data.event_ref,
      partner_key: key,
      partner_name: data.partner_name,
      summary,
      message_count: messageCount,
      generated_at: new Date().toISOString(),
      generated_by: session.email,
    };
  });
