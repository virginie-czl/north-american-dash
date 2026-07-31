/**
 * Stateless session management (server-only).
 * Sessions are signed JWTs stored in an httpOnly cookie — no external session store.
 */
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "naboo_session";
export const STATE_COOKIE = "naboo_oauth_state";
const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60; // 7 days

export interface SessionUser {
  /** Google account `sub` — stable unique id */
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET environment variable is not set");
  return new TextEncoder().encode(secret);
}

export async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name, picture: user.picture })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_S}s`)
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    if (!payload.sub || typeof payload.email !== "string") return null;
    return {
      id: payload.sub,
      email: payload.email,
      name: typeof payload.name === "string" ? payload.name : null,
      picture: typeof payload.picture === "string" ? payload.picture : null,
    };
  } catch {
    return null;
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; secure?: boolean } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.secure !== false) parts.push("Secure");
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}

export async function getSessionFromRequest(request: Request): Promise<SessionUser | null> {
  const cookies = parseCookies(request.headers.get("cookie"));
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  return verifySessionToken(token);
}

/**
 * Thrown by server functions. A thrown `Response` gets serialised into the
 * function's return value, so the client ends up with `{ error: ... }` where it
 * expected data — an Error propagates as an error, which is what callers handle.
 */
export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

/**
 * For use inside TanStack server functions: reads the current request's session
 * cookie and throws when the caller is not an approved user.
 */
export async function requireSession(): Promise<SessionUser> {
  const { getRequest } = await import("@tanstack/react-start/server");
  const request = getRequest();
  const session = request ? await getSessionFromRequest(request) : null;
  if (!session) {
    throw new AuthError("Session expirée — reconnectez-vous.", 401);
  }
  // A valid cookie is not enough: access can have been revoked since it was
  // issued, and cookies live for a week.
  const { getAccess } = await import("./access.server");
  const { status } = await getAccess(session.email);
  if (status !== "approved") {
    throw new AuthError(
      status === "blocked"
        ? "Votre accès à cet outil a été révoqué."
        : "Votre accès attend la validation d'un administrateur.",
      403,
    );
  }
  return session;
}

/**
 * Requires an approved session that is allowed to open a given tracker. Every
 * tracker's data query goes through this: hiding a tab in the nav is presentation,
 * not access control — the endpoint has to refuse.
 */
export async function requireTracker(tracker: string): Promise<SessionUser> {
  const session = await requireSession();
  const { getAccess } = await import("./access.server");
  const { trackers } = await getAccess(session.email);
  if (!trackers.includes(tracker as never)) {
    throw new AuthError("Vous n'avez pas accès à ce tracker.", 403);
  }
  return session;
}

/** Same, but also requires admin rights. */
export async function requireAdmin(): Promise<{ session: SessionUser; role: string }> {
  const session = await requireSession();
  const { getAccess, isAdmin } = await import("./access.server");
  const { role } = await getAccess(session.email);
  if (!isAdmin(role)) {
    throw new AuthError("Réservé aux administrateurs.", 403);
  }
  return { session, role };
}
