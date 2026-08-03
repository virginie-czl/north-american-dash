/**
 * Tasks — one board across every tracker, plus whatever you add by hand.
 *
 * The cards come from two places and the difference is visible on purpose. A derived
 * card restates a tracker's own action item: its words and its figure belong to that
 * page, it cannot be edited here, and it disappears when the tracker says the work is
 * done. A card somebody typed is theirs entirely.
 *
 * What the board owns is the column, the assignee, the due date and the note — the part
 * no query can know. That state is remembered per card, so dragging a derived task into
 * Doing survives a data refresh, and a card parked in Done while the money is still
 * outstanding says so rather than being quietly believed or quietly reopened.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Hash, Plus, RefreshCw, Trash2, X } from "lucide-react";
import {
  COLUMN_ORDER,
  TASK_COLUMNS,
  columnCounts,
  columnTasks,
  isOverdue,
  initials,
  matchesFilter,
  shortName,
  trackerCounts,
  validateManualTask,
  type ManualTaskInput,
  type Task,
  type TaskColumn,
} from "@/lib/tasks";
import {
  createManualTask,
  deleteTask,
  fetchBoard,
  saveTaskState,
  updateManualTask,
} from "@/lib/tasks.functions";
import { TRACKERS, trackerLabel, type TrackerKey } from "@/lib/trackers";
import { fmtAge } from "@/lib/card-tracking";
import { useRegisterTrackerActions } from "@/components/tracker-chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/_authenticated/tasks")({
  ssr: false,
  // No tracker gate: the board is everybody's, and each feed is gated on the server by
  // the same check its own page uses — so a member with one tracker sees one feed.
  component: TasksPage,
});

const today = () => new Date().toISOString().slice(0, 10);

function TasksPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [trackerFilter, setTrackerFilter] = useState<string[]>([]);
  const [mineOnly, setMineOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<TaskColumn | null>(null);

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
      invalidate();
    },
  });
  const update = useMutation({
    mutationFn: (input: ManualTaskInput & { key: string }) => updateManualTask({ data: input }),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (key: string) => deleteTask({ data: { key } }),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
  });

  const tasks = board.data?.tasks ?? [];
  const filter = useMemo(
    () => ({
      trackers: trackerFilter,
      assignee: mineOnly ? (me.data?.email ?? null) : null,
      search,
    }),
    [trackerFilter, mineOnly, me.data?.email, search],
  );
  const shown = useMemo(() => tasks.filter((t) => matchesFilter(t, filter)), [tasks, filter]);
  const counts = useMemo(() => columnCounts(shown), [shown]);
  const byTracker = useMemo(() => trackerCounts(tasks), [tasks]);
  const day = today();
  const overdue = shown.filter((t) => isOverdue(t, day)).length;
  const feeds = board.data?.feeds ?? [];
  const slack = board.data?.slack;
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

  useRegisterTrackerActions(
    { onRefresh: () => board.refetch().then(() => undefined), isFetching: board.isFetching },
    [board.isFetching],
  );

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
    move.mutate({
      key,
      column,
      assignee: task.assignee,
      note: task.note,
      due: task.due,
      title: task.title,
      tracker: task.tracker,
      ref: task.ref,
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-50">
      <main className="flex min-h-0 min-w-[1200px] flex-1 flex-col gap-5 overflow-hidden px-6 pb-7 pt-5 leading-[normal]">
        {/* Page head */}
        <div className="flex flex-none items-end justify-between gap-6">
          <div className="flex flex-col gap-0.5">
            <h1 className="m-0 font-display text-[26px] font-extrabold leading-[normal] tracking-[-0.02em] text-navy">
              Tasks
            </h1>
            <p className="m-0 text-[13px] text-slate-500">
              {board.isLoading
                ? "Loading the board…"
                : `${shown.length} card${shown.length === 1 ? "" : "s"} · ${counts.todo} to do · ${
                    overdue > 0 ? `${overdue} overdue · ` : ""
                  }from ${feeds.length} tracker${feeds.length === 1 ? "" : "s"} and by hand`}
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <Input
              placeholder="Search a task, booking or provider…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-56 text-[12px]"
            />
            <Button variant="naboo" size="naboo" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add a task
            </Button>
          </div>
        </div>

        {/* Filters, and what the feeds are worth */}
        <div className="flex flex-none flex-wrap items-center gap-2">
          <FilterChip
            label="Everything"
            n={tasks.length}
            active={trackerFilter.length === 0}
            onClick={() => setTrackerFilter([])}
          />
          {byTracker.map((t) => (
            <FilterChip
              key={t.key}
              label={t.label}
              n={t.n}
              active={trackerFilter.includes(t.key)}
              onClick={() =>
                setTrackerFilter((prev) =>
                  prev.includes(t.key) ? prev.filter((k) => k !== t.key) : [...prev, t.key],
                )
              }
            />
          ))}
          <button
            type="button"
            onClick={() => setMineOnly((v) => !v)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] transition-colors ${
              mineOnly ? "bg-naboo font-semibold text-navy" : "text-slate-700 hover:bg-slate-100"
            }`}
          >
            Only mine
          </button>
          <span className="ml-auto flex items-center gap-3 text-[11.5px] text-slate-400">
            {feeds
              .filter((f) => f.error == null)
              .map((f) => (
                <span key={f.tracker} title={`${f.tasks} open on ${trackerLabel(f.tracker)}`}>
                  {trackerLabel(f.tracker)}{" "}
                  {f.cachedAgeSeconds == null ? "live" : fmtAge(f.cachedAgeSeconds)}
                </span>
              ))}
          </span>
        </div>

        {/* Slack: one person's own to-dos, and only ever their own. */}
        <div className="flex flex-none flex-wrap items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-4 py-2.5">
          <Hash className="h-3.5 w-3.5 flex-none text-slate-400" aria-hidden="true" />
          {slack?.connected ? (
            <>
              <span className="text-[12.5px] text-navy">
                {slack.needsReconnect
                  ? "Your Slack reminders and saved messages are on this board — mentions are not."
                  : "Your Slack reminders, saved messages and mentions are on this board."}
              </span>
              <span className="text-[11.5px] text-slate-400">
                {slack.syncedAt
                  ? `pulled ${slack.syncedAt.slice(0, 16).replace("T", " ")}`
                  : "not pulled yet"}{" "}
                · refreshes itself every 15 minutes
              </span>
              <Button
                variant="naboo-ghost"
                size="naboo"
                className="ml-auto"
                disabled={slackSync.isPending}
                onClick={() => slackSync.mutate()}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${slackSync.isPending ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                {slackSync.isPending ? "Pulling…" : "Pull now"}
              </Button>
              {/* An older grant predates mentions. Saying so beats a board that quietly
                  reads less than the line above it claims. */}
              {slack.needsReconnect && (
                <Button
                  variant="naboo"
                  size="naboo"
                  onClick={() => {
                    window.location.href = "/api/slack/connect";
                  }}
                  title="Your connection predates mentions — reconnect to include your Activity"
                >
                  Reconnect for mentions
                </Button>
              )}
              <Button
                variant="naboo-ghost"
                size="naboo"
                disabled={slackOff.isPending}
                onClick={() => slackOff.mutate()}
                title="Revokes the token at Slack and removes your Slack cards from this board"
              >
                Disconnect
              </Button>
            </>
          ) : (
            <>
              <span className="text-[12.5px] text-navy">
                Connect Slack to put your own reminders, saved messages and mentions on this board.
              </span>
              {/* Said plainly, because it is the part worth trusting: the grant asks for
                  three personal scopes, and mentions do mean reading messages — but only
                  the ones that name the person connecting. */}
              <span className="text-[11.5px] text-slate-400">
                Your own Activity only — messages that mention you, never anyone else&apos;s.
              </span>
              <Button
                variant="naboo"
                size="naboo"
                className="ml-auto"
                onClick={() => {
                  window.location.href = "/api/slack/connect";
                }}
              >
                Connect Slack
              </Button>
            </>
          )}
        </div>
        {(slack?.error != null || slackSync.isError || slackOff.isError) && (
          <div
            role="alert"
            className="flex-none rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-[12.5px] text-rose-800"
          >
            Slack: {slack?.error ?? String(((slackSync.error ?? slackOff.error) as Error)?.message)}
          </div>
        )}

        {/* A feed that failed is named. A board silently missing a tracker reads as a
            tracker with nothing to do. */}
        {brokenFeeds.length > 0 && (
          <div
            role="alert"
            className="flex-none rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-[12.5px] text-rose-800"
          >
            {brokenFeeds.map((f) => (
              <div key={f.tracker}>
                {trackerLabel(f.tracker)} could not be read, so its tasks are missing: {f.error}
              </div>
            ))}
          </div>
        )}
        {board.error != null && (
          <div
            role="alert"
            className="flex-none rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-[12.5px] text-rose-800"
          >
            The board could not be loaded: {String((board.error as Error).message)}
          </div>
        )}
        {(move.isError || create.isError || update.isError || remove.isError) && (
          <div
            role="alert"
            className="flex-none rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-[12.5px] text-rose-800"
          >
            {String(
              ((move.error ?? create.error ?? update.error ?? remove.error) as Error)?.message,
            )}
          </div>
        )}

        {/* The board */}
        <div className="grid min-h-0 flex-1 grid-cols-4 gap-3">
          {TASK_COLUMNS.map((col) => {
            const list = columnTasks(shown, col.key);
            return (
              <section
                key={col.key}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(col.key);
                }}
                onDragLeave={() => setDragOver((c) => (c === col.key ? null : c))}
                onDrop={(e) => drop(col.key, e.dataTransfer.getData("text/plain") || dragKey)}
                className={`flex min-h-0 flex-col rounded-xl border bg-white transition-colors duration-150 ${
                  dragOver === col.key ? "border-navy bg-slate-50" : "border-slate-200"
                }`}
              >
                <div className="flex flex-none items-center gap-2 border-b border-slate-200 px-4 py-2.5">
                  <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-navy">
                    {col.title}
                  </span>
                  <span className="inline-flex h-5 items-center rounded-full bg-slate-100 px-2 text-[11px] font-semibold tabular-nums text-slate-600">
                    {list.length}
                  </span>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
                  {board.isLoading ? (
                    <p className="m-0 text-[12px] text-slate-400">Loading…</p>
                  ) : list.length === 0 ? (
                    <p className="m-0 text-[12px] text-slate-400">{col.hint}</p>
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
                        onOpen={() => task.manual && setEditing(task)}
                        onAssign={(assignee) =>
                          move.mutate({
                            key: task.key,
                            column: task.column,
                            assignee,
                            note: task.note,
                            due: task.due,
                            title: task.title,
                            tracker: task.tracker,
                            ref: task.ref,
                          })
                        }
                        me={me.data?.email ?? null}
                        people={board.data?.people ?? []}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </main>

      {adding && (
        <TaskDialog
          title="Add a task"
          people={board.data?.people ?? []}
          pending={create.isPending}
          onCancel={() => setAdding(false)}
          onSave={(input) => create.mutate(input)}
        />
      )}
      {editing && (
        <TaskDialog
          title="Edit the task"
          people={board.data?.people ?? []}
          pending={update.isPending || remove.isPending}
          task={editing}
          onCancel={() => setEditing(null)}
          onDelete={() => remove.mutate(editing.key)}
          onSave={(input) => update.mutate({ ...input, key: editing.key })}
        />
      )}
    </div>
  );
}

function FilterChip({
  label,
  n,
  active,
  onClick,
}: {
  label: string;
  n: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] transition-colors ${
        active ? "bg-naboo font-semibold text-navy" : "text-slate-700 hover:bg-slate-100"
      }`}
    >
      {label}
      <span className={active ? "font-normal text-navy/60" : "text-slate-400"}>{n}</span>
    </button>
  );
}

