/**
 * A personal Slack connection, and the only three things it is ever used to read.
 *
 * This is not the workspace bot in slack-cards.server.ts. That one reads one finance
 * channel with a shared token. This is an individual OAuth grant, stored per user, and
 * it exists for exactly one purpose: putting that person's own Slack to-dos on their
 * task board.
 *
 * **It can only ever read the connecting person's own items.** Three reads, and each is
 * anchored to the token's owner:
 *
 *  - `reminders.list` — the caller's reminders. No user parameter exists to widen it.
 *  - `stars.list` — the caller's saved items. Same.
 *  - `search.messages` — the caller's Activity, i.e. messages that mention *them*. This
 *    one takes a query, so the anchor is enforced here instead of by Slack: the query is
 *    the caller's own handle, taken from `auth.test` on their own token and never from
 *    anything a client sent, and every match is then checked with `mentionsPerson` against
 *    that same handle before it can become a card. A match that names somebody else is
 *    dropped. No channel is listed, no other person's name is ever sent to Slack, and no
 *    message is stored beyond the one line that mentioned the person reading it.
 *
 * The scopes say the same thing out loud: `reminders:read`, `stars:read` and `search:read`
 * — all user scopes, so Slack itself limits every one of them to what this person can
 * already see. Adding mentions is a real widening of the earlier "nothing searches Slack"
 * promise and is written down here rather than glossed: it is still only ever their own
 * Activity, but it does now read messages, and it needs the grant re-consented.
 *
 * The token is a user token, encrypted at rest with the same key as the Gmail grant, and
 * a disconnect revokes it at Slack rather than merely forgetting it here.
 */
import { activitySubject, activityTitle, isActionItem, mentionsPerson } from "./slack-activity";
import { decryptSecret, encryptSecret } from "./crypto.server";

const SLACK_API = "https://slack.com/api";
export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

/**
 * User scopes, and deliberately the narrowest set that answers "what am I meant to be
 * doing?". All three are *user* scopes: they see what this person sees and nothing more,
 * so none of them can reach a channel this person is not in or another person's anything.
 */
export const SLACK_USER_SCOPES = ["reminders:read", "stars:read", "search:read"];

/**
 * How far back a sync looks for mentions, in minutes — the same fifteen as the cron in
 * vercel.json, deliberately from one place so the window and the cadence cannot drift
 * apart and leave a gap where a mention is never read at all.
 */
export const MENTION_WINDOW_MINUTES = 15;

/** How long an unread mention stays on the board before it is forgotten. */
const MENTION_KEEP_DAYS = 7;

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
  kind: SlackTaskKind;
  title: string;
  /** ISO day, when Slack gave the reminder a time. */
  due: string | null;
  /** Deep link, when there is one to give. */
  permalink: string | null;
  /** Where it was said — only mentions have somewhere to name. */
  subject?: string | null;
};

/**
 * Reminders and saved items are *state*: Slack answers with the current set every time, so
 * a sync can replace them. A mention is an *event* — it happened once, in one fifteen
 * minute window, and will never be in another answer — so it is kept until it is pruned.
 * The two are treated differently in syncSlackTasks and this is the distinction being made.
 */
export type SlackTaskKind = "reminder" | "saved" | "mention";

const STATE_KINDS = ["reminder", "saved"] as const;

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
 * Who the token belongs to, asked of Slack rather than assumed.
 *
 * `auth.test` needs no scope and answers only about the caller. Its `user` is the handle
 * the workspace mentions this person by, which is exactly what has to go in the search
 * query — and taking it from the token means the query can never be pointed at anybody
 * else, whatever arrives from a client.
 */
async function whoAmI(email: string): Promise<{ id: string; handle: string }> {
  const body = await slack<{ user?: string; user_id?: string }>(email, "auth.test");
  return { id: (body.user_id ?? "").trim(), handle: (body.user ?? "").trim() };
}

/**
 * The caller's Activity for the last few minutes: messages that mention them.
 *
 * Slack has no "my mentions" endpoint — the Activity tab is a client-side view over search
 * — so this is `search.messages` for the caller's own handle on the caller's own token,
 * which is the same read their Activity tab performs. Two things narrow it afterwards:
 * only a real mention of this person survives (`mentionsPerson`), and only what is not
 * known noise becomes a task (`isActionItem`, which is where the queued-payment
 * acknowledgement is dropped).
 *
 * The window is applied here rather than in the query on purpose: Slack's `after:` modifier
 * is day-granular, so it cannot express "the last fifteen minutes". Sorting newest-first
 * and cutting by timestamp can, and it is exact.
 */
