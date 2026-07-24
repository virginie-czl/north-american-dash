/**
 * Direct Google OAuth 2.0 (server-only) — no Supabase, no external session store.
 *
 * Endpoints (intercepted in src/server.ts before the app handler):
 *   GET  /api/auth/google    → redirect to Google's consent screen
 *   GET  /api/auth/callback  → code exchange, id_token verification, session cookie
 *   POST /api/auth/logout    → clear the session cookie
 *   GET  /api/auth/me        → current session user as JSON, or 401
 *
 * Access is restricted to verified @naboo.app Google accounts. The domain is
 * checked server-side on the id_token email — the `hd` hint alone is never trusted.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  parseCookies,
  serializeCookie,
  signSession,
  getSessionFromRequest,
} from "./session.server";

const ALLOWED_DOMAIN = "naboo.app";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} environment variable is not set`);
  return v;
}

/** Derive the public origin of the deployment from the incoming request. */
function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto =
    request.headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

function isSecureOrigin(origin: string): boolean {
  return origin.startsWith("https://");
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

function handleStart(request: Request): Response {
  const origin = requestOrigin(request);
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: requiredEnv("GOOGLE_CLIENT_ID"),
    redirect_uri: `${origin}/api/auth/callback`,
    response_type: "code",
    scope: "openid email profile",
    hd: ALLOWED_DOMAIN,
    prompt: "select_account",
    state,
  });
  return redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, [
    serializeCookie(STATE_COOKIE, state, { maxAge: 600, secure: isSecureOrigin(origin) }),
  ]);
}

async function handleCallback(request: Request): Promise<Response> {
  const origin = requestOrigin(request);
  const secure = isSecureOrigin(origin);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request.headers.get("cookie"));
  const clearState = serializeCookie(STATE_COOKIE, "", { maxAge: 0, secure });

  if (!code || !state || !cookies[STATE_COOKIE] || cookies[STATE_COOKIE] !== state) {
    return redirect("/auth?error=oauth", [clearState]);
  }

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: requiredEnv("GOOGLE_CLIENT_ID"),
      client_secret: requiredEnv("GOOGLE_CLIENT_SECRET"),
      redirect_uri: `${origin}/api/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) {
    console.error("Google token exchange failed:", await tokenResponse.text());
    return redirect("/auth?error=oauth", [clearState]);
  }
  const tokens = (await tokenResponse.json()) as { id_token?: string };
  if (!tokens.id_token) return redirect("/auth?error=oauth", [clearState]);

  let claims: {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  try {
    const { payload } = await jwtVerify(tokens.id_token, GOOGLE_JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: requiredEnv("GOOGLE_CLIENT_ID"),
    });
    claims = payload as typeof claims;
  } catch (error) {
    console.error("Google id_token verification failed:", error);
    return redirect("/auth?error=oauth", [clearState]);
  }

  const email = (claims.email ?? "").toLowerCase();
  if (
    !claims.sub ||
    !email ||
    claims.email_verified !== true ||
    !email.endsWith(`@${ALLOWED_DOMAIN}`)
  ) {
    return redirect("/auth?error=domain", [clearState]);
  }

  const session = await signSession({
    id: claims.sub,
    email,
    name: claims.name ?? null,
    picture: claims.picture ?? null,
  });
  return redirect("/", [
    clearState,
    serializeCookie(SESSION_COOKIE, session, { maxAge: 7 * 24 * 60 * 60, secure }),
  ]);
}

async function handleMe(request: Request): Promise<Response> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthenticated" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(session), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function handleLogout(request: Request): Response {
  const secure = isSecureOrigin(requestOrigin(request));
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": serializeCookie(SESSION_COOKIE, "", { maxAge: 0, secure }) },
  });
}

/** Returns a Response for /api/auth/* requests, or null to fall through to the app. */
export async function handleAuthRequest(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/auth/")) return null;

  try {
    if (pathname === "/api/auth/google" && request.method === "GET") return handleStart(request);
    if (pathname === "/api/auth/callback" && request.method === "GET") {
      return await handleCallback(request);
    }
    if (pathname === "/api/auth/me" && request.method === "GET") return await handleMe(request);
    if (pathname === "/api/auth/logout" && request.method === "POST") {
      return handleLogout(request);
    }
  } catch (error) {
    console.error("Auth endpoint error:", error);
    return new Response(JSON.stringify({ error: "Auth configuration error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("Not found", { status: 404 });
}
