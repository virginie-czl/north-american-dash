/**
 * Credit-card approvals, served from Postgres rather than from Slack.
 *
 * Reading them live meant a cold serverless instance paged through up to ten
 * conversations.history calls before the partner cards could render. They are
 * mirrored into slack_card_approvals instead.
 *
 * **Reading the mirror never calls Slack.** It used to refresh itself whenever the
 * mirror was empty or over an hour old, which meant an unlucky page load paid for the
 * whole Slack walk and a Slack outage showed up as a slow tracker. Refreshing is now
 * the refresh button's job alone, on Card tracking NA and on Marketplace NA.
 *
 * The cost of that is staleness: a card approved five minutes ago is not here until
 * someone syncs. So every page that reads the mirror shows its age — see
 * `syncedAgeSeconds` — rather than letting the reader assume it is live.
 *
 * Pressing the button is usually cheap even so. A Vercel cron already refreshes
 * `slack_card_approvals_cache` every 15 minutes, and that is what `refreshMirror`
 * reads through — so the sync normally copies a warm cache into the mirror without
 * calling Slack at all, and lands data at most ~15 minutes behind the channel. The
 * cron deliberately does not write the mirror itself: the age shown on the pages is
 * meant to say when a person last chose to sync, not when a machine last ran.
 */
import { createServerFn } from "@tanstack/react-start";

export type CardApprovalSummary = {
  owner_code: string;
  event_ref: string | null;
  approved_by: string | null;
  at: string;
};

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

/** Reads the mirror, and says how old it is. Never touches Slack. */
export const fetchCardApprovals = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ approvals: CardApprovalSummary[]; syncedAgeSeconds: number | null }> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { db, isoOrNull } = await import("./db.server");
    const sql = await db();

    const rows = await sql<
      {
        owner_code: string;
        event_ref: string | null;
        approved_by: string | null;
        approved_at: Date | null;
      }[]
    >`SELECT owner_code, event_ref, approved_by, approved_at FROM slack_card_approvals`;
    return {
      approvals: rows.map((r) => ({
        owner_code: r.owner_code,
        event_ref: r.event_ref,
        approved_by: r.approved_by,
        at: isoOrNull(r.approved_at) ?? "",
      })),
      syncedAgeSeconds: await mirrorAge(),
    };
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
