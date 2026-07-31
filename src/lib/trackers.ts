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
