/**
 * The task board — pure model, no I/O, so every rule below is unit-tested directly.
 *
 * The board holds two kinds of card and they are not the same thing:
 *
 *  - **Derived** tasks come from the trackers' own action items. Nobody types them and
 *    nobody may edit their text: the booking owes money or it does not, and the tracker
 *    is the authority on that. What the board stores about them is only where the card
 *    sits and who has it — see `TaskState`. When the underlying action resolves, the
 *    task stops being derived and the board says it closed itself rather than letting
 *    a card silently disappear from under someone.
 *  - **Manual** tasks are typed by a person and live entirely in the board. They are the
 *    only ones that can be edited or deleted.
 *
 * The distinction is what keeps the board honest. A workflow column is an opinion about
 * work in progress; whether a provider has actually been paid is a fact from the
 * ledger, and one must never be allowed to overwrite the other. So a card parked in
 * Done while its action is still open is shown in Done **and** flagged, rather than
 * being quietly reopened or quietly believed.
 */
import { isTrackerKey, trackerLabel, trackerPath, type TrackerKey } from "./trackers.ts";

// ── Columns ─────────────────────────────────────────────────────────────────

export type TaskColumn = "todo" | "doing" | "blocked" | "done";

/**
 * The four columns, with everything the header and the empty state need.
 *
 * `hint` is the two-or-three words under the count that say what the column *means* —
 * "on someone else" is the difference between a card being stuck and a card being ignored.
 * `empty` is what an empty column says, and each one names a state rather than apologising:
 * a column with nothing in it is good news and should read like it.
 */
export const TASK_COLUMNS: Array<{
  key: TaskColumn;
  title: string;
  /** The header dot. */
  dot: string;
  hint: string;
  empty: string;
}> = [
  {
    key: "todo",
    title: "To do",
    dot: "#9CA3AF",
    hint: "not started",
    empty: "Nothing waiting to start",
  },
  { key: "doing", title: "Doing", dot: "#B4570B", hint: "you are on it", empty: "Nothing started" },
  {
    key: "blocked",
    title: "Blocked",
    dot: "#0F766E",
    hint: "on someone else",
    empty: "Nothing blocked",
  },
  { key: "done", title: "Done", dot: "#1A7F37", hint: "closed", empty: "Nothing closed yet" },
];

export function columnMeta(column: TaskColumn): (typeof TASK_COLUMNS)[number] {
  return TASK_COLUMNS.find((c) => c.key === column) ?? TASK_COLUMNS[0];
}

export const COLUMN_ORDER: TaskColumn[] = TASK_COLUMNS.map((c) => c.key);

export function isTaskColumn(value: unknown): value is TaskColumn {
  return typeof value === "string" && (COLUMN_ORDER as string[]).includes(value);
}

