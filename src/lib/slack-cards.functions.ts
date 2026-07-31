/**
 * Credit-card approvals, served from Postgres rather than from Slack.
 *
 * Reading them live meant a cold serverless instance paged through up to ten
 * conversations.history calls before the partner cards could render. They are now
 * mirrored into slack_card_approvals and refreshed on demand — approvals are
 * append-only, so a mirror that lags by a few minutes costs nothing.
 */
import { createServerFn } from "@tanstack/react-start";

export type CardApprovalSummary = {
  owner_code: string;
  event_ref: string | null;
  approved_by: string | null;
  at: string;
};

const STALE_AFTER_SECONDS = 3600;

/** Pages through Slack and refreshes the mirror. Returns how many rows landed. */
async function refreshMirror(): Promise<number> {
  const { fetchCardApprovals: readSlack } = await import("./slack-cards.server");
  const approvals = await readSlack();
  if (approvals.length === 0) return 0;

  const { db } = await import("./db.server");
  const sql = await db();
  const payload = approvals.map((a) => ({
    owner_code: a.ownerCode,
    event_ref: a.eventRef,
    approved_by: a.approvedBy,
    approved_at: a.at || null,
  }));
  await sql`
    INSERT INTO slack_card_approvals (owner_code, event_ref, approved_by, approved_at, synced_at)
    SELECT x.owner_code, x.event_ref, x.approved_by, x.approved_at, now()
    FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
      AS x(owner_code text, event_ref text, approved_by text, approved_at timestamptz)
    ON CONFLICT (owner_code) DO UPDATE SET
      event_ref = EXCLUDED.event_ref,
      approved_by = EXCLUDED.approved_by,
      approved_at = EXCLUDED.approved_at,
      synced_at = now()
  `;
  return approvals.length;
}

/** Seconds since the mirror was last written, or null when it has never been. */
async function mirrorAge(): Promise<number | null> {
  const { db } = await import("./db.server");
  const sql = await db();
  const rows = await sql<{ age: number | null }[]>`
    SELECT EXTRACT(EPOCH FROM (now() - MAX(synced_at)))::int AS age
    FROM slack_card_approvals
  `;
  return rows[0]?.age ?? null;
}

/** Fast path: read the mirror. */
export const fetchCardApprovals = createServerFn({ method: "GET" }).handler(
  async (): Promise<CardApprovalSummary[]> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { db, isoOrNull } = await import("./db.server");
    const sql = await db();

    // Refresh in place when the mirror has never been written or has gone stale,
    // so a card approved in Slack shows up without anyone thinking to refresh.
    // A Slack outage must not take the cards down: on failure we serve what we
    // have, even if that is nothing.
    try {
      const age = await mirrorAge();
      if (age == null || age > STALE_AFTER_SECONDS) await refreshMirror();
    } catch (error) {
      console.error("Slack card mirror refresh failed (serving the mirror as-is):", error);
    }
    const rows = await sql<
      {
        owner_code: string;
        event_ref: string | null;
        approved_by: string | null;
        approved_at: Date | null;
      }[]
    >`SELECT owner_code, event_ref, approved_by, approved_at FROM slack_card_approvals`;
    return rows.map((r) => ({
      owner_code: r.owner_code,
      event_ref: r.event_ref,
      approved_by: r.approved_by,
      at: isoOrNull(r.approved_at) ?? "",
    }));
  },
);

/** Slow path: page through Slack and refresh the mirror. */
export const syncCardApprovals = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ synced: number }> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    return { synced: await refreshMirror() };
  },
);
