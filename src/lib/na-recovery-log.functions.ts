/**
 * A record of the recovery emails already sent on Marketplace NA.
 *
 * The tracker decides who to chase from the amounts alone, and those do not
 * move until the partner actually pays — so a commission asked for in July was
 * still being offered as "Ask for the commission" in August, with no sign it had
 * ever gone out. This is that sign.
 *
 * Only the fact of the ask is kept: event, partner, which of the three emails,
 * when, how many times and by whom. No subject or body, same principle as
 * partner_email_facts — so the whole team sees the state without anyone gaining
 * access to a colleague's correspondence.
 */
import { createServerFn } from "@tanstack/react-start";

export type NaRecoveryRequest = {
  event_ref: string;
  partner_key: string;
  partner_name: string | null;
  mode: string;
  sent_to: string | null;
  first_asked_at: string | null;
  last_asked_at: string | null;
  times_asked: number;
  last_asked_by: string | null;
};

export const fetchNaRecoveryRequests = createServerFn({ method: "GET" }).handler(
  async (): Promise<NaRecoveryRequest[]> => {
    const { requireTracker } = await import("./session.server");
    await requireTracker("na");
    const { db, isoOrNull } = await import("./db.server");
    const sql = await db();
    const rows = await sql<Record<string, unknown>[]>`
      SELECT event_ref, partner_key, partner_name, mode, sent_to,
             first_asked_at, last_asked_at, times_asked, last_asked_by
      FROM na_recovery_request
    `;
    return rows.map((r) => ({
      ...r,
      first_asked_at: isoOrNull(r.first_asked_at),
      last_asked_at: isoOrNull(r.last_asked_at),
    })) as NaRecoveryRequest[];
  },
);

export type RecordedAsk = {
  event_ref: string;
  partner_key: string;
  partner_name: string | null;
  mode: string;
  sent_to: string | null;
};

export const recordNaRecoveryRequests = createServerFn({ method: "POST" })
  .validator((input: { rows: RecordedAsk[] }) => {
    if (!Array.isArray(input?.rows)) throw new Error("rows is required");
    const rows = input.rows
      .filter(
        (r) =>
          typeof r?.event_ref === "string" &&
          r.event_ref.length > 0 &&
          typeof r?.partner_key === "string" &&
          r.partner_key.length > 0 &&
          typeof r?.mode === "string",
      )
      .slice(0, 60)
      .map((r) => ({
        event_ref: r.event_ref,
        partner_key: r.partner_key,
        partner_name: typeof r.partner_name === "string" ? r.partner_name : null,
        mode: r.mode,
        sent_to: typeof r.sent_to === "string" ? r.sent_to : null,
      }));
    return { rows };
  })
  .handler(async ({ data }): Promise<{ recorded: number }> => {
    const { requireTracker } = await import("./session.server");
    const session = await requireTracker("na");
    if (data.rows.length === 0) return { recorded: 0 };
    const { db } = await import("./db.server");
    const sql = await db();
    const payload = data.rows.map((r) => ({ ...r, last_asked_by: session.email }));
    // A second ask is a chase, not a correction: keep the first date, move the
    // last one, and count them.
    await sql`
      INSERT INTO na_recovery_request
        (event_ref, partner_key, partner_name, mode, sent_to,
         first_asked_at, last_asked_at, times_asked, last_asked_by)
      SELECT x.event_ref, x.partner_key, x.partner_name, x.mode, x.sent_to,
             now(), now(), 1, x.last_asked_by
      FROM json_to_recordset(${JSON.stringify(payload)}::json)
        AS x(event_ref text, partner_key text, partner_name text, mode text,
             sent_to text, last_asked_by text)
      ON CONFLICT (event_ref, partner_key) DO UPDATE
        SET mode = EXCLUDED.mode,
            sent_to = EXCLUDED.sent_to,
            partner_name = COALESCE(EXCLUDED.partner_name, na_recovery_request.partner_name),
            last_asked_at = now(),
            times_asked = na_recovery_request.times_asked + 1,
            last_asked_by = EXCLUDED.last_asked_by
    `;
    return { recorded: data.rows.length };
  });