export function columnTitle(column: TaskColumn): string {
  return TASK_COLUMNS.find((c) => c.key === column)?.title ?? column;
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * A derived task's key, stable across refreshes.
 *
 * Three parts because all three are needed to be unique: the tracker, what the task is
 * about, and which of several jobs on it this is. A booking with a provider to pay and
 * a commission to claw back is two tasks on one booking, and the board has to be able
 * to hold one in Doing while the other sits in To do.
 *
 * Manual tasks never come through here — their key is `manual::<uuid>`, minted once by
 * the database so it cannot collide with a derived one.
 */
export function derivedKey(tracker: TrackerKey | null, ref: string, kind: string): string {
  return `${tracker ?? "slack"}::${ref}::${kind}`.toLowerCase();
}

export function isManualKey(key: string): boolean {
  return key.startsWith("manual::");
}

// ── What a tracker contributes ──────────────────────────────────────────────

/**
 * One action item, as a tracker reports it.
 *
 * `kind` is the tracker's own name for the job — "pay", "recover-commission",
 * "card-decision" — and is what makes the key unique per booking. `title` is the
 * sentence the board shows, and it is the tracker's wording rather than the board's, so
 * the two pages never describe the same job differently.
 */
export type DerivedTask = {
  /**
   * Null for a task that came from somebody's own Slack rather than from a tracker.
   * Those are personal: the server only ever reads them for the session's own account,
   * and they are never shown to anyone else on this shared board.
   */
  tracker: TrackerKey | null;
  kind: string;
  /** Booking ref, provider code — whatever the tracker's row is keyed on. */
  ref: string;
  title: string;
  /** The counterparty or booking name, for the card's second line. */
  subject: string | null;
  /**
   * The tracker's own sentence about this job, shown in the drawer.
   *
   * The card's title says what to do; this says what the tracker actually observed, in the
   * tracker's words. Keeping both means the board can be verb-led without paraphrasing the
   * page it came from.
   */
  detail?: string | null;
  /** The one figure that matters, already formatted with its currency. */
  amount: string | null;
  /** Whose move the tracker says it is, when it has an opinion. */
  owner: "us" | "partner" | "client" | null;
  /** Where to go when there is no tracker page — a Slack deep link. */
  permalink?: string | null;
  /** Slack items arrive with a date already on them. */
  due?: string | null;
  /** Shown on the card instead of a tracker name. */
  sourceLabel?: string | null;
};

// ── What the board stores ───────────────────────────────────────────────────

/**
 * Urgency, and the only thing on a card a person sets that the trackers cannot.
 *
 * Deliberately two values. A three-level priority invites the whole board to be Medium,
 * and the question this answers is binary: does this jump the queue or not.
 */
export type TaskPriority = "normal" | "urgent";

export function isTaskPriority(value: unknown): value is TaskPriority {
  return value === "normal" || value === "urgent";
}

/** One row of tracker_tasks: everything the board knows that the trackers do not. */
export type TaskState = {
  key: string;
  column: TaskColumn;
  assignee: string | null;
  note: string | null;
  priority: TaskPriority;
  /** ISO day. */
  due: string | null;
  /** Manual tasks carry their own text; derived ones take it from the tracker. */
  manual: boolean;
  title: string | null;
  tracker: TrackerKey | null;
  ref: string | null;
  created_by: string | null;
  updated_by: string | null;
  /** ISO timestamp. */
  updated_at: string | null;
};

// ── The card the board renders ──────────────────────────────────────────────

export type Task = {
  key: string;
  column: TaskColumn;
  title: string;
  /** "Card tracking NA", or "Slack" for somebody's own reminder. */
  sourceLabel?: string | null;
  subject: string | null;
  /** What the source says about it, in the source's own words. */
  detail: string | null;
  amount: string | null;
  tracker: TrackerKey | null;
  /** Where to go to actually do it. */
  href: string | null;
  ref: string | null;
  assignee: string | null;
  note: string | null;
  due: string | null;
  priority: TaskPriority;
  manual: boolean;
  owner: "us" | "partner" | "client" | null;
  /** Who typed it, for a manual card. */
  createdBy: string | null;
  /** ISO timestamp of the last time somebody touched the card here. */
  updatedAt: string | null;
  /** False once the tracker no longer reports it: the work resolved itself. */
  open: boolean;
  /**
   * Someone parked it in Done but the tracker still says the money is outstanding.
   * Shown rather than corrected: the board does not get to overrule the ledger, and
   * whoever moved it may know something the data does not.
   */
  staleDone: boolean;
};

const EMPTY_STATE: Omit<TaskState, "key"> = {
  column: "todo",
  assignee: null,
  note: null,
  priority: "normal",
  due: null,
  manual: false,
  title: null,
  tracker: null,
  ref: null,
  created_by: null,
  updated_by: null,
  updated_at: null,
};

/**
 * The board, from what the trackers report and what it has stored.
 *
 * Three populations, in this order:
 *
 *  1. Every action item a tracker currently reports. Its column comes from the stored
 *     state when someone has moved it, and is To do otherwise — so an untouched task
 *     costs no database row at all and can never be orphaned.
 *  2. Stored derived tasks the trackers no longer report. The work resolved: they land
 *     in Done, flagged `open: false`. They are kept rather than dropped because a card
 *     that vanishes from Doing looks like a bug, and "the provider paid, so this closed
 *     itself" is worth reading.
 *  3. Manual tasks, which are whatever they were typed as.
 */
export function buildBoard(derived: DerivedTask[], stored: TaskState[]): Task[] {
  const byKey = new Map(stored.map((s) => [s.key, s]));
  const seen = new Set<string>();
  const tasks: Task[] = [];

  for (const item of derived) {
    const key = derivedKey(item.tracker, item.ref, item.kind);
    if (seen.has(key)) continue;
    seen.add(key);
    const state = byKey.get(key) ?? { ...EMPTY_STATE, key };
    tasks.push({
      key,
      column: state.column,
      title: item.title,
      subject: item.subject,
      detail: item.detail ?? null,
      amount: item.amount,
      tracker: item.tracker,
      sourceLabel: item.sourceLabel ?? null,
      href: item.tracker ? trackerPath(item.tracker) : (item.permalink ?? null),
      ref: item.ref,
      assignee: state.assignee,
      note: state.note,
      // A Slack reminder carries its own date; anything typed on the board wins.
      due: state.due ?? item.due ?? null,
      priority: state.priority,
      manual: false,
      owner: item.owner,
      createdBy: state.created_by,
      updatedAt: state.updated_at,
      open: true,
      staleDone: state.column === "done",
    });
  }

  for (const state of stored) {
    if (seen.has(state.key)) continue;
    seen.add(state.key);
    if (state.manual) {
      tasks.push({
        key: state.key,
        column: state.column,
        title: state.title ?? "Untitled task",
        subject: null,
        detail: null,
        amount: null,
        tracker: state.tracker,
        href: state.tracker ? trackerPath(state.tracker) : null,
        ref: state.ref,
        assignee: state.assignee,
        note: state.note,
        due: state.due,
        priority: state.priority,
        manual: true,
        owner: null,
        createdBy: state.created_by,
        updatedAt: state.updated_at,
        open: state.column !== "done",
        staleDone: false,
      });
      continue;
    }
    // Derived, stored, and no longer reported: the tracker closed it.
    tasks.push({
      key: state.key,
      column: "done",
      title: state.title ?? "Resolved",
      subject: null,
      detail: null,
      amount: null,
      tracker: state.tracker,
      href: state.tracker ? trackerPath(state.tracker) : null,
      ref: state.ref,
      assignee: state.assignee,
      note: state.note,
      due: state.due,
      priority: state.priority,
      manual: false,
      owner: null,
      createdBy: state.created_by,
      updatedAt: state.updated_at,
      open: false,
      staleDone: false,
    });
  }

  return tasks;
}

/** The cards in one column, in the order the board shows them. */
export function columnTasks(tasks: Task[], column: TaskColumn, today = ""): Task[] {
  return tasks.filter((t) => t.column === column).sort((a, b) => compareTasks(a, b, today));
}

/**
 * How far up the column a card sits: urgent first, then late, then everything else.
 *
 * Two ranks rather than four buckets, because urgency and lateness are different claims —
 * somebody said this one jumps the queue, and the calendar says this one already slipped —
 * and a card that is both belongs above either.
 */
export function rankTask(task: Task, today: string): number {
  let rank = task.priority === "urgent" ? 0 : 2;
  if (isOverdue(task, today)) rank -= 1;
  return rank;
}

/**
 * Reading order: urgent, then overdue, then by date, then the rest.
 *
 * Money is deliberately not the sort key. A four-figure chase that is three weeks late
 * outranks a five-figure one raised this morning, and sorting by amount would bury it.
 *
 * `today` is passed in rather than read from the clock so the order is a pure function of
 * its inputs — and so a test can put a board on any day it likes. Without it the lateness
 * half of the rank simply does not apply.
 */
export function compareTasks(a: Task, b: Task, today = ""): number {
  const rank = rankTask(a, today) - rankTask(b, today);
  if (rank !== 0) return rank;
  if (a.due !== b.due) {
    if (a.due == null) return 1;
    if (b.due == null) return -1;
    return a.due.localeCompare(b.due);
  }
  const trackerA = a.tracker ?? "";
  const trackerB = b.tracker ?? "";
  return trackerA.localeCompare(trackerB) || (a.ref ?? "").localeCompare(b.ref ?? "");
}

/**
 * The list view's order: by column first, then by the board's own rule inside each.
 *
 * The column grouping is the point. Sorted purely by date, July's closed work sits in the
 * middle of what is still open, and the table stops being readable top to bottom.
 */
export function listOrder(tasks: Task[], today = ""): Task[] {
  return [...tasks].sort(
    (a, b) =>
      COLUMN_ORDER.indexOf(a.column) - COLUMN_ORDER.indexOf(b.column) || compareTasks(a, b, today),
  );
}

export function isOverdue(task: Task, today: string): boolean {
  return task.due != null && task.column !== "done" && task.due < today;
}

// ── Dates, as a card says them ──────────────────────────────────────────────

/** The six tones a pill can take, mapped to the design system's pastel pairs. */
export type PillTone =
  "neutral" | "green" | "red" | "amber" | "orange" | "teal" | "lime" | "lavender";

export const PILL_TONES: Record<PillTone, string> = {
  neutral: "bg-[#F3F4F6] text-[#6B7280]",
  green: "bg-[#E7F6EC] text-[#1A7F37]",
  red: "bg-[#FDECEC] text-[#B4534B]",
  amber: "bg-[#FEF3D7] text-[#854F0B]",
  orange: "bg-[#FEECD6] text-[#B4570B]",
  teal: "bg-[#E8F6F9] text-[#0F766E]",
  lime: "bg-[#F6F9D8] text-[#5B6511]",
  lavender: "bg-[#EDE9FE] text-[#6D28D9]",
};

/**
 * The due pill: a date said the way somebody would say it out loud.
 *
 * "5d overdue" and "Tomorrow" are read at a glance; "2026-07-29" has to be worked out
 * against today's date first, which on a board of thirty cards is thirty subtractions. The
 * exact day is still there for anything further out, because "in 9 days" is not how anyone
 * schedules a payment run.
 */
export function dueInfo(task: Task, today: string): { label: string; tone: PillTone } {
  if (!task.due) return { label: "No date", tone: "neutral" };
  const nice = formatDay(task.due);
  if (task.column === "done") return { label: nice, tone: "green" };
  const days = daysBetween(today, task.due);
  if (days == null) return { label: nice, tone: "neutral" };
  if (days < 0) return { label: `${Math.abs(days)}d overdue`, tone: "red" };
  if (days === 0) return { label: "Today", tone: "amber" };
  if (days === 1) return { label: "Tomorrow", tone: "amber" };
  return { label: nice, tone: "neutral" };
}

/** Whole days from one ISO day to another, or null if either is not a day. */
export function daysBetween(from: string, to: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** `Aug 12` — short month, no year, because every card on this board is this year's. */
export function formatDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const date = new Date(`${day}T00:00:00Z`);
  return date.toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
}

// ── Where a card came from ──────────────────────────────────────────────────

/**
 * The badge on a card: which tracker it belongs to, or that nobody's tracker owns it.
 *
 * Each tracker keeps the tint it has elsewhere in the app, so a card and the page it came
 * from are recognisably the same thing.
 */
export function trackerBadge(task: Task): { label: string; tone: PillTone } {
  if (task.manual) return { label: "Added by hand", tone: "neutral" };
  if (task.tracker == null) return { label: task.sourceLabel ?? "My Slack", tone: "teal" };
  const tones: Record<string, PillTone> = {
    loreal: "lavender",
    veolia: "teal",
    na: "lime",
    "na-commissions": "amber",
    "na-cards": "orange",
  };
  return { label: trackerLabel(task.tracker), tone: tones[task.tracker] ?? "neutral" };
}

/**
 * What kind of thing this is, in the words the source uses.
 *
 * The board's own vocabulary, not a tracker's internal `kind`: a reader filtering by
 * "Card decision" should not have to know it is called `card-decide` in the database.
 */
/**
 * The ref worth printing on a card, or null.
 *
 * A booking ref means something to a reader — a Slack message id ("C1:2.2") does not, and
 * printing it where a ref goes suggests it is one.
 */
export function refLabel(task: Task): string | null {
  if (!task.ref) return null;
  if (!task.manual && task.tracker == null) return null;
  return task.ref;
}

/**
 * What will make this card go away, said in one sentence.
 *
 * Three different promises, because three different things are true. A tracker card is a
 * projection and vanishes when the tracker stops reporting the work. A Slack reminder or
 * saved message goes when it is dealt with in Slack, which is where it lives. A mention is
 * an event: nothing will ever un-say it, so it ages out after a week and moving it to Done
 * is how a person marks it handled. Promising "it closes itself" for all three would be
 * wrong for two of them.
 */
export function resolveHint(task: Task): string {
  if (task.manual) {
    return "A task you typed stays until you close it — nothing resolves it for you.";
  }
  if (!task.open) return "The source stopped reporting it, so it closed itself.";
  if (task.tracker != null) {
    return "It leaves the board on its own once the tracker stops reporting the work — nobody has to close it.";
  }
  const kind = task.key.split("::")[2] ?? "";
  if (kind === "slack-mention") {
    return "A mention is kept for a week and then forgotten — move it to Done once you have dealt with it.";
  }
  return "Completing it in Slack is what closes it here.";
}

export function sourceLabel(task: Task): string {
  if (task.manual) return "Added by hand";
  const kind = task.key.split("::")[2] ?? "";
  const labels: Record<string, string> = {
    "card-ask": "Card question",
    "card-decide": "Card decision",
    "rate-mismatch": "Commission rate",
    "slack-reminder": "Slack reminder",
    "slack-saved": "Saved in Slack",
    "slack-mention": "Slack mention",
  };
  return labels[kind] ?? (task.tracker ? "Tracker action" : "My Slack");
}

// ── Filters ─────────────────────────────────────────────────────────────────

export type TaskFilter = {
  /** Empty means every tracker, manual tasks included. */
  trackers: string[];
  /** An email, "none" for unassigned, or null for everybody's. */
  assignee: string | null;
  search: string;
  /** A `sourceLabel`, or null for every kind. */
  source?: string | null;
  /** True to show only what is urgent. */
  urgentOnly?: boolean;
};

export const NO_FILTER: TaskFilter = {
  trackers: [],
  assignee: null,
  search: "",
  source: null,
  urgentOnly: false,
};

/** Is anything narrowing the board right now? Drives the "filtered by" row. */
export function isFiltered(filter: TaskFilter): boolean {
  return (
    filter.trackers.length > 0 ||
    filter.assignee != null ||
    filter.search.trim() !== "" ||
    (filter.source ?? null) != null ||
    filter.urgentOnly === true
  );
}

export function matchesFilter(task: Task, filter: TaskFilter): boolean {
  if (filter.trackers.length > 0) {
    const key = task.manual ? "manual" : (task.tracker ?? "slack");
    if (!filter.trackers.includes(key)) return false;
  }
  // "none" is a real answer to "whose is this?", and the one people look for most.
  if (filter.assignee === "none" && task.assignee != null) return false;
  if (filter.assignee != null && filter.assignee !== "none" && task.assignee !== filter.assignee) {
    return false;
  }
  if (filter.source != null && sourceLabel(task) !== filter.source) return false;
  if (filter.urgentOnly === true && task.priority !== "urgent") return false;
  const q = filter.search.trim().toLowerCase();
  if (!q) return true;
  return [task.title, task.subject, task.detail, task.ref, task.note, task.assignee]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(q);
}

/** How many cards sit in each column, after filtering. */
export function columnCounts(tasks: Task[]): Record<TaskColumn, number> {
  const counts = { todo: 0, doing: 0, blocked: 0, done: 0 };
  for (const task of tasks) counts[task.column] += 1;
  return counts;
}

/** Which trackers are represented, for the filter chips — with their counts. */
export function trackerCounts(tasks: Task[]): Array<{ key: string; label: string; n: number }> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const key = task.manual ? "manual" : (task.tracker ?? "slack");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, n]) => ({
      key,
      label: isTrackerKey(key) ? trackerLabel(key) : key === "slack" ? "My Slack" : "Added by hand",
      n,
    }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

// ── Validating what a person types ──────────────────────────────────────────

export type ManualTaskInput = {
  title: string;
  tracker: string | null;
  ref: string | null;
  assignee: string | null;
  due: string | null;
  note: string | null;
  column: string;
  priority?: string;
};

/** What must hold before a typed task can be saved. Checked in the UI and again on the server. */
export function validateManualTask(input: ManualTaskInput): string | null {
  if (input.title.trim().length === 0) return "Give the task a title.";
  if (input.title.trim().length > 200) return "Keep the title under 200 characters.";
  if (input.tracker != null && input.tracker !== "" && !isTrackerKey(input.tracker)) {
    return "That is not one of the trackers.";
  }
  if (input.due != null && input.due !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(input.due)) {
    return "The due date has to be a day, as YYYY-MM-DD.";
  }
  if (!isTaskColumn(input.column)) return "That is not one of the columns.";
  if (input.priority != null && !isTaskPriority(input.priority))
    return "Priority is normal or urgent.";
  return null;
}

/** Every kind of card actually on the board, for the source select. */
export function sourceOptions(tasks: Task[]): Array<{ label: string; n: number }> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const label = sourceLabel(task);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts]
    .map(([label, n]) => ({ label, n }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

/** The three numbers on the summary strip, and nothing a reader has to take on trust. */
export function boardStats(
  tasks: Task[],
  today: string,
): { open: number; automatic: number; resolved: number; overdue: number; urgent: number } {
  let open = 0,
    automatic = 0,
    resolved = 0,
    overdue = 0,
    urgent = 0;
  for (const task of tasks) {
    if (task.open) open += 1;
    else resolved += 1;
    // "Automatic" is the honest word for it: nobody typed this card and nobody has to
    // close it — it goes when the tracker stops reporting the work.
    if (!task.manual) automatic += 1;
    if (isOverdue(task, today)) overdue += 1;
    if (task.priority === "urgent" && task.open) urgent += 1;
  }
  return { open, automatic, resolved, overdue, urgent };
}

/** `shayma` — a name short enough for an avatar chip, from the mailbox. */
export function shortName(email: string | null | undefined): string {
  const raw = (email ?? "").trim();
  if (!raw) return "";
  return (raw.split("@")[0] ?? raw).replace(/[._-]+/g, " ");
}

export function initials(email: string | null | undefined): string {
  const parts = shortName(email).split(" ").filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
