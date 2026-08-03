/**
 * Access control beyond the Google domain check (server-only).
 *
 * Signing in with a verified @naboo.app account only identifies someone; it does
 * not grant access. The first sign-in records a pending request that an admin
 * approves once, after which the person is let straight through.
 */

/** Always an admin, and approved on sight — otherwise nobody could approve anyone. */
export const OWNER_EMAIL = "shayma.ndiaye@naboo.app";

import { ALL_TRACKERS, isTrackerKey, type TrackerKey } from "./trackers";

export type AccessStatus = "pending" | "approved" | "blocked";
export type Role = "owner" | "admin" | "member";

export type Access = { status: AccessStatus; role: Role; trackers: TrackerKey[] };

export type AppUser = {
  email: string;
  trackers: TrackerKey[];
  name: string | null;
  picture: string | null;
  status: AccessStatus;
  role: Role;
  requested_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  last_seen_at: string | null;
};

/**
 * Approval is checked on every authenticated call, so it is cached briefly per
 * instance: revoking someone takes effect within this window rather than waiting
 * for their 7-day session cookie to expire.
 */
const CACHE_TTL_MS = 45_000;
const cache = new Map<string, Access & { at: number }>();

export function invalidateAccessCache(email?: string) {
  if (email) cache.delete(email.toLowerCase());
  else cache.clear();
}

/**
 * Records the sign-in and returns the caller's standing. Creates a pending row
 * the first time an address is seen.
 */
export async function registerAndGetAccess(user: {
  email: string;
  name: string | null;
  picture: string | null;
}): Promise<Access> {
  const email = user.email.toLowerCase();
  const isOwner = email === OWNER_EMAIL.toLowerCase();
  const { db } = await import("./db.server");
  const sql = await db();

  const rows = await sql<{ status: AccessStatus; role: Role; trackers: string[] }[]>`
    INSERT INTO app_users (email, name, picture, status, role, requested_at, last_seen_at)
    VALUES (
      ${email}, ${user.name}, ${user.picture},
      ${isOwner ? "approved" : "pending"}, ${isOwner ? "owner" : "member"},
      now(), now()
    )
    ON CONFLICT (email) DO UPDATE SET
      name = COALESCE(EXCLUDED.name, app_users.name),
      picture = COALESCE(EXCLUDED.picture, app_users.picture),
      last_seen_at = now(),
      -- The owner can never be locked out of their own instance.
      status = CASE WHEN ${isOwner} THEN 'approved' ELSE app_users.status END,
      role = CASE WHEN ${isOwner} THEN 'owner' ELSE app_users.role END
    RETURNING status, role, trackers
  `;
  const row = rows[0];
  const result: Access = isOwner
    ? { status: "approved", role: "owner", trackers: ALL_TRACKERS }
    : {
        status: row?.status ?? "pending",
        role: row?.role ?? "member",
        trackers: (row?.trackers ?? []).filter(isTrackerKey),
      };
  cache.set(email, { ...result, at: Date.now() });
  return result;
}

/**
 * Someone's standing.
 *
 * `fresh` skips the cache read. The waiting page's poll asks this question for the sole
 * purpose of noticing a decision that was just taken, quite possibly on another instance
 * whose cache this one cannot see — served from a 45-second-old copy it would report
 * "still pending" for up to that long after the admin clicked approve.
 */
export async function getAccess(email: string, opts: { fresh?: boolean } = {}): Promise<Access> {
  const key = email.toLowerCase();

  // The owner is approved by definition, with no database round trip. Deriving it
  // from a row would mean a missing or corrupted row can lock the owner out of
  // their own instance — which is exactly what happened when the registry was
  // introduced while a valid session was already in flight.
  if (key === OWNER_EMAIL.toLowerCase()) {
    return { status: "approved", role: "owner", trackers: ALL_TRACKERS };
  }

  const hit = opts.fresh ? undefined : cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { status: hit.status, role: hit.role, trackers: hit.trackers };
  }

  const { db } = await import("./db.server");
  const sql = await db();
  const rows = await sql<{ status: AccessStatus; role: Role; trackers: string[] }[]>`
    SELECT status, role, trackers FROM app_users WHERE email = ${key}
  `;

  let row = rows[0];
  if (!row) {
    // A valid session with no row means it was issued before the registry existed.
    // Record the request so it shows up for approval instead of failing silently.
    const inserted = await sql<{ status: AccessStatus; role: Role; trackers: string[] }[]>`
      INSERT INTO app_users (email, status, role, requested_at, last_seen_at)
      VALUES (${key}, 'pending', 'member', now(), now())
      ON CONFLICT (email) DO UPDATE SET last_seen_at = now()
      RETURNING status, role, trackers
    `;
    row = inserted[0];
  }
  const result: Access = {
    status: row?.status ?? "pending",
    role: row?.role ?? "member",
    trackers: (row?.trackers ?? []).filter(isTrackerKey),
  };
  cache.set(key, { ...result, at: Date.now() });
  return result;
}

export function isAdmin(role: Role): boolean {
  return role === "owner" || role === "admin";
}

export async function listUsers(): Promise<AppUser[]> {
  const { db, isoOrNull } = await import("./db.server");
  const sql = await db();
  const rows = await sql<Record<string, unknown>[]>`
    SELECT email, name, picture, status, role, trackers,
           requested_at, decided_at, decided_by, last_seen_at
    FROM app_users
    ORDER BY
      CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
      requested_at DESC
  `;
  return rows.map((r) => ({
    ...(r as unknown as AppUser),
    trackers: (Array.isArray(r.trackers) ? (r.trackers as string[]) : []).filter(isTrackerKey),
    requested_at: isoOrNull(r.requested_at),
    decided_at: isoOrNull(r.decided_at),
    last_seen_at: isoOrNull(r.last_seen_at),
  }));
}

export async function countPending(): Promise<number> {
  const { db } = await import("./db.server");
  const sql = await db();
  const rows = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM app_users WHERE status = 'pending'
  `;
  return Number(rows[0]?.n ?? 0);
}

export async function decideAccess(
  actor: { email: string; role: Role },
  target: string,
  action: "approve" | "block" | "make_admin" | "make_member" | "set_trackers",
  trackers?: string[],
): Promise<void> {
  if (!isAdmin(actor.role)) throw new Error("Only an admin can change access.");
  const email = target.toLowerCase();
  if (email === OWNER_EMAIL.toLowerCase()) {
    throw new Error("The owner's access cannot be changed.");
  }
  // Guard the bus factor in one direction only: admins may approve people, but
  // only the owner may hand out or take back admin rights.
  if ((action === "make_admin" || action === "make_member") && actor.role !== "owner") {
    throw new Error("Only the owner can change roles.");
  }

  const { db } = await import("./db.server");
  const sql = await db();
  if (action === "set_trackers") {
    const clean = (trackers ?? []).filter(isTrackerKey);
    await sql`
      UPDATE app_users
      SET trackers = ${clean}::text[], decided_at = now(), decided_by = ${actor.email}
      WHERE email = ${email}
    `;
    invalidateAccessCache(email);
    return;
  }
  if (action === "approve" || action === "block") {
    await sql`
      UPDATE app_users
      SET status = ${action === "approve" ? "approved" : "blocked"},
          decided_at = now(), decided_by = ${actor.email}
      WHERE email = ${email}
    `;
  } else {
    await sql`
      UPDATE app_users
      SET role = ${action === "make_admin" ? "admin" : "member"},
          decided_at = now(), decided_by = ${actor.email}
      WHERE email = ${email}
    `;
  }
  invalidateAccessCache(email);
}
