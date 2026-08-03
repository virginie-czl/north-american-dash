/**
 * The task board's server side.
 *
 * Reading the board derives every feed the caller is allowed to see and merges what the
 * board has stored about those cards. Deriving rather than storing is the point: the
 * trackers stay the authority on whether work is open, so a card can never claim a
 * provider is unpaid after the money has landed.
 *
 * Every feed is gated by the same tracker check its own page uses, so the board can
 * never show someone a booking they cannot open. A feed that fails is reported as
 * failed rather than quietly dropped — a task list missing a whole tracker looks
 * exactly like a tracker with nothing to do.
 */
import { createServerFn } from "@tanstack/react-start";
import {
  isTaskColumn,
  isTaskPriority,
  type DerivedTask,
  type ManualTaskInput,
  type Task,
  type TaskColumn,
  type TaskState,
} from "./tasks";
import { isTrackerKey, type TrackerKey } from "./trackers";
import type { CardEvidence, CardTerms } from "./card-tracking";

/** One feed's standing, so the board can say what it is and is not showing. */
export type FeedStatus = {
  tracker: TrackerKey;
  tasks: number;
  /** How stale the underlying query was, when it came from a cache. */
  cachedAgeSeconds: number | null;
  error: string | null;
};

export type SlackStatus = {
  connected: boolean;
  syncedAt: string | null;
  error: string | null;
  /**
   * True when the grant was made before mentions existed, so it has no `search:read` and
   * this person's Activity is silently not being read. Worth saying out loud: a connector
   * that is quietly doing less than the page claims is worse than one that is off.
   */
  needsReconnect: boolean;
};

export type BoardPayload = {
  tasks: Task[];
  feeds: FeedStatus[];
  /** Approved users, for the assignee picker. */
  people: string[];
  /** The caller's own Slack connection — nobody else's is ever reported. */
  slack: SlackStatus;
};

// ── Stored state ────────────────────────────────────────────────────────────

type StateRow = {
  key: string;
  manual: boolean;
  column_key: string;
  assignee: string | null;
  note: string | null;
  priority: string | null;
  due: Date | string | null;
  title: string | null;
  tracker: string | null;
  ref: string | null;
  created_by: string | null;
  updated_by: string | null;
  updated_at: Date | null;
};

function toState(
  row: StateRow,
  isoOrNull: (v: unknown) => string | null,
  dayOrNull: (v: unknown) => string | null,
): TaskState {
  return {
    key: row.key,
    manual: row.manual === true,
    column: isTaskColumn(row.column_key) ? row.column_key : "todo",
    assignee: row.assignee,
    note: row.note,
    priority: isTaskPriority(row.priority) ? row.priority : "normal",
    due: dayOrNull(row.due),
    title: row.title,
    tracker: isTrackerKey(row.tracker) ? row.tracker : null,
    ref: row.ref,
    created_by: row.created_by,
    updated_by: row.updated_by,
    updated_at: isoOrNull(row.updated_at),
  };
}

async function readState(): Promise<TaskState[]> {
  const { db, isoOrNull, dayOrNull } = await import("./db.server");
  const sql = await db();
  const rows = await sql<StateRow[]>`
    SELECT key, manual, column_key, assignee, note, priority, due, title, tracker, ref,
           created_by, updated_by, updated_at
    FROM tracker_tasks
    ORDER BY updated_at DESC
  `;
  return rows.map((r) => toState(r, isoOrNull, dayOrNull));
}

// ── The feeds ───────────────────────────────────────────────────────────────

/**
 * Card tracking NA, derived server-side from the same three sources its page reads.
 *
 * The provider list comes from the shared cache, so opening the board does not pay for
 * a BigQuery run that the tracker has already made.
 */
