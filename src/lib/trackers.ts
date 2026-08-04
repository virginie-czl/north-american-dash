/** Every tracker, shared by the router, the nav and the access checks. */
export const TRACKERS = [
  { key: "loreal", label: "L'Oréal CA", path: "/" },
  { key: "veolia", label: "Veolia US", path: "/veolia" },
  { key: "na", label: "Marketplace NA", path: "/tracking-north-america" },
  { key: "na-commissions", label: "Commissions NA", path: "/na-commissions" },
  { key: "na-cards", label: "Card tracking NA", path: "/card-tracking-na" },
] as const;

export type TrackerKey = (typeof TRACKERS)[number]["key"];

export const ALL_TRACKERS: TrackerKey[] = TRACKERS.map((t) => t.key);

export function isTrackerKey(value: unknown): value is TrackerKey {
  return typeof value === "string" && (ALL_TRACKERS as string[]).includes(value);
}

export function trackerLabel(key: TrackerKey): string {
  return TRACKERS.find((t) => t.key === key)?.label ?? key;
}

export function trackerPath(key: TrackerKey): string {
  return TRACKERS.find((t) => t.key === key)?.path ?? "/";
}

// ── What access can be given to ─────────────────────────────────────────────

/**
 * Every page an admin can hand out or take back, which is the trackers plus the task
 * board.
 *
 * Kept as a separate list rather than a sixth tracker on purpose. A tracker is a body of
 * financial data with a query behind it; the board is a view over the other five and has
 * no data of its own. Folding it into TRACKERS would put "Tasks" in the tracker picker on
 * a typed task, in the board's own tracker chips and in every count that means "which
 * ledger is this about" — none of which it is an answer to. What it does share with a
 * tracker is exactly one thing: someone either may open it or may not.
 */
export const ACCESS_AREAS = [
  ...TRACKERS,
  { key: "tasks", label: "Tasks", path: "/tasks" },
] as const;

export type AccessKey = (typeof ACCESS_AREAS)[number]["key"];

export const ALL_ACCESS: AccessKey[] = ACCESS_AREAS.map((a) => a.key);

export function isAccessKey(value: unknown): value is AccessKey {
  return typeof value === "string" && (ALL_ACCESS as string[]).includes(value);
}

export function areaLabel(key: AccessKey): string {
  return ACCESS_AREAS.find((a) => a.key === key)?.label ?? key;
}

export function areaPath(key: AccessKey): string {
  return ACCESS_AREAS.find((a) => a.key === key)?.path ?? "/";
}
