/**
 * The recovery ledger's write side (server-only).
 *
 * A claim is taken *before* Gmail is called, not after: the point of the ledger
 * is that two people cannot both send, and a row written after the fact would
 * leave a window where they can. `INSERT … ON CONFLICT DO NOTHING RETURNING`
 * makes the primary key the arbiter, so the loser of a race learns it lost
 * before any mail leaves the building.
 */
import { recoveryScopeOf, type RecoverySend } from "./recovery-log";

export type RecoveryClaim =
  | { ok: true }
  /** Someone else got there first — or the same person already sent it. */
  | { ok: false; existing: RecoverySend };

type Row = Omit<RecoverySend, "sent_at"> & { sent_at: Date };

function toSend(row: Row): RecoverySend {
  return { ...row, sent_at: row.sent_at?.toISOString?.() ?? String(row.sent_at) };
}

export async function claimRecoveryEmail(input: {
  event_ref: string;
  recipient: string;
  mode: string;
  recipient_name?: string | null;
  subject?: string | null;
  sent_by: string;
  sent_by_name?: string | null;
  /** True when somebody is recording a chase this app never saw. */
  by_hand?: boolean;
}): Promise<RecoveryClaim> {
  const { db } = await import("./db.server");
  const sql = await db();
  const recipient = input.recipient.trim().toLowerCase();
  const scope = recoveryScopeOf(input.mode);

  const inserted = await sql<{ event_ref: string }[]>`
    INSERT INTO recovery_emails
      (event_ref, recipient, scope, mode, recipient_name, subject, sent_by, sent_by_name, by_hand)
    VALUES (
      ${input.event_ref}, ${recipient}, ${scope}, ${input.mode},
      ${input.recipient_name ?? null}, ${input.subject ?? null},
      ${input.sent_by}, ${input.sent_by_name ?? null}, ${input.by_hand === true}
    )
    ON CONFLICT (event_ref, recipient, scope) DO NOTHING
    RETURNING event_ref
  `;
  if (inserted.length > 0) return { ok: true };

  const rows = await sql<Row[]>`
    SELECT event_ref, recipient, scope, mode, recipient_name, subject,
           sent_at, sent_by, sent_by_name, by_hand
    FROM recovery_emails
    WHERE event_ref = ${input.event_ref} AND recipient = ${recipient} AND scope = ${scope}
  `;
  const existing = rows[0];
  if (!existing) {
    // The row vanished between the two statements (a release, most likely).
    // Treat it as a win: the caller retries and the key still protects us.
    return { ok: true };
  }
  return { ok: false, existing: toSend(existing) };
}

/**
 * Gives a claim back after a failed send. Scoped to the claimant, so a release
 * can never wipe out somebody else's genuine send.
 */
export async function releaseRecoveryEmail(input: {
  event_ref: string;
  recipient: string;
  mode: string;
  sent_by: string;
}): Promise<void> {
  const { db } = await import("./db.server");
  const sql = await db();
  await sql`
    DELETE FROM recovery_emails
    WHERE event_ref = ${input.event_ref}
      AND recipient = ${input.recipient.trim().toLowerCase()}
      AND scope = ${recoveryScopeOf(input.mode)}
      AND sent_by = ${input.sent_by}
  `;
}

/**
 * Takes back a hand-recorded claim.
 *
 * Only ever a hand-recorded one: `by_hand` in the WHERE clause is what makes this safe
 * to offer to everybody. A real send left a message in somebody's Sent folder, and no
 * button here should be able to make the record of it disappear — but a mark somebody
 * put on the wrong booking is just a mistake, and the person looking at it has to be
 * able to take it off without hunting for whoever made it.
 */
export async function unmarkRecoveryByHand(input: {
  event_ref: string;
  recipient: string;
  mode: string;
}): Promise<{ removed: boolean }> {
  const { db } = await import("./db.server");
  const sql = await db();
  const rows = await sql<{ event_ref: string }[]>`
    DELETE FROM recovery_emails
    WHERE event_ref = ${input.event_ref}
      AND recipient = ${input.recipient.trim().toLowerCase()}
      AND scope = ${recoveryScopeOf(input.mode)}
      AND by_hand = true
    RETURNING event_ref
  `;
  return { removed: rows.length > 0 };
}

export async function listRecoveryEmails(): Promise<RecoverySend[]> {
  const { db } = await import("./db.server");
  const sql = await db();
  const rows = await sql<Row[]>`
    SELECT event_ref, recipient, scope, mode, recipient_name, subject,
           sent_at, sent_by, sent_by_name, by_hand
    FROM recovery_emails
    ORDER BY sent_at DESC
  `;
  return rows.map(toSend);
}
