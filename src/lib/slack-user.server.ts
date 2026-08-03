/**
 * A personal Slack connection, and the only two things it is ever used to read.
 *
 * This is not the workspace bot in slack-cards.server.ts. That one reads one finance
 * channel with a shared token. This is an individual OAuth grant, stored per user, and
 * it exists for exactly one purpose: putting that person's own Slack to-dos on their
 * task board.
 *
 * **It can only ever read the connecting person's own items.** The two endpoints used —
 * `reminders.list` and `stars.list` — are defined by Slack to return the caller's
 * reminders and the caller's saved items and nothing else; there is no user or channel
 * parameter to widen them with. No search runs, no channel is listed, no other person's
 * name is ever sent to Slack. The requested scopes say the same thing out loud:
 * `reminders:read` and `stars:read`, both user scopes, neither of which can read a
 * conversation.
 *
 * The token is a user token, encrypted at rest with the same key as the Gmail grant, and
 * a disconnect revokes it at Slack rather than merely forgetting it here.
 */
import { decryptSecret, encryptSecret } from "./crypto.server";

const SLACK_API = "https://slack.com/api";
export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

/**
 * User scopes, and deliberately the narrowest pair that answers "what am I meant to be
 * doing?". Nothing here can read a channel, a DM or another person's anything.
 */
export const SLACK_USER_SCOPES = ["reminders:read", "stars:read"];

export class SlackNotConnectedError extends Error {
  constructor(email: string) {
    super(`${email} has not connected Slack`);
    this.name = "SlackNotConnectedError";
  }
}

export async function storeSlackToken(input: {
  email: string;
  token: string;
  scopes: string;
  slackUserId: string;
  teamName: string | null;
}): Promise<void> {
  const { db } = await import("./db.server");
  const sql = await db();
  await sql`
    INSERT INTO slack_credentials (
      user_email, user_token, scopes, slack_user_id, team_name, connected_at, updated_at
    ) VALUES (
      ${input.email}, ${encryptSecret(input.token)}, ${input.scopes}, ${input.slackUserId},
      ${input.teamName}, now(), now()
    )
    ON CONFLICT (user_email) DO UPDATE SET
      user_token = EXCLUDED.user_token,
      scopes = EXCLUDED.scopes,
      slack_user_id = EXCLUDED.slack_user_id,
      team_name = EXCLUDED.team_name,
      updated_at = now()
  `;
}

export type SlackConnection = {
  scopes: string;
  slack_user_id: string;
  team_name: string | null;
  connected_at: string;
  /** When the cron (or the button) last pulled this person's items. */
  synced_at: string | null;
};

export async function getSlackConnection(email: string): Promise<SlackConnection | null> {
  const { db, isoOrNull } = await import("./db.server");
  const sql = await db();
  const rows = await sql<
    {
      scopes: string;
      slack_user_id: string;
      team_name: string | null;
      connected_at: Date;
      synced_at: Date | null;
    }[]
  >`
    SELECT scopes, slack_user_id, team_name, connected_at, synced_at
    FROM slack_credentials WHERE user_email = ${email}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    scopes: row.scopes,
    slack_user_id: row.slack_user_id,
    team_name: row.team_name,
    connected_at: isoOrNull(row.connected_at) ?? "",
    synced_at: isoOrNull(row.synced_at),
  };
}

/** Every connected person, for the cron. Nothing but the addresses. */
export async function connectedSlackUsers(): Promise<string[]> {
  const { db } = await import("./db.server");
  const sql = await db();
  const rows = await sql<{ user_email: string }[]>`
    SELECT user_email FROM slack_credentials ORDER BY user_email
  `;
  return rows.map((r) => r.user_email);
}

export async function disconnectSlack(email: string): Promise<void> {
  const { db } = await import("./db.server");
  const sql = await db();
  const rows = await sql<{ user_token: string }[]>`
    SELECT user_token FROM slack_credentials WHERE user_email = ${email}
  `;
  if (rows[0]) {
    // Best effort: tell Slack the grant is over, not just this database.
    try {
      const token = decryptSecret(rows[0].user_token);
      await fetch(`${SLACK_API}/auth.revoke`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
      });
    } catch (error) {
      console.error("Slack token revoke failed (continuing):", error);
    }
  }
  // The tasks go with the grant. Disconnecting has to mean the board forgets them.
  await sql`DELETE FROM slack_tasks WHERE owner_email = ${email}`;
  await sql`DELETE FROM slack_credentials WHERE user_email = ${email}`;
}

async function tokenFor(email: string): Promise<string> {
  const { db } = await import("./db.server");
  const sql = await db();
  const rows = await sql<{ user_token: string }[]>`
    SELECT user_token FROM slack_credentials WHERE user_email = ${email}
  `;
  if (!rows[0]) throw new SlackNotConnectedError(email);
  return decryptSecret(rows[0].user_token);
}

async function slack<T>(email: string, method: string): Promise<T> {
  const token = await tokenFor(email);
  const response = await fetch(`${SLACK_API}/${method}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as { ok?: boolean; error?: string } & T;
  if (!response.ok || body.ok !== true) {
    throw new Error(`Slack ${method}: ${body.error ?? response.status}`);
  }
  return body;
}

