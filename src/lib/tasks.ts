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

export const TASK_COLUMNS: Array<{ key: TaskColumn; title: string; hint: string }> = [
  { key: "todo", title: "To do", hint: "Everything the trackers say is open, plus what you added" },
  { key: "doing", title: "Doing", hint: "Someone has started — an email out, a call booked" },
  { key: "blocked", title: "Blocked", hint: "Waiting on something outside this team" },
  { key: "done", title: "Done", hint: "Closed by hand, or resolved by the tracker itself" },
];

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
export function derivedKey(tracker: TrackerKey, ref: string, kind: string): string {
  return `${tracker}::${ref}::${kind}`.toLowerCase();
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
  tracker: TrackerKey;
  kind: string;
  /** Booking ref, provider code — whatever the tracker's row is keyed on. */
  ref: string;
  title: string;
  /** The counterparty or booking name, for the card's second line. */
  subject: string | null;
  /** The one figure that matters, already formatted with its currency. */
  amount: string | null;
  /** Whose move the tracker says it is, when it has an opinion. */
  owner: "us" | "partner" | "client" | null;
};

// ── What the board stores ───────────────────────────────────────────────────

/** One row of tracker_tasks: everything the board knows that the trackers do not. */
export type TaskState = {
  key: string;
  column: TaskColumn;
  assignee: string | null;
  note: string | null;
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
  subject: string | null;
  amount: string | null;
  tracker: TrackerKey | null;
  /** Where to go to actually do it. */
  href: string | null;
  ref: string | null;
  assignee: string | null;
  note: string | null;
  due: string | null;
  manual: boolean;
  owner: "us" | "partner" | "client" | null;
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
      amount: item.amount,
      tracker: item.tracker,
      href: trackerPath(item.tracker),
      ref: item.ref,
      assignee: state.assignee,
      note: state.note,
      due: state.due,
      manual: false,
      owner: item.owner,
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
        amount: null,
        tracker: state.tracker,
        href: state.tracker ? trackerPath(state.tracker) : null,
        ref: state.ref,
        assignee: state.assignee,
        note: state.note,
        due: state.due,
        manual: true,
        owner: null,
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
      amount: null,
      tracker: state.tracker,
      href: state.tracker ? trackerPath(state.tracker) : null,
      ref: state.ref,
      assignee: state.assignee,
      note: state.note,
      due: state.due,
      manual: false,
      owner: null,
      open: false,
      staleDone: false,
    });
  }

  return tasks;
}

/** The cards in one column, in the order the board shows them. */
export function columnTasks(tasks: Task[], column: TaskColumn): Task[] {
  return tasks.filter((t) => t.column === column).sort(compareTasks);
}

/**
 * Reading order: what is overdue, then what is dated, then the rest.
 *
 * Money is deliberately not the sort key. A four-figure chase that is three weeks late
 * outranks a five-figure one raised this morning, and sorting by amount would bury it.
 */
export function compareTasks(a: Task, b: Task): number {
  if (a.due !== b.due) {
    if (a.due == null) return 1;
    if (b.due == null) return -1;
    return a.due.localeCompare(b.due);
  }
  const trackerA = a.tracker ?? "";
  const trackerB = b.tracker ?? "";
  return trackerA.localeCompare(trackerB) || (a.ref ?? "").localeCompare(b.ref ?? "");
}

export function isOverdue(task: Task, today: string): boolean {
  return task.due != null && task.column !== "done" && task.due < today;
}

// ── Filters ─────────────────────────────────────────────────────────────────

export type TaskFilter = {
  /** Empty means every tracker, manual tasks included. */
  trackers: string[];
  /** An email, or null for everybody's. */
  assignee: string | null;
  search: string;
};

export const NO_FILTER: TaskFilter = { trackers: [], assignee: null, search: "" };

export function matchesFilter(task: Task, filter: TaskFilter): boolean {
  if (filter.trackers.length > 0) {
    const key = task.manual ? "manual" : (task.tracker ?? "");
    if (!filter.trackers.includes(key)) return false;
  }
  if (filter.assignee != null && (task.assignee ?? "") !== filter.assignee) return false;
  const q = filter.search.trim().toLowerCase();
  if (!q) return true;
  return [task.title, task.subject, task.ref, task.note, task.assignee]
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
    const key = task.manual ? "manual" : (task.tracker ?? "manual");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, n]) => ({
      key,
      label: isTrackerKey(key) ? trackerLabel(key) : "Added by hand",
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
  return null;
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