export async function fetchSlackMentions(
  email: string,
  windowMinutes = MENTION_WINDOW_MINUTES,
  now = Date.now(),
): Promise<SlackItem[]> {
  const me = await whoAmI(email);
  if (!me.handle && !me.id) return [];

  type Match = {
    ts?: string;
    text?: string;
    permalink?: string;
    user?: string;
    username?: string;
    channel?: { id?: string; name?: string };
  };
  const query = encodeURIComponent(`@${me.handle || me.id}`);
  const body = await slack<{ messages?: { matches?: Match[] } }>(
    email,
    `search.messages?query=${query}&sort=timestamp&sort_dir=desc&count=100`,
  );

  const cutoff = (now - windowMinutes * 60_000) / 1000;
  const items: SlackItem[] = [];
  for (const match of body.messages?.matches ?? []) {
    const ts = Number(match.ts);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    // Something this person wrote themselves is not somebody asking them for anything.
    if (match.user && me.id && match.user === me.id) continue;
    if (!mentionsPerson(match.text, me)) continue;
    if (!isActionItem(match.text)) continue;
    const title = activityTitle(match.text);
    if (!title) continue;
    items.push({
      id: `${match.channel?.id ?? "?"}:${match.ts}`,
      kind: "mention",
      title,
      due: null,
      permalink: match.permalink ?? null,
      subject: activitySubject(match.channel?.name),
    });
  }
  return items;
}

/**
 * Pulls one person's items and brings their stored set up to date.
 *
 * Two halves, because Slack answers two different kinds of question.
 *
 * Reminders and saved items are replaced: Slack is the authority on them, a reminder
 * completed or a message unsaved has to leave the board, and the only way to know it went
 * is that it is no longer in the answer.
 *
 * Mentions are added, never replaced. Each sync sees fifteen minutes, so replacing would
 * throw away every window but the newest — the board would forget a mention as soon as the
 * next quarter hour arrived, which is the opposite of a task list. They are inserted with
 * `DO NOTHING` so a mention read twice stays one card (and keeps the column it was dragged
 * to), and pruned after MENTION_KEEP_DAYS so the board does not accumulate forever.
 *
 * Every statement is scoped by `owner_email`, so one person's sync can never touch
 * another's rows. Saved items and mentions are both optional: a grant that predates either
 * scope still syncs what it can rather than failing whole.
 */
export async function syncSlackTasks(email: string): Promise<{ items: number; mentions: number }> {
  const reminders = await fetchSlackReminders(email);
  let saved: SlackItem[] = [];
  try {
    saved = await fetchSlackSaved(email);
  } catch (error) {
    console.error(`Slack saved items unavailable for ${email} (keeping reminders):`, error);
  }
  let mentions: SlackItem[] = [];
  try {
    mentions = await fetchSlackMentions(email);
  } catch (error) {
    // Most likely an older grant without search:read. The rest of the sync is still worth
    // doing, and reconnecting is what fixes it.
    console.error(`Slack mentions unavailable for ${email} (keeping the rest):`, error);
  }
  const current = [...reminders, ...saved];

  const columns = [
    "owner_email",
    "slack_id",
    "kind",
    "title",
    "subject",
    "due",
    "permalink",
    "synced_at",
  ] as const;
  const row = (item: SlackItem) => ({
    owner_email: email,
    slack_id: item.id,
    kind: item.kind,
    title: item.title,
    subject: item.subject ?? null,
    due: item.due,
    permalink: item.permalink,
    synced_at: new Date(),
  });

  const { db } = await import("./db.server");
  const sql = await db();
  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM slack_tasks
      WHERE owner_email = ${email} AND kind IN ${tx(STATE_KINDS)}
    `;
    if (current.length > 0) {
      await tx`INSERT INTO slack_tasks ${tx(current.map(row), ...columns)}`;
    }
    if (mentions.length > 0) {
      // Already on the board: leave the row alone. Re-inserting would reset nothing
      // visible, but the first_seen_at it was read at is what the prune measures.
      await tx`
        INSERT INTO slack_tasks ${tx(mentions.map(row), ...columns)}
        ON CONFLICT (owner_email, slack_id) DO NOTHING
      `;
    }
    await tx`
      DELETE FROM slack_tasks
      WHERE owner_email = ${email}
        AND kind = 'mention'
        AND first_seen_at < now() - ${`${MENTION_KEEP_DAYS} days`}::interval
    `;
    await tx`
      UPDATE slack_credentials SET synced_at = now() WHERE user_email = ${email}
    `;
  });
  return { items: current.length + mentions.length, mentions: mentions.length };
}

export type StoredSlackTask = {
  slack_id: string;
  kind: SlackTaskKind;
  title: string;
  /** Where a mention was said. Null for reminders and saves, which have nowhere to name. */
  subject: string | null;
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
      subject: string | null;
      due: Date | string | null;
      permalink: string | null;
    }[]
  >`
    SELECT slack_id, kind, title, subject, due, permalink
    FROM slack_tasks WHERE owner_email = ${email}
    ORDER BY due NULLS LAST, first_seen_at DESC, title
  `;
  return rows.map((r) => ({
    slack_id: r.slack_id,
    kind: r.kind === "saved" || r.kind === "mention" ? r.kind : "reminder",
    title: r.title,
    subject: r.subject,
    due: dayOrNull(r.due),
    permalink: r.permalink,
  }));
}