async function cardFeed(): Promise<{ tasks: DerivedTask[]; cachedAgeSeconds: number | null }> {
  const { loadCardProviders } = await import("./card-tracking.functions");
  const { loadCardEvidence } = await import("./card-terms.functions");
  const { buildRows } = await import("./card-tracking");
  const { cardTasks } = await import("./task-feeds");
  const { db, isoOrNull } = await import("./db.server");

  const { providers, cachedAgeSeconds } = await loadCardProviders();
  const sql = await db();
  const termRows = await sql<Record<string, unknown>[]>`
    SELECT owner_code, accepts_card, fee_percent, fee_fixed, fee_currency,
           refusal_reason, naboo_pays_card, naboo_reason, updated_by, updated_at
    FROM provider_card_terms
  `;
  const terms = new Map<string, CardTerms>(
    termRows.map((r) => [
      String(r.owner_code),
      {
        owner_code: String(r.owner_code),
        accepts_card: (r.accepts_card as "yes" | "no" | null) ?? null,
        fee_percent: r.fee_percent == null ? null : Number(r.fee_percent),
        fee_fixed: r.fee_fixed == null ? null : Number(r.fee_fixed),
        fee_currency: (r.fee_currency as string) ?? null,
        refusal_reason: (r.refusal_reason as string) ?? null,
        naboo_pays_card: (r.naboo_pays_card as "yes" | "no" | null) ?? null,
        naboo_reason: (r.naboo_reason as string) ?? null,
        updated_by: (r.updated_by as string) ?? null,
        updated_at: isoOrNull(r.updated_at),
      },
    ]),
  );

  const { evidence } = await loadCardEvidence(
    providers.map((p) => ({ owner_code: p.owner_code, aliases: p.aliases })),
  );
  const evidenceByOwner = new Map<string, CardEvidence>(
    evidence.map((e) => [
      e.owner_code,
      {
        slackApproved: e.slackApproved,
        emailVerdict: e.emailVerdict,
        approvalCount: e.approvalCount,
        lastApprovedAt: e.lastApprovedAt,
      },
    ]),
  );

  return { tasks: cardTasks(buildRows(providers, terms, evidenceByOwner)), cachedAgeSeconds };
}

async function commissionFeed(): Promise<{
  tasks: DerivedTask[];
  cachedAgeSeconds: number | null;
}> {
  const { loadCommissionRows } = await import("./commission.functions");
  const { commissionTasks } = await import("./task-feeds");
  return { tasks: commissionTasks(await loadCommissionRows()), cachedAgeSeconds: null };
}

const FEEDS: Array<{
  tracker: TrackerKey;
  load: () => Promise<{ tasks: DerivedTask[]; cachedAgeSeconds: number | null }>;
}> = [
  { tracker: "na-cards", load: cardFeed },
  { tracker: "na-commissions", load: commissionFeed },
];

// ── Reading the board ───────────────────────────────────────────────────────