function TaskCard({
  task,
  day,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
  onAssign,
  me,
  people,
}: {
  task: Task;
  day: string;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onAssign: (assignee: string | null) => void;
  me: string | null;
  people: string[];
}) {
  const late = isOverdue(task, day);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`rounded-[10px] border bg-white p-3 transition-[box-shadow,border-color] duration-150 [&:hover]:border-navy [&:hover]:shadow-[0_4px_6px_rgba(16,31,52,0.06)] ${
        dragging ? "opacity-50" : ""
      } ${task.manual ? "border-l-[3px] border-l-slate-300" : "border-l-[3px] border-l-naboo"} ${
        late ? "border-rose-200" : "border-slate-200"
      } ${task.open ? "" : "opacity-70"}`}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onOpen}
          disabled={!task.manual}
          className="min-w-0 flex-1 text-left disabled:cursor-default"
          title={task.manual ? "Edit this task" : "Comes from a tracker — edit it there"}
        >
          <span className="block text-[12.5px] font-medium leading-[1.35] text-navy">
            {task.title}
          </span>
          {task.subject && (
            <span className="mt-0.5 block truncate text-[11px] text-slate-500">{task.subject}</span>
          )}
        </button>
        {task.amount && (
          <span className="flex-none whitespace-nowrap text-[12px] font-semibold tabular-nums">
            {task.amount}
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {task.sourceLabel && !task.tracker ? (
          <a
            href={task.href ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-full bg-slate-100 px-2 py-[1px] text-[10px] font-medium text-slate-600 no-underline hover:bg-slate-200"
            title="Open it in Slack"
          >
            {task.sourceLabel}
          </a>
        ) : task.tracker ? (
          <a
            href={task.href ?? "#"}
            className="inline-flex items-center rounded-full bg-slate-100 px-2 py-[1px] text-[10px] font-medium text-slate-600 no-underline hover:bg-slate-200"
            title={`Open ${trackerLabel(task.tracker)}`}
          >
            {trackerLabel(task.tracker)}
          </a>
        ) : (
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-[1px] text-[10px] font-medium text-slate-600">
            By hand
          </span>
        )}
        {task.ref && <span className="font-mono text-[10px] text-slate-400">{task.ref}</span>}
        {task.due && (
          <span
            className={`text-[10px] ${late ? "font-semibold text-rose-700" : "text-slate-400"}`}
          >
            due {task.due.slice(5)}
          </span>
        )}
        {/* The one contradiction the board cannot resolve on its own. */}
        {task.staleDone && (
          <span
            title="Parked in Done, but the tracker still reports this as open. Whoever moved it may know something the data does not — it is shown rather than corrected."
            className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-[1px] text-[10px] font-medium text-amber-800"
          >
            <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
            still open
          </span>
        )}
        {!task.open && !task.manual && (
          <span
            title="The tracker no longer reports this, so the work is done."
            className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-[1px] text-[10px] font-medium text-emerald-700"
          >
            resolved
          </span>
        )}

        <span className="ml-auto flex items-center gap-1.5">
          {task.note && (
            <span className="truncate text-[10px] text-slate-400" title={task.note}>
              note
            </span>
          )}
          <select
            aria-label="Assignee"
            value={task.assignee ?? ""}
            onChange={(e) => onAssign(e.target.value || null)}
            className="h-6 max-w-[110px] rounded-md border border-slate-200 bg-white px-1 text-[10.5px] text-slate-600"
          >
            <option value="">Nobody</option>
            {me && !people.includes(me) && <option value={me}>{shortName(me)}</option>}
            {people.map((p) => (
              <option key={p} value={p}>
                {shortName(p)}
              </option>
            ))}
          </select>
          {task.assignee && (
            <span
              title={task.assignee}
              className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-navy text-[9px] font-semibold text-naboo"
            >
              {initials(task.assignee)}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function TaskDialog({
  title,
  task,
  people,
  pending,
  onCancel,
  onSave,
  onDelete,
}: {
  title: string;
  task?: Task;
  people: string[];
  pending: boolean;
  onCancel: () => void;
  onSave: (input: ManualTaskInput) => void;
  onDelete?: () => void;
}) {
  const [state, setState] = useState<ManualTaskInput>({
    title: task?.title ?? "",
    tracker: task?.tracker ?? null,
    ref: task?.ref ?? null,
    assignee: task?.assignee ?? null,
    due: task?.due ?? null,
    note: task?.note ?? null,
    column: task?.column ?? "todo",
  });
  const problem = validateManualTask(state);
  const field = "h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-[12px]";
  const label = "text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/30 px-4">
      <div className="w-full max-w-[520px] rounded-xl border border-slate-200 bg-white p-5 shadow-[0_4px_6px_rgba(16,31,52,0.06)]">
        <div className="flex items-center justify-between gap-4">
          <h2 className="m-0 font-display text-[17px] font-bold text-navy">{title}</h2>
          <button type="button" onClick={onCancel} aria-label="Close" className="text-slate-400">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className={label}>What needs doing</span>
            <input
              autoFocus
              value={state.title}
              onChange={(e) => setState((s) => ({ ...s, title: e.target.value }))}
              placeholder="Chase the Fairmont credit note"
              className={field}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className={label}>Tracker</span>
              <select
                value={state.tracker ?? ""}
                onChange={(e) => setState((s) => ({ ...s, tracker: e.target.value || null }))}
                className={field}
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
              <span className={label}>Booking or provider</span>
              <input
                value={state.ref ?? ""}
                onChange={(e) => setState((s) => ({ ...s, ref: e.target.value || null }))}
                placeholder="C-P222"
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={label}>Assignee</span>
              <select
                value={state.assignee ?? ""}
                onChange={(e) => setState((s) => ({ ...s, assignee: e.target.value || null }))}
                className={field}
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
              <span className={label}>Due</span>
              <input
                type="date"
                value={state.due ?? ""}
                onChange={(e) => setState((s) => ({ ...s, due: e.target.value || null }))}
                className={field}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className={label}>Note</span>
            <textarea
              value={state.note ?? ""}
              onChange={(e) => setState((s) => ({ ...s, note: e.target.value || null }))}
              rows={3}
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-[12px]"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className={label}>Column</span>
            <select
              value={state.column}
              onChange={(e) => setState((s) => ({ ...s, column: e.target.value }))}
              className={field}
            >
              {COLUMN_ORDER.map((c) => (
                <option key={c} value={c}>
                  {TASK_COLUMNS.find((x) => x.key === c)?.title}
                </option>
              ))}
            </select>
          </label>
        </div>

        {problem && (
          <p role="alert" className="mt-3 text-[11.5px] text-rose-700">
            {problem}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          <Button
            variant="naboo"
            size="naboo"
            disabled={pending || problem != null}
            onClick={() => onSave(state)}
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Save
          </Button>
          <Button variant="naboo-ghost" size="naboo" onClick={onCancel}>
            Cancel
          </Button>
          {onDelete && (
            <Button
              variant="naboo-ghost"
              size="naboo"
              className="ml-auto text-rose-700"
              disabled={pending}
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Delete
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export type { TrackerKey };
