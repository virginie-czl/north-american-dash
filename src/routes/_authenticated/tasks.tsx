/**
 * Tasks — one board across every tracker, plus whatever you add by hand.
 *
 * The cards come from two places and the difference is visible on purpose. A derived
 * card restates a tracker's own action item: its words and its figure belong to that
 * page, it cannot be edited here, and it disappears when the tracker says the work is
 * done — which is what the "Automatic" badge promises. A card somebody typed is theirs
 * entirely, and stays until they close it.
 *
 * What the board owns is the column, the assignee, the due date, the priority and the
 * note — the part no query can know. That state is remembered per card, so dragging a
 * derived task into Doing survives a data refresh, and a card parked in Done while the
 * money is still outstanding says so rather than being quietly believed or reopened.
 *
 * Every card title is a verb phrase: the board says what to do, not what state a row is
 * in. The wording is the tracker's own, so the same job reads the same on both pages.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  GripVertical,
  Hash,
  LayoutGrid,
  List,
  Plus,
  Search,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  COLUMN_ORDER,
  TASK_COLUMNS,
  PILL_TONES,
  boardStats,
  columnMeta,
  columnTasks,
  dueInfo,
  formatDay,
  initials,
  isFiltered,
  listOrder,
  matchesFilter,
  refLabel,
  resolveHint,
  shortName,
  sourceLabel,
  sourceOptions,
  trackerBadge,
  trackerCounts,
  validateManualTask,
  type ManualTaskInput,
  type PillTone,
  type Task,
  type TaskColumn,
  type TaskFilter,
} from "@/lib/tasks";
import {
  createManualTask,
  deleteTask,
  fetchBoard,
  saveTaskState,
  updateManualTask,
} from "@/lib/tasks.functions";
import { TRACKERS, trackerLabel, type TrackerKey } from "@/lib/trackers";
import { useRegisterTrackerActions } from "@/components/tracker-chrome";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/tasks")({
  ssr: false,
  /**
   * Access to the board is given and taken like a tracker's.
   *
   * Presentation only — fetchBoard and every mutation ask again on the server, so a
   * revoked person who keeps the URL gets a 403 rather than an empty page. Sending them
   * to a tracker they do have beats a dead end; if they have none at all, the auth screen
   * is the only honest destination.
   */
  beforeLoad: ({ context }) => {
    const allowed = (context as { allowedTrackers?: string[] }).allowedTrackers ?? [];
    if (!allowed.includes("tasks")) {
      const fallback = TRACKERS.find((t) => allowed.includes(t.key));
      throw redirect(
        fallback ? { to: fallback.path } : { to: "/auth", search: { status: "no-tracker" } },
      );
    }
  },
  component: TasksPage,
});

const today = () => new Date().toISOString().slice(0, 10);

// The shared shapes of the toolbar's controls, kept in one place so the row lines up.
const CONTROL =
  "h-8 rounded-md border border-input bg-white px-2 text-[12px] text-navy shadow-[0_1px_2px_rgba(16,31,52,0.06)]";
const BAND = "flex flex-none flex-wrap items-center gap-2 border-b border-border bg-white px-5";

function TasksPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [tracker, setTracker] = useState("all");
  const [assignee, setAssignee] = useState("all");
  const [source, setSource] = useState("all");
  const [view, setView] = useState<"board" | "list">("board");
  const [adding, setAdding] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<TaskColumn | null>(null);
  const [quickColumn, setQuickColumn] = useState<TaskColumn | null>(null);
  const [quickText, setQuickText] = useState("");

  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      return res.ok ? ((await res.json()) as { email: string }) : null;
    },
    staleTime: 5 * 60_000,
  });

  const board = useQuery({
    queryKey: ["tasks-board"],
    queryFn: () => fetchBoard(),
    staleTime: 60_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tasks-board"] });

  const move = useMutation({
    mutationFn: (input: Parameters<typeof saveTaskState>[0]["data"]) =>
      saveTaskState({ data: input }),
    onSuccess: invalidate,
    onError: (error) => console.error("moving the task failed:", error),
  });
  const create = useMutation({
    mutationFn: (input: ManualTaskInput) => createManualTask({ data: input }),
    onSuccess: () => {
      setAdding(false);
      setQuickColumn(null);
      setQuickText("");
      invalidate();
    },
  });
  const update = useMutation({
    mutationFn: (input: ManualTaskInput & { key: string }) => updateManualTask({ data: input }),
    onSuccess: () => {
      setOpenKey(null);
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (key: string) => deleteTask({ data: { key } }),
    onSuccess: () => {
      setOpenKey(null);
      invalidate();
    },
  });

  const tasks = board.data?.tasks ?? [];
  const day = today();
  const filter: TaskFilter = useMemo(
    () => ({
      trackers: tracker === "all" ? [] : [tracker],
      assignee: assignee === "all" ? null : assignee,
      source: source === "all" ? null : source,
      search,
    }),
    [tracker, assignee, source, search],
  );
  const shown = useMemo(() => tasks.filter((t) => matchesFilter(t, filter)), [tasks, filter]);
  const stats = useMemo(() => boardStats(shown, day), [shown, day]);
  const byTracker = useMemo(() => trackerCounts(tasks), [tasks]);
  const sources = useMemo(() => sourceOptions(tasks), [tasks]);
  const feeds = board.data?.feeds ?? [];
  const people = board.data?.people ?? [];
  const slack = board.data?.slack;
  const open = openKey ? (tasks.find((t) => t.key === openKey) ?? null) : null;

  const slackSync = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/slack/sync", { method: "POST", credentials: "include" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Slack sync failed (${res.status})`);
      }
      return (await res.json()) as { items: number };
    },
    onSuccess: invalidate,
  });
  const slackOff = useMutation({
    mutationFn: async () => {
      await fetch("/api/slack/disconnect", { method: "POST", credentials: "include" });
    },
    onSuccess: invalidate,
  });
  const brokenFeeds = feeds.filter((f) => f.error != null);
  const mySlack = tasks.filter((t) => !t.manual && t.tracker == null).length;

  useRegisterTrackerActions(
    {
      onRefresh: () => board.refetch().then(() => undefined),
      isFetching: board.isFetching,
      exports: [
        {
          label: "Export tasks",
          onClick: () => exportTasks(listOrder(shown, day), day),
          disabled: shown.length === 0,
        },
      ],
    },
    [board.isFetching, shown, day],
  );

  /** Everything the board can change on a card, in one call. */
  function patch(task: Task, change: Partial<Task>) {
    move.mutate({
      key: task.key,
      column: change.column ?? task.column,
      assignee: change.assignee !== undefined ? change.assignee : task.assignee,
      note: change.note !== undefined ? change.note : task.note,
      due: change.due !== undefined ? change.due : task.due,
      priority: change.priority ?? task.priority,
      title: task.title,
      tracker: task.tracker,
      ref: task.ref,
    });
  }

  /**
   * The dropped card's key travels on the DataTransfer rather than in React state.
   *
   * State works only because a re-render normally lands between dragstart and drop; a
   * fast drag — or a synthetic one — arrives with the handler still closed over the old
   * null and silently does nothing. The browser's own channel for exactly this is the
   * DataTransfer, so that is what carries it, and the state is left to the highlight.
   */
  function drop(column: TaskColumn, key: string | null) {
    setDragKey(null);
    setDragOver(null);
    if (!key) return;
    const task = tasks.find((t) => t.key === key);
    if (!task || task.column === column) return;
    patch(task, { column });
  }

  function addQuick(column: TaskColumn, text: string) {
    if (!text.trim()) return;
    create.mutate({
      title: text.trim(),
      tracker: null,
      ref: null,
      assignee: null,
      due: null,
      note: null,
      column,
      priority: "normal",
    });
  }

  const clearAll = () => {
    setTracker("all");
    setAssignee("all");
    setSource("all");
    setSearch("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <h1 className="sr-only">Tasks</h1>

      {/* Summary strip — the three numbers that decide whether to keep reading. */}
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border bg-slate-50 px-5 py-[9px]">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">
          Task list
        </span>
        <Stat label="Open" value={stats.open} className="ml-2" />
        <Stat label="Automatic" value={stats.automatic} />
        <Stat label="Resolved" value={stats.resolved} />
        {stats.overdue > 0 && (
          <span className="inline-flex items-center rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-semibold text-rose-800">
            {stats.overdue} overdue
          </span>
        )}
        {board.isLoading && <span className="text-[12px] text-slate-500">Loading the board…</span>}
        <span className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-slate-500">
          <GripVertical className="h-3 w-3 text-slate-300" aria-hidden="true" />
          Drag a card to change its column · click it to open the detail
        </span>
      </div>

      {/* Toolbar */}
      <div className={`${BAND} py-2.5`}>
        <label className="relative flex items-center">
          <Search
            className="pointer-events-none absolute left-[9px] h-3.5 w-3.5 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks, refs, partners…"
            aria-label="Search tasks"
            className={`${CONTROL} w-[260px] pl-7`}
          />
        </label>

        <select
          aria-label="Tracker"
          value={tracker}
          onChange={(e) => setTracker(e.target.value)}
          className={`${CONTROL} cursor-pointer`}
        >
          <option value="all">All trackers</option>
          {byTracker.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label} ({t.n})
            </option>
          ))}
        </select>

        <select
          aria-label="Assignee"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          className={`${CONTROL} cursor-pointer`}
        >
          <option value="all">Everyone</option>
          {me.data?.email && <option value={me.data.email}>Mine</option>}
          {people
            .filter((p) => p !== me.data?.email)
            .map((p) => (
              <option key={p} value={p}>
                {shortName(p)}
              </option>
            ))}
          <option value="none">Unassigned</option>
        </select>

        <select
          aria-label="Kind of task"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className={`${CONTROL} cursor-pointer`}
        >
          <option value="all">All sources</option>
          {sources.map((s) => (
            <option key={s.label} value={s.label}>
              {s.label} ({s.n})
            </option>
          ))}
        </select>

        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-slate-100 p-0.5">
          <ViewButton active={view === "board"} onClick={() => setView("board")}>
            <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
            Board
          </ViewButton>
          <ViewButton active={view === "list"} onClick={() => setView("list")}>
            <List className="h-3.5 w-3.5" aria-hidden="true" />
            List
          </ViewButton>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Slack, the same shape as the other toolbar buttons. It only ever reads the
              person pressing it — the band below says so when there is anything to say. */}
          {slack?.connected ? (
            <button
              type="button"
              onClick={() => slackSync.mutate()}
              disabled={slackSync.isPending}
              title="Pull your own Slack reminders, saved messages and mentions now"
              className={`${CONTROL} inline-flex items-center gap-1.5 whitespace-nowrap px-3 font-medium [&:hover]:bg-slate-50`}
            >
              <Hash
                className={`h-3.5 w-3.5 ${slackSync.isPending ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              {slackSync.isPending ? "Reading your Slack…" : `My Slack (${mySlack})`}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                window.location.href = "/api/slack/connect";
              }}
              className={`${CONTROL} inline-flex items-center gap-1.5 whitespace-nowrap px-3 font-medium [&:hover]:bg-slate-50`}
            >
              <Hash className="h-3.5 w-3.5" aria-hidden="true" />
              Connect Slack
            </button>
          )}
          <span className="h-5 w-px bg-border" aria-hidden="true" />
          <Button variant="naboo" size="naboo" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add task
          </Button>
        </div>
      </div>

      {/* What is being hidden right now, spelled out. A filtered board that looks
          unfiltered is how people conclude there is no work left. */}
      {isFiltered(filter) && (
        <div className={`${BAND} py-2`}>
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">
            Filtered by
          </span>
          {tracker !== "all" && (
            <Chip
              label={byTracker.find((t) => t.key === tracker)?.label ?? tracker}
              onClear={() => setTracker("all")}
            />
          )}
          {assignee !== "all" && (
            <Chip
              label={
                assignee === "none"
                  ? "Unassigned"
                  : assignee === me.data?.email
                    ? "Mine"
                    : shortName(assignee)
              }
              onClear={() => setAssignee("all")}
            />
          )}
          {source !== "all" && <Chip label={source} onClear={() => setSource("all")} />}
          {search.trim() !== "" && (
            <Chip label={`“${search.trim()}”`} onClear={() => setSearch("")} />
          )}
          <button
            type="button"
            onClick={clearAll}
            className="text-[11.5px] text-[#0F766E] [&:hover]:underline"
          >
            Clear all
          </button>
          <span className="ml-auto text-[11.5px] text-slate-500">
            {shown.length === 1 ? "1 task shown" : `${shown.length} tasks shown`}
          </span>
        </div>
      )}

      {/* Slack, only when there is something to say about it. */}
      {slack != null && (slack.needsReconnect || !slack.connected || slack.error != null) && (
        <div className={`${BAND} py-2 text-[11.5px]`}>
          <Hash className="h-3.5 w-3.5 flex-none text-slate-400" aria-hidden="true" />
          {slack.error != null ? (
            <span className="text-rose-800">Slack: {slack.error}</span>
          ) : slack.needsReconnect ? (
            <>
              <span className="text-navy">
                Your Slack connection predates mentions, so your Activity is not being read.
              </span>
              <button
                type="button"
                onClick={() => {
                  window.location.href = "/api/slack/connect";
                }}
                className="text-[#0F766E] [&:hover]:underline"
              >
                Reconnect for mentions
              </button>
            </>
          ) : (
            <span className="text-slate-500">
              Connect Slack to put your own reminders, saved messages and mentions on this board —
              your own Activity only, never anyone else&apos;s.
            </span>
          )}
          {slack.connected && (
            <button
              type="button"
              onClick={() => slackOff.mutate()}
              disabled={slackOff.isPending}
              className="ml-auto text-slate-500 [&:hover]:text-navy"
              title="Revokes the token at Slack and removes your Slack cards from this board"
            >
              Disconnect Slack
            </button>
          )}
        </div>
      )}
      {slack?.connected && slack.syncedAt && (
        <span className="sr-only">Slack last pulled {slack.syncedAt}</span>
      )}

      {/* A feed that failed is named. A board silently missing a tracker reads as a
          tracker with nothing to do. */}
      {(brokenFeeds.length > 0 ||
        board.error != null ||
        move.isError ||
        create.isError ||
        update.isError ||
        remove.isError ||
        slackSync.isError) && (
        <div
          role="alert"
          className="flex-none border-b border-rose-200 bg-rose-50 px-5 py-2 text-[12px] text-rose-800"
        >
          {brokenFeeds.map((f) => (
            <div key={f.tracker}>
              {trackerLabel(f.tracker)} could not be read, so its tasks are missing: {f.error}
            </div>
          ))}
          {board.error != null && (
            <div>The board could not be loaded: {String((board.error as Error).message)}</div>
          )}
          {(move.isError ||
            create.isError ||
            update.isError ||
            remove.isError ||
            slackSync.isError) && (
            <div>
              {String(
                (
                  (move.error ??
                    create.error ??
                    update.error ??
                    remove.error ??
                    slackSync.error) as Error
                )?.message,
              )}
            </div>
          )}
        </div>
      )}

      {view === "board" ? (
        <div className="grid min-h-0 flex-1 grid-cols-4 gap-3 px-5 pb-[18px] pt-3.5">
          {TASK_COLUMNS.map((col) => {
            const list = columnTasks(shown, col.key, day);
            return (
              <section
                key={col.key}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(col.key);
                }}
                onDragLeave={() => setDragOver((c) => (c === col.key ? null : c))}
                onDrop={(e) => drop(col.key, e.dataTransfer.getData("text/plain") || dragKey)}
                className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-border bg-slate-50"
              >
                <div className="flex flex-none items-center gap-2 border-b border-border bg-white px-3 py-[9px]">
                  <span
                    className="inline-block h-[7px] w-[7px] flex-none rounded-full"
                    style={{ background: col.dot }}
                    aria-hidden="true"
                  />
                  <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-700">
                    {col.title}
                  </span>
                  <span className="rounded-full bg-slate-100 px-[7px] py-px text-[10.5px] font-semibold tabular-nums text-slate-600">
                    {list.length}
                  </span>
                  <span className="ml-auto text-[10.5px] text-slate-400">{col.hint}</span>
                </div>

                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
                  {/* Where the card would land. */}
                  {dragOver === col.key && (
                    <span className="h-[3px] flex-none rounded-full bg-naboo" aria-hidden="true" />
                  )}
                  {list.length === 0 && !board.isLoading ? (
                    <p className="m-0 px-1 py-1 text-[11.5px] text-slate-400">{col.empty}</p>
                  ) : (
                    list.map((task) => (
                      <TaskCard
                        key={task.key}
                        task={task}
                        day={day}
                        dragging={dragKey === task.key}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", task.key);
                          e.dataTransfer.effectAllowed = "move";
                          setDragKey(task.key);
                        }}
                        onDragEnd={() => setDragKey(null)}
                        onOpen={() => setOpenKey(task.key)}
                      />
                    ))
                  )}
                </div>

                <div className="flex-none border-t border-border bg-white px-2.5 py-[7px]">
                  {quickColumn === col.key ? (
                    <div className="flex flex-col gap-1.5">
                      <input
                        autoFocus
                        value={quickText}
                        onChange={(e) => setQuickText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addQuick(col.key, quickText);
                          if (e.key === "Escape") {
                            setQuickColumn(null);
                            setQuickText("");
                          }
                        }}
                        placeholder="What needs doing?"
                        aria-label={`New task in ${col.title}`}
                        className="h-[30px] w-full rounded-md border border-navy bg-white px-2 text-[12px]"
                      />
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="naboo"
                          size="naboo"
                          disabled={!quickText.trim() || create.isPending}
                          onClick={() => addQuick(col.key, quickText)}
                        >
                          Add
                        </Button>
                        <Button
                          variant="naboo-ghost"
                          size="naboo"
                          onClick={() => {
                            setQuickColumn(null);
                            setQuickText("");
                          }}
                        >
                          Cancel
                        </Button>
                        <button
                          type="button"
                          onClick={() => {
                            setAdding(true);
                            setQuickColumn(null);
                          }}
                          className="ml-auto text-[11px] text-slate-500 [&:hover]:text-navy"
                        >
                          More options…
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setQuickColumn(col.key);
                        setQuickText("");
                      }}
                      className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-[5px] text-[11.5px] text-slate-500 transition-colors [&:hover]:bg-slate-100 [&:hover]:text-navy"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      Add task
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <TaskList tasks={listOrder(shown, day)} day={day} onOpen={setOpenKey} />
      )}

      {adding && (
        <TaskDialog
          people={people}
          pending={create.isPending}
          column={quickColumn ?? "todo"}
          initialTitle={quickText}
          onCancel={() => setAdding(false)}
          onSave={(input) => create.mutate(input)}
        />
      )}
      {open && (
        <TaskDrawer
          key={open.key}
          task={open}
          day={day}
          people={people}
          me={me.data?.email ?? null}
          pending={move.isPending || update.isPending || remove.isPending}
          onClose={() => setOpenKey(null)}
          onPatch={(change) => patch(open, change)}
          onSaveManual={(input) => update.mutate({ ...input, key: open.key })}
          onDelete={() => remove.mutate(open.key)}
        />
      )}
    </div>
  );
}

// ── Small pieces ────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  className = "",
}: {
  label: string;
  value: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-baseline gap-1.5 whitespace-nowrap text-[13px] ${className}`}
    >
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold tabular-nums text-navy">{value}</span>
    </span>
  );
}

function ViewButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex h-[26px] items-center gap-1.5 rounded-md px-2.5 text-[11.5px] transition-colors ${
        active
          ? "bg-white font-semibold text-navy shadow-[0_1px_2px_rgba(16,31,52,0.10)]"
          : "text-slate-500 [&:hover]:text-navy"
      }`}
    >
      {children}
    </button>
  );
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-input bg-white pl-2.5 pr-1.5 text-[11.5px] text-navy">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remove the ${label} filter`}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-slate-400 transition-colors [&:hover]:bg-slate-100 [&:hover]:text-navy"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  );
}

function Pill({
  tone,
  children,
  className = "",
  title,
}: {
  tone: PillTone;
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-medium leading-[1.4] ${PILL_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

function Avatar({ email, title }: { email: string | null; title?: string }) {
  if (!email) {
    return (
      <span
        title="Nobody has this yet"
        className="inline-flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full border border-dashed border-input bg-white text-[9px] font-semibold text-slate-400"
      >
        ?
      </span>
    );
  }
  return (
    <span
      title={title ?? email}
      className="inline-flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-navy text-[9px] font-bold tracking-[0.02em] text-naboo"
    >
      {initials(email)}
    </span>
  );
}

// ── The card ────────────────────────────────────────────────────────────────

function TaskCard({
  task,
  day,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  task: Task;
  day: string;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const badge = trackerBadge(task);
  const due = dueInfo(task, day);
  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      // The drawer opens on click, not mousedown: a drag must not double as a click.
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      role="button"
      className={`flex cursor-grab flex-col gap-1.5 rounded-lg border border-border bg-white px-3 py-2.5 shadow-[0_1px_2px_rgba(16,31,52,0.06)] transition-[border-color,box-shadow] duration-150 [&:hover]:border-navy [&:hover]:shadow-[0_4px_6px_rgba(16,31,52,0.06),0_2px_4px_rgba(16,31,52,0.06)] ${
        dragging ? "opacity-50" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill tone={badge.tone}>{badge.label}</Pill>
        {task.priority === "urgent" && task.column !== "done" && (
          <Pill tone="red" className="font-semibold">
            <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
            Urgent
          </Pill>
        )}
        {!task.manual && (
          <Pill
            tone="lime"
            className="font-semibold"
            title="Comes from a tracker — it leaves the board on its own when the work is done."
          >
            <Zap className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
            Automatic
          </Pill>
        )}
        {task.staleDone && (
          <Pill
            tone="amber"
            className="font-semibold"
            title="Parked in Done, but the tracker still reports this as open. Whoever moved it may know something the data does not — it is shown rather than corrected."
          >
            Still open
          </Pill>
        )}
        {!task.open && !task.manual && (
          <Pill tone="green" title="The tracker no longer reports this, so the work is done.">
            Resolved
          </Pill>
        )}
      </div>

      <div className="flex items-start gap-1.5">
        <GripVertical className="mt-[3px] h-3 w-3 flex-none text-slate-300" aria-hidden="true" />
        <div className="text-[13px] font-medium leading-[1.35] text-pretty text-navy">
          {task.title}
        </div>
      </div>

      {/* Always present, even on a typed card: the line says what kind of job this is, and
          a card with nothing under its title reads as a card missing something. */}
      <div className="pl-[18px] text-[11.5px] leading-[1.45] text-pretty text-slate-500">
        {[sourceLabel(task), task.subject].filter(Boolean).join(" · ")}
        {task.amount && (
          <span className="ml-1.5 font-medium tabular-nums text-slate-600">{task.amount}</span>
        )}
      </div>

      <div className="flex items-center gap-2 pl-[18px] pt-0.5">
        {refLabel(task) && (
          <span className="font-mono text-[10.5px] text-slate-400">{refLabel(task)}</span>
        )}
        <Pill tone={due.tone} className="ml-auto">
          {due.label}
        </Pill>
        <Avatar email={task.assignee} />
      </div>
    </article>
  );
}

// ── The list ────────────────────────────────────────────────────────────────

const STATUS_TONES: Record<TaskColumn, PillTone> = {
  todo: "neutral",
  doing: "orange",
  blocked: "teal",
  done: "green",
};

function TaskList({
  tasks,
  day,
  onOpen,
}: {
  tasks: Task[];
  day: string;
  onOpen: (key: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-[12px]">
        <thead>
          <tr>
            {["Status", "Task", "Tracker", "Ref", "Source", "Due", "Owner"].map((h) => (
              <th
                key={h}
                className="sticky top-0 z-[2] whitespace-nowrap border-b border-border bg-slate-50 px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.04em] text-slate-500"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const badge = trackerBadge(task);
            const due = dueInfo(task, day);
            return (
              <tr
                key={task.key}
                onClick={() => onOpen(task.key)}
                className="cursor-pointer transition-colors [&:hover]:bg-slate-50"
              >
                <td className="whitespace-nowrap border-b border-border px-3 py-2">
                  <Pill tone={STATUS_TONES[task.column]}>{columnMeta(task.column).title}</Pill>
                </td>
                <td className="border-b border-border px-3 py-2">
                  <span className="font-medium text-navy">{task.title}</span>
                  {/* Only when there is something to add — the Source column already
                      says what kind of card this is, so "—" here is just noise. */}
                  {([task.subject, task.amount].filter(Boolean).join(" · ") || task.detail) && (
                    <span className="block text-[10.5px] leading-[1.4] text-slate-400">
                      {[task.subject, task.amount].filter(Boolean).join(" · ") || task.detail}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap border-b border-border px-3 py-2">
                  <Pill tone={badge.tone}>{badge.label}</Pill>
                </td>
                <td className="whitespace-nowrap border-b border-border px-3 py-2 font-mono text-[11px] text-slate-500">
                  {refLabel(task) ?? "—"}
                </td>
                <td className="whitespace-nowrap border-b border-border px-3 py-2 text-slate-500">
                  {sourceLabel(task)}
                </td>
                <td className="whitespace-nowrap border-b border-border px-3 py-2">
                  <Pill tone={due.tone}>{due.label}</Pill>
                </td>
                <td className="whitespace-nowrap border-b border-border px-3 py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <Avatar email={task.assignee} />
                    <span className="text-slate-600">
                      {task.assignee ? shortName(task.assignee) : "Unassigned"}
                    </span>
                  </span>
                </td>
              </tr>
            );
          })}
          {tasks.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-[12px] text-slate-400">
                Nothing matches those filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── The drawer ──────────────────────────────────────────────────────────────

const FIELD = "h-8 w-full rounded-md border border-input bg-white px-2 text-[12px] text-navy";
const FIELD_LABEL = "text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500";

/**
 * One card, opened.
 *
 * A derived card is half read-only and says which half: the title, the figure and the
 * booking belong to the tracker, and the four fields below them belong to the board. A
 * manual card is editable throughout, because nobody else is the authority on it.
 */
function TaskDrawer({
  task,
  day,
  people,
  me,
  pending,
  onClose,
  onPatch,
  onSaveManual,
  onDelete,
}: {
  task: Task;
  day: string;
  people: string[];
  me: string | null;
  pending: boolean;
  onClose: () => void;
  onPatch: (change: Partial<Task>) => void;
  onSaveManual: (input: ManualTaskInput) => void;
  onDelete: () => void;
}) {
  const [note, setNote] = useState(task.note ?? "");
  const [title, setTitle] = useState(task.title);
  const badge = trackerBadge(task);
  const due = dueInfo(task, day);
  const everyone = me && !people.includes(me) ? [me, ...people] : people;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[rgba(16,31,52,0.40)]" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-[440px] flex-col border-l border-border bg-white shadow-[0_20px_25px_rgba(16,31,52,0.15)] motion-safe:animate-in motion-safe:slide-in-from-right-4 motion-safe:duration-200"
        role="dialog"
        aria-label={task.title}
      >
        <div className="flex flex-none items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Pill tone={badge.tone}>{badge.label}</Pill>
              {task.priority === "urgent" && (
                <Pill tone="red" className="font-semibold">
                  Urgent
                </Pill>
              )}
              {!task.manual && (
                <Pill tone="lime" className="font-semibold">
                  Automatic
                </Pill>
              )}
            </div>
            {task.manual ? (
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Task"
                className="mt-2 w-full rounded-md border border-input bg-white px-2 py-1 font-display text-[17px] font-bold tracking-[-0.02em] text-navy"
              />
            ) : (
              <h2 className="m-0 mt-2 font-display text-[19px] font-bold leading-[1.2] tracking-[-0.02em] text-navy">
                {task.title}
              </h2>
            )}
            <p className="m-0 mt-1 text-[12.5px] text-slate-500">
              {task.detail ?? [sourceLabel(task), task.subject].filter(Boolean).join(" · ")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex-none text-slate-400 [&:hover]:text-navy"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <div className="flex-none rounded-[10px] border border-border">
            <div className="border-b border-border bg-slate-50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500">
              What it is about
            </div>
            {/* Only the rows this card actually has. A grid of em dashes says nothing. */}
            <dl className="m-0 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 px-3 py-2.5 text-[12px]">
              {refLabel(task) && (
                <>
                  <dt className="m-0 text-slate-500">Reference</dt>
                  <dd className="m-0 font-mono text-[11.5px] text-navy">{refLabel(task)}</dd>
                </>
              )}
              {task.subject && (
                <>
                  <dt className="m-0 text-slate-500">Where</dt>
                  <dd className="m-0 text-navy">{task.subject}</dd>
                </>
              )}
              {task.amount && (
                <>
                  <dt className="m-0 text-slate-500">Amount</dt>
                  <dd className="m-0 tabular-nums text-navy">{task.amount}</dd>
                </>
              )}
              <dt className="m-0 text-slate-500">Kind</dt>
              <dd className="m-0 text-navy">{sourceLabel(task)}</dd>
              <dt className="m-0 text-slate-500">Due</dt>
              <dd className="m-0">
                <Pill tone={due.tone}>{due.label}</Pill>
              </dd>
            </dl>
          </div>

          <div className="grid flex-none grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL}>Column</span>
              <select
                value={task.column}
                disabled={pending}
                onChange={(e) => onPatch({ column: e.target.value as TaskColumn })}
                className={FIELD}
              >
                {COLUMN_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {columnMeta(c).title}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL}>Assignee</span>
              <select
                value={task.assignee ?? ""}
                disabled={pending}
                onChange={(e) => onPatch({ assignee: e.target.value || null })}
                className={FIELD}
              >
                <option value="">Nobody</option>
                {everyone.map((p) => (
                  <option key={p} value={p}>
                    {shortName(p)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL}>Due date</span>
              <input
                type="date"
                value={task.due ?? ""}
                disabled={pending}
                onChange={(e) => onPatch({ due: e.target.value || null })}
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL}>Priority</span>
              <select
                value={task.priority}
                disabled={pending}
                onChange={(e) => onPatch({ priority: e.target.value as Task["priority"] })}
                className={FIELD}
              >
                <option value="normal">Normal</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
          </div>

          {/* Where it comes from, and what will make it go away. The difference between
              the two kinds of card is the thing worth being explicit about. */}
          <div className="flex-none rounded-[10px] border border-border">
            <div className="border-b border-border bg-slate-50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500">
              Where it comes from
            </div>
            <div className="flex flex-col gap-2 px-3 py-2.5">
              <p className="m-0 text-[12px] text-navy">
                {task.manual
                  ? `Typed on this board${task.createdBy ? ` by ${shortName(task.createdBy)}` : ""}.`
                  : task.tracker
                    ? `Derived from ${trackerLabel(task.tracker)} — ${sourceLabel(task).toLowerCase()}${
                        task.ref ? ` on ${task.ref}` : ""
                      }.`
                    : "Read from your own Slack, and only ever yours."}
              </p>
              <p
                className={`m-0 rounded-md px-2.5 py-2 text-[11.5px] ${
                  task.manual ? "bg-slate-50 text-slate-600" : "bg-[#F6F9D8] text-[#4A520E]"
                }`}
              >
                {resolveHint(task)}
              </p>
              {task.href && (
                <a
                  href={task.href}
                  target={task.tracker ? undefined : "_blank"}
                  rel={task.tracker ? undefined : "noopener noreferrer"}
                  className="text-[12px] font-medium text-[#0F766E] no-underline [&:hover]:underline"
                >
                  {task.tracker ? `Open in ${trackerLabel(task.tracker)} →` : "Open in Slack →"}
                </a>
              )}
              {task.updatedAt && (
                <p className="m-0 text-[11px] text-slate-400">
                  Last touched here on {formatDay(task.updatedAt.slice(0, 10))}.
                </p>
              )}
            </div>
          </div>

          <label className="flex flex-none flex-col gap-1">
            <span className={FIELD_LABEL}>Note</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => note !== (task.note ?? "") && onPatch({ note: note || null })}
              rows={3}
              placeholder="What you found, what you are waiting for…"
              className="w-full rounded-md border border-input bg-white px-2 py-1.5 text-[12px] text-navy"
            />
          </label>
        </div>

        <div className="flex flex-none items-center gap-2 border-t border-border bg-slate-50 px-5 py-3">
          {task.manual ? (
            <Button
              variant="naboo"
              size="naboo"
              disabled={pending || !title.trim()}
              onClick={() =>
                onSaveManual({
                  title,
                  tracker: task.tracker,
                  ref: task.ref,
                  assignee: task.assignee,
                  due: task.due,
                  note: note || null,
                  column: task.column,
                  priority: task.priority,
                })
              }
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              Save
            </Button>
          ) : (
            <Button
              variant="naboo"
              size="naboo"
              disabled={pending || task.column === "done"}
              onClick={() => onPatch({ column: "done" })}
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              Mark done
            </Button>
          )}
          <Button variant="naboo-ghost" size="naboo" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="naboo-ghost"
            size="naboo"
            className="ml-auto text-[#B4534B]"
            disabled={pending}
            onClick={onDelete}
            title={
              task.manual
                ? "Deletes this task for everyone"
                : "Forgets the column, assignee and note — the tracker still reports the work"
            }
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {task.manual ? "Delete" : "Reset"}
          </Button>
        </div>
      </aside>
    </div>
  );
}

// ── The add dialog ──────────────────────────────────────────────────────────

function TaskDialog({
  people,
  pending,
  column,
  initialTitle,
  onCancel,
  onSave,
}: {
  people: string[];
  pending: boolean;
  column: TaskColumn;
  initialTitle?: string;
  onCancel: () => void;
  onSave: (input: ManualTaskInput) => void;
}) {
  const [state, setState] = useState<ManualTaskInput>({
    title: initialTitle ?? "",
    tracker: null,
    ref: null,
    assignee: null,
    due: null,
    note: null,
    column,
    priority: "normal",
  });
  const problem = validateManualTask(state);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(16,31,52,0.40)] px-4"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="New task"
        className="w-full max-w-[540px] rounded-xl bg-white shadow-[0_20px_25px_rgba(16,31,52,0.18)] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200"
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
          <h2 className="m-0 font-display text-[18px] font-bold tracking-[-0.02em] text-navy">
            New task
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="text-slate-400 [&:hover]:text-navy"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>Task</span>
            <input
              autoFocus
              value={state.title}
              onChange={(e) => setState((s) => ({ ...s, title: e.target.value }))}
              placeholder="Chase the Fairmont credit note"
              className={FIELD}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL}>Tracker</span>
              <select
                value={state.tracker ?? ""}
                onChange={(e) => setState((s) => ({ ...s, tracker: e.target.value || null }))}
                className={FIELD}
              >
                <option value="">None</option>
                {TRACKERS.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL}>Booking or provider</span>
              <input
                value={state.ref ?? ""}
                onChange={(e) => setState((s) => ({ ...s, ref: e.target.value || null }))}
                placeholder="C-P222"
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL}>Assignee</span>
              <select
                value={state.assignee ?? ""}
                onChange={(e) => setState((s) => ({ ...s, assignee: e.target.value || null }))}
                className={FIELD}
              >
                <option value="">Nobody</option>
                {people.map((p) => (
                  <option key={p} value={p}>
                    {shortName(p)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL}>Due date</span>
              <input
                type="date"
                value={state.due ?? ""}
                onChange={(e) => setState((s) => ({ ...s, due: e.target.value || null }))}
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL}>Column</span>
              <select
                value={state.column}
                onChange={(e) => setState((s) => ({ ...s, column: e.target.value }))}
                className={FIELD}
              >
                {COLUMN_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {columnMeta(c).title}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL}>Priority</span>
              <select
                value={state.priority}
                onChange={(e) => setState((s) => ({ ...s, priority: e.target.value }))}
                className={FIELD}
              >
                <option value="normal">Normal</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>Note</span>
            <textarea
              value={state.note ?? ""}
              onChange={(e) => setState((s) => ({ ...s, note: e.target.value || null }))}
              rows={2}
              className="w-full rounded-md border border-input bg-white px-2 py-1.5 text-[12px] text-navy"
            />
          </label>

          {problem && state.title.trim() !== "" && (
            <p role="alert" className="m-0 text-[11.5px] text-[#B4534B]">
              {problem}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-slate-50 px-5 py-3">
          <span className="text-[11.5px] text-slate-500">
            A task you type stays until you close it — it is never auto-resolved.
          </span>
          <Button variant="naboo-ghost" size="naboo" className="ml-auto" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="naboo"
            size="naboo"
            disabled={pending || problem != null}
            onClick={() => onSave(state)}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Create task
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Export ──────────────────────────────────────────────────────────────────

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The board as it is shown: same filters, same order, one row per card. */
function exportTasks(tasks: Task[], day: string) {
  const lines = [
    [
      "Column",
      "Task",
      "Source",
      "Tracker",
      "Ref",
      "Where",
      "Amount",
      "Due",
      "Due says",
      "Priority",
      "Assignee",
      "Open",
      "Note",
    ].join(","),
    ...tasks.map((t) =>
      [
        columnMeta(t.column).title,
        t.title,
        sourceLabel(t),
        trackerBadge(t).label,
        t.ref,
        t.subject,
        t.amount,
        t.due,
        dueInfo(t, day).label,
        t.priority,
        t.assignee,
        t.open ? "open" : "resolved",
        t.note,
      ]
        .map(csvEscape)
        .join(","),
    ),
  ];
  const csv = "﻿" + lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Naboo_tasks_${day}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export type { TrackerKey };