export const fetchBoard = createServerFn({ method: "GET" }).handler(
  async (): Promise<BoardPayload> => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { getAccess, listUsers } = await import("./access.server");
    const { trackers } = await getAccess(session.email);
    const { buildBoard } = await import("./tasks");

    const derived: DerivedTask[] = [];
    const feeds: FeedStatus[] = [];
    for (const feed of FEEDS) {
      // Presentation aside: a tracker the caller cannot open contributes nothing.
      if (!trackers.includes(feed.tracker)) continue;
      try {
        const result = await feed.load();
        derived.push(...result.tasks);
        feeds.push({
          tracker: feed.tracker,
          tasks: result.tasks.length,
          cachedAgeSeconds: result.cachedAgeSeconds,
          error: null,
        });
      } catch (error) {
        // Said out loud. A board quietly missing Card tracking NA is indistinguishable
        // from a Card tracking NA with nothing left to do.
        console.error(`task feed ${feed.tracker} failed:`, error);
        feeds.push({
          tracker: feed.tracker,
          tasks: 0,
          cachedAgeSeconds: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Somebody's own Slack, read only for them. Not a FEEDS entry: those are gated by
    // tracker and shared by everyone who has that tracker, and these are neither.
    let slack: SlackStatus = {
      connected: false,
      syncedAt: null,
      error: null,
      needsReconnect: false,
    };
    try {
      const { getSlackConnection, readSlackTasks, SLACK_USER_SCOPES } =
        await import("./slack-user.server");
      const connection = await getSlackConnection(session.email);
      if (connection) {
        const { slackTasks } = await import("./task-feeds");
        derived.push(...slackTasks(await readSlackTasks(session.email)));
        const granted = new Set(connection.scopes.split(",").map((s) => s.trim()));
        slack = {
          connected: true,
          syncedAt: connection.synced_at,
          error: null,
          needsReconnect: SLACK_USER_SCOPES.some((scope) => !granted.has(scope)),
        };
      }
    } catch (error) {
      console.error("reading Slack tasks failed:", error);
      slack = {
        connected: true,
        syncedAt: null,
        error: error instanceof Error ? error.message : String(error),
        needsReconnect: false,
      };
    }

    const people = (await listUsers())
      .filter((u) => u.status === "approved")
      .map((u) => u.email)
      .sort();

    return { tasks: buildBoard(derived, await readState()), feeds, people, slack };
  },
);

// ── Moving and editing ──────────────────────────────────────────────────────

function cleanKey(value: unknown): string {
  const key = String(value ?? "").trim();
  if (!key || key.length > 200) throw new Error("Invalid task");
  return key;
}

function cleanText(value: unknown, max: number): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function cleanDay(value: unknown): string | null {
  const day = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * Where a card sits, and everything written on it.
 *
 * One statement for both kinds of task. A derived card has no row until the first time
 * somebody touches it, which is why this is an upsert carrying enough of the card's
 * identity — tracker, ref, title — to still be nameable after the tracker stops
 * reporting it.
 */
export const saveTaskState = createServerFn({ method: "POST" })
  .validator(
    (input: {
      key: string;
      column?: string;
      assignee?: string | null;
      note?: string | null;
      priority?: string | null;
      due?: string | null;
      /** Only used when the row does not exist yet. */
      title?: string | null;
      tracker?: string | null;
      ref?: string | null;
    }) => ({
      key: cleanKey(input?.key),
      column: isTaskColumn(input?.column) ? input.column : null,
      assignee: cleanText(input?.assignee, 200),
      note: cleanText(input?.note, 2000),
      priority: isTaskPriority(input?.priority) ? input.priority : null,
      due: cleanDay(input?.due),
      title: cleanText(input?.title, 200),
      tracker: isTrackerKey(input?.tracker) ? input.tracker : null,
      ref: cleanText(input?.ref, 60),
    }),
  )
  .handler(async ({ data }): Promise<TaskState> => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { db, isoOrNull, dayOrNull } = await import("./db.server");
    const sql = await db();

    const column: TaskColumn = data.column ?? "todo";
    const rows = await sql<StateRow[]>`
      INSERT INTO tracker_tasks (
        key, manual, column_key, assignee, note, priority, due, title, tracker, ref,
        created_by, updated_by, updated_at
      ) VALUES (
        ${data.key}, false, ${column}, ${data.assignee}, ${data.note},
        ${data.priority ?? "normal"}, ${data.due},
        ${data.title}, ${data.tracker}, ${data.ref}, ${session.email}, ${session.email}, now()
      )
      ON CONFLICT (key) DO UPDATE SET
        -- Only what was sent moves. A drag carries a column and nothing else, and it
        -- must not wipe the note somebody left on the card.
        column_key = COALESCE(${data.column}, tracker_tasks.column_key),
        assignee   = ${data.assignee},
        note       = ${data.note},
        priority   = COALESCE(${data.priority}, tracker_tasks.priority),
        due        = ${data.due},
        title      = COALESCE(tracker_tasks.title, EXCLUDED.title),
        tracker    = COALESCE(tracker_tasks.tracker, EXCLUDED.tracker),
        ref        = COALESCE(tracker_tasks.ref, EXCLUDED.ref),
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING key, manual, column_key, assignee, note, priority, due, title, tracker, ref,
                created_by, updated_by, updated_at
    `;
    return toState(rows[0], isoOrNull, dayOrNull);
  });

/** A task somebody typed. The only kind that can be created, edited or deleted. */
export const createManualTask = createServerFn({ method: "POST" })
  .validator((input: ManualTaskInput) => ({
    title: String(input?.title ?? "").trim(),
    tracker: input?.tracker == null || input.tracker === "" ? null : String(input.tracker),
    ref: cleanText(input?.ref, 60),
    assignee: cleanText(input?.assignee, 200),
    due: cleanDay(input?.due),
    note: cleanText(input?.note, 2000),
    column: String(input?.column ?? "todo"),
    priority: isTaskPriority(input?.priority) ? input.priority : "normal",
  }))
  .handler(async ({ data }): Promise<TaskState> => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { validateManualTask } = await import("./tasks");
    // The same rule the dialog checks, applied again here: a stale tab must not be able
    // to store a task with no title or a column that does not exist.
    const problem = validateManualTask(data);
    if (problem) throw new Error(problem);

    const { db, isoOrNull, dayOrNull } = await import("./db.server");
    const sql = await db();
    const key = `manual::${crypto.randomUUID()}`;
    const rows = await sql<StateRow[]>`
      INSERT INTO tracker_tasks (
        key, manual, column_key, assignee, note, priority, due, title, tracker, ref,
        created_by, updated_by, updated_at
      ) VALUES (
        ${key}, true, ${data.column}, ${data.assignee}, ${data.note}, ${data.priority},
        ${data.due}, ${data.title.slice(0, 200)}, ${data.tracker}, ${data.ref},
        ${session.email}, ${session.email}, now()
      )
      RETURNING key, manual, column_key, assignee, note, priority, due, title, tracker, ref,
                created_by, updated_by, updated_at
    `;
    return toState(rows[0], isoOrNull, dayOrNull);
  });

export const updateManualTask = createServerFn({ method: "POST" })
  .validator((input: ManualTaskInput & { key: string }) => ({
    key: cleanKey(input?.key),
    title: String(input?.title ?? "").trim(),
    tracker: input?.tracker == null || input.tracker === "" ? null : String(input.tracker),
    ref: cleanText(input?.ref, 60),
    assignee: cleanText(input?.assignee, 200),
    due: cleanDay(input?.due),
    note: cleanText(input?.note, 2000),
    column: String(input?.column ?? "todo"),
    priority: isTaskPriority(input?.priority) ? input.priority : "normal",
  }))
  .handler(async ({ data }): Promise<TaskState> => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { isManualKey, validateManualTask } = await import("./tasks");
    // A derived card's words belong to its tracker. Editing them here would put the
    // board's opinion of a booking next to the tracker's and let the two drift.
    if (!isManualKey(data.key)) throw new Error("Only a task you typed can be edited.");
    const problem = validateManualTask(data);
    if (problem) throw new Error(problem);

    const { db, isoOrNull, dayOrNull } = await import("./db.server");
    const sql = await db();
    const rows = await sql<StateRow[]>`
      UPDATE tracker_tasks SET
        column_key = ${data.column}, assignee = ${data.assignee}, note = ${data.note},
        priority = ${data.priority}, due = ${data.due},
        title = ${data.title.slice(0, 200)}, tracker = ${data.tracker},
        ref = ${data.ref}, updated_by = ${session.email}, updated_at = now()
      WHERE key = ${data.key} AND manual = true
      RETURNING key, manual, column_key, assignee, note, priority, due, title, tracker, ref,
                created_by, updated_by, updated_at
    `;
    if (rows.length === 0) throw new Error("That task no longer exists.");
    return toState(rows[0], isoOrNull, dayOrNull);
  });

/**
 * Deletes a task.
 *
 * A manual task goes for good. A derived one cannot be deleted — only its board state
 * can be dropped, which puts the card back where the tracker says it belongs. That is
 * the honest meaning of "remove" here: the work does not stop existing because somebody
 * closed the card.
 */
export const deleteTask = createServerFn({ method: "POST" })
  .validator((input: { key: string }) => ({ key: cleanKey(input?.key) }))
  .handler(async ({ data }): Promise<{ deleted: boolean; manual: boolean }> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { isManualKey } = await import("./tasks");
    const { db } = await import("./db.server");
    const sql = await db();
    const rows = await sql<{ manual: boolean }[]>`
      DELETE FROM tracker_tasks WHERE key = ${data.key} RETURNING manual
    `;
    return { deleted: rows.length > 0, manual: isManualKey(data.key) };
  });
