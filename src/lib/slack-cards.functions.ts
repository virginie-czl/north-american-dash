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
 * The sync is the only path that calls Slack, and it always calls it live: a button
 * labelled "refresh" that quietly copied a cache would be lying about what it did.
 *
 * It also does not catch. Resilience belongs on the read path, where a Slack outage
 * must not take the partner cards down — and the read path no longer touches Slack at
 * all, so there is nothing left to be resilient about. A refresh that cannot refresh
 * is a failed call, and the button says so. A catch that turns every failure into a
 * success is not resilience; it is how this mirror stayed empty while the button
 * reported nothing wrong.
 */
import { createServerFn } from "@tanstack/react-start";

export type CardApprovalSummary = {
  owner_code: string;
  event_ref: string | null;
  approved_by: string | null;
  at: string;
};

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads Slack live and writes the mirror. Returns how many rows landed.
 *
 * The two phases fail differently and say so, because the difference is the whole
 * diagnosis: an unreadable channel leaves the mirror exactly as it was, while a failed
 * write leaves it stale for everyone with nothing persisted.
 */
async function refreshMirror(): Promise<number> {
  const { fetchCardApprovalsLive } = await import("./slack-cards.server");

  let approvals;
  try {
    approvals = await fetchCardApprovalsLive();
  } catch (error) {
    throw new Error(`Slack could not be read: ${reason(error)}. The mirror was left as it was.`, {
      cause: error,
    });
  }
  if (approvals.length === 0) return 0;

  // The driver's own bulk insert. Building the rows as JSON and handing them to
  // jsonb_to_recordset double-encoded them — postgres.js serialises the string it is
  // given, so Postgres received the JSON *string* "[{…}]" and answered "cannot call
  // jsonb_to_recordset on a non-array" on every single sync. sql(rows, …cols) needs no
  // serialisation and lets the driver type each column.
  const rows = approvals.map((a) => ({
    owner_code: a.ownerCode,
    event_ref: a.eventRef,
    approved_by: a.approvedBy,
    approved_at: a.at || null,
    synced_at: new Date(),
  }));

  try {
    const { db } = await import("./db.server");
    const sql = await db();
    await sql`
      INSERT INTO slack_card_approvals ${sql(
        rows,
        "owner_code",
        "event_ref",
        "approved_by",
        "approved_at",
        "synced_at",
      )}
      ON CONFLICT (owner_code) DO UPDATE SET
        event_ref   = EXCLUDED.event_ref,
        approved_by = EXCLUDED.approved_by,
        approved_at = EXCLUDED.approved_at,
        synced_at   = now()
    `;
  } catch (error) {
    throw new Error(
      `Read ${approvals.length} approvals from Slack but could not write them: ` +
        `${reason(error)}. Nothing was saved.`,
      { cause: error },
    );
  }
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

/**
 * The button's own path: read Slack, write the mirror. Deliberately no try/catch —
 * this call exists to refresh, so a failure to refresh is a failure of the call, and
 * the page shows it.
 */
export const syncCardApprovals = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ synced: number }> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    return { synced: await refreshMirror() };
  },
);