// ── The two personal reads ──────────────────────────────────────────────────

/**
 * One item off somebody's Slack, on its way to being a card.
 *
 * `id` is Slack's own, so a reminder pulled twice is one task and completing it there
 * closes it here.
 */
export type SlackItem = {
  id: string;
  kind: "reminder" | "saved";
  title: string;
  /** ISO day, when Slack gave the reminder a time. */
  due: string | null;
  /** Deep link, when there is one to give. */
  permalink: string | null;
};

function isoDay(epochSeconds: number | null | undefined): string | null {
  if (!epochSeconds || epochSeconds <= 0) return null;
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * The caller's own reminders. `reminders.list` takes no user parameter — it answers for
 * whoever the token belongs to, which is the point.
 */
export async function fetchSlackReminders(email: string): Promise<SlackItem[]> {
  type Reminder = {
    id: string;
    text?: string;
    time?: number;
    complete_ts?: number;
    recurring?: boolean;
  };
  const body = await slack<{ reminders?: Reminder[] }>(email, "reminders.list");
  return (
    (body.reminders ?? [])
      // A reminder already ticked off in Slack is not a task.
      .filter((r) => !r.complete_ts && (r.text ?? "").trim().length > 0)
      .map((r) => ({
        id: r.id,
        kind: "reminder" as const,
        title: (r.text ?? "").trim().slice(0, 200),
        due: isoDay(r.time),
        permalink: null,
      }))
  );
}

/**
 * The caller's saved items — Slack's "save for later", which is what most people
 * actually use as a to-do list. Also caller-scoped with no way to widen it.
 *
 * Only message saves become tasks: a saved file or channel is a bookmark, not a job.
 */
export async function fetchSlackSaved(email: string): Promise<SlackItem[]> {
  type SavedItem = {
    type?: string;
    message?: { text?: string; permalink?: string; ts?: string };
    channel?: string;
  };
  const body = await slack<{ items?: SavedItem[] }>(email, "stars.list?limit=100");
  const items: SlackItem[] = [];
  for (const item of body.items ?? []) {
    if (item.type !== "message" || !item.message?.ts) continue;
    const text = (item.message.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    items.push({
      id: `${item.channel ?? "?"}:${item.message.ts}`,
      kind: "saved",
      title: text.slice(0, 200),
      due: null,
      permalink: item.message.permalink ?? null,
    });
  }
  return items;
}

/**
 * Pulls one person's items and replaces their stored set.
 *
 * A replace rather than a merge, because Slack is the authority: a reminder completed or
 * a message unsaved has to leave the board, and the only way to know it went is that it
 * is no longer in the answer. Scoped by `owner_email` in both directions, so one
 * person's sync can never touch another's rows.
 *
 * Saved items are optional: if the grant predates that scope, the reminders still work
 * rather than the whole sync failing.
 */
export async function syncSlackTasks(email: string): Promise<{ items: number }> {
  const reminders = await fetchSlackReminders(email);
  let saved: SlackItem[] = [];
  try {
    saved = await fetchSlackSaved(email);
  } catch (error) {
    console.error(`Slack saved items unavailable for ${email} (keeping reminders):`, error);
  }
  const items = [...reminders, ...saved];

  const { db } = await import("./db.server");
  const sql = await db();
  await sql.begin(async (tx) => {
    await tx`DELETE FROM slack_tasks WHERE owner_email = ${email}`;
    if (items.length > 0) {
      const rows = items.map((i) => ({
        owner_email: email,
        slack_id: i.id,
        kind: i.kind,
        title: i.title,
        due: i.due,
        permalink: i.permalink,
        synced_at: new Date(),
      }));
      await tx`
        INSERT INTO slack_tasks ${tx(
          rows,
          "owner_email",
          "slack_id",
          "kind",
          "title",
          "due",
          "permalink",
          "synced_at",
        )}
      `;
    }
    await tx`
      UPDATE slack_credentials SET synced_at = now() WHERE user_email = ${email}
    `;
  });
  return { items: items.length };
}

export type StoredSlackTask = {
  slack_id: string;
  kind: "reminder" | "saved";
  title: string;
  due: string | null;
  permalink: string | null;
};

/**
 * One person's stored Slack tasks.
 *
 * The `owner_email` filter is the privacy rule, and it is the caller's session email
 * every time — never a parameter from the client. Slack tasks are personal on a shared
 * board: they belong to the person who connected the account and nobody else sees them.
 */
export async function readSlackTasks(email: string): Promise<StoredSlackTask[]> {
  const { db, dayOrNull } = await import("./db.server");
  const sql = await db();
  const rows = await sql<
    {
      slack_id: string;
      kind: string;
      title: string;
      due: Date | string | null;
      permalink: string | null;
    }[]
  >`
    SELECT slack_id, kind, title, due, permalink
    FROM slack_tasks WHERE owner_email = ${email}
    ORDER BY due NULLS LAST, title
  `;
  return rows.map((r) => ({
    slack_id: r.slack_id,
    kind: r.kind === "saved" ? "saved" : "reminder",
    title: r.title,
    due: dayOrNull(r.due),
    permalink: r.permalink,
  }));
}
