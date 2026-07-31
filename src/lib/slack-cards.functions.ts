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
// Types and the pure reducer only — importing this module does not reach Slack; see
// refreshMirror for the one call that does.
import { aggregateApprovals, type CardApproval } from "./slack-cards.server.ts";

export type CardApprovalSummary = {
  owner_code: string;
  /** From the most recent approval. */
  event_ref: string | null;
  approved_by: string | null;
  /** ISO of the most recent approval. */
  at: string;
  /** ISO of the first one, and how many there are. */
  first_at: string | null;
  count: number;
};

/** One row of the mirror, as the insert takes it. */
export type MirrorRow = {
  owner_code: string;
  event_ref: string | null;
  approved_by: string | null;
  approved_at: string | null;
  first_approved_at: string | null;
  approval_count: number;
  synced_at: Date;
};

/**
 * The channel's approvals, as mirror rows: one per provider.
 *
 * Exported so the integration test drives the same reduction the button does — the two
 * defects this write has had, a double-encoded payload and a batch with repeated keys,
 * would both have been caught in seconds by running this against a real batch.
 */
export function mirrorRows(approvals: CardApproval[], now = new Date()): MirrorRow[] {
  return aggregateApprovals(approvals).map((p) => ({
    owner_code: p.ownerCode,
    event_ref: p.eventRef,
    approved_by: p.approvedBy,
    approved_at: p.lastAt,
    first_approved_at: p.firstAt ?? p.lastAt,
    approval_count: p.count,
    synced_at: now,
  }));
}

/**
 * Writes the mirror.
 *
 * ON CONFLICT DO UPDATE cannot affect the same row twice in one statement, so the batch
 * must be unique on owner_code before it gets here. The reducer above guarantees that;
 * the assertion is what makes a future change to it fail by name instead of as a
 * Postgres 21000 three layers down.
 */
export async function writeMirror(rows: MirrorRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  if (new Set(rows.map((r) => r.owner_code)).size !== rows.length) {
    throw new Error("mirror batch has duplicate owner codes — reduce before inserting");
  }

  const { db } = await import("./db.server.ts");
  const sql = await db();
  // The driver's own bulk insert. Building the rows as JSON and handing them to
  // jsonb_to_recordset double-encoded them — postgres.js serialises the string it is
  // given, so Postgres received the JSON *string* "[{…}]" and answered "cannot call
  // jsonb_to_recordset on a non-array" on every single sync.
  await sql`
    INSERT INTO slack_card_approvals ${sql(
      rows,
      "owner_code",
      "event_ref",
      "approved_by",
      "approved_at",
      "first_approved_at",
      "approval_count",
      "synced_at",
    )}
    ON CONFLICT (owner_code) DO UPDATE SET
      event_ref         = EXCLUDED.event_ref,
      approved_by       = EXCLUDED.approved_by,
      approved_at       = EXCLUDED.approved_at,
      first_approved_at = EXCLUDED.first_approved_at,
      approval_count    = EXCLUDED.approval_count,
      synced_at         = now()
  `;
  return rows.length;
}

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
async function refreshMirror(): Promise<{ approvals: number; providers: number }> {
  const { fetchCardApprovalsLive } = await import("./slack-cards.server");

  let approvals;
  try {
    approvals = await fetchCardApprovalsLive();
  } catch (error) {
    throw new Error(`Slack could not be read: ${reason(error)}. The mirror was left as it was.`, {
      cause: error,
    });
  }
  if (approvals.length === 0) return { approvals: 0, providers: 0 };

  const rows = mirrorRows(approvals);
  try {
    await writeMirror(rows);
  } catch (error) {
    throw new Error(
      `Read ${approvals.length} approvals from Slack but could not write them: ` +
        `${reason(error)}. Nothing was saved.`,
      { cause: error },
    );
  }
  // Both numbers: "559 approvals across 287 providers" says what happened, where a
  // single count leaves the reader guessing which one it is.
  console.log(`Mirrored ${approvals.length} approvals across ${rows.length} providers`);
  return { approvals: approvals.length, providers: rows.length };
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
        first_approved_at: Date | null;
        approval_count: number | null;
      }[]
    >`SELECT owner_code, event_ref, approved_by, approved_at, first_approved_at, approval_count
      FROM slack_card_approvals`;
    return {
      approvals: rows.map((r) => ({
        owner_code: r.owner_code,
        event_ref: r.event_ref,
        approved_by: r.approved_by,
        at: isoOrNull(r.approved_at) ?? "",
        first_at: isoOrNull(r.first_approved_at),
        count: Number(r.approval_count ?? 1),
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
  async (): Promise<{ synced: number; providers: number }> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { approvals, providers } = await refreshMirror();
    return { synced: approvals, providers };
  },
);
