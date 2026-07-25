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
import { GMAIL_SCOPES, disconnect, getConnection, storeRefreshToken } from "./google-tokens.server";
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


// --- Gmail connection (separate from sign-in) -------------------------------
// Signing in never asks for mailbox access; connecting Gmail is an explicit,
// revocable extra step, so the tracker is usable without it.

const GMAIL_STATE_COOKIE = "naboo_gmail_state";

async function handleGmailConnect(request: Request): Promise<Response> {
  const session = await getSessionFromRequest(request);
  if (!session) return redirect("/auth");
  const origin = requestOrigin(request);
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: requiredEnv("GOOGLE_CLIENT_ID"),
    redirect_uri: `${origin}/api/gmail/callback`,
    response_type: "code",
    scope: ["openid", "email", ...GMAIL_SCOPES].join(" "),
    // offline + consent are what actually yield a refresh token.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    login_hint: session.email,
    hd: ALLOWED_DOMAIN,
    state,
  });
  return redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, [
    serializeCookie(GMAIL_STATE_COOKIE, state, {
      maxAge: 600,
      secure: isSecureOrigin(origin),
    }),
  ]);
}

async function handleGmailCallback(request: Request): Promise<Response> {
  const session = await getSessionFromRequest(request);
  if (!session) return redirect("/auth");
  const origin = requestOrigin(request);
  const secure = isSecureOrigin(origin);
  const clearState = serializeCookie(GMAIL_STATE_COOKIE, "", { maxAge: 0, secure });
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request.headers.get("cookie"));

  if (!code || !state || cookies[GMAIL_STATE_COOKIE] !== state) {
    return redirect("/?gmail=error", [clearState]);
  }

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: requiredEnv("GOOGLE_CLIENT_ID"),
      client_secret: requiredEnv("GOOGLE_CLIENT_SECRET"),
      redirect_uri: `${origin}/api/gmail/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) {
    console.error("Gmail token exchange failed:", await tokenResponse.text());
    return redirect("/?gmail=error", [clearState]);
  }
  const tokens = (await tokenResponse.json()) as {
    refresh_token?: string;
    id_token?: string;
    scope?: string;
  };

  // The grant must belong to the signed-in account, not another mailbox.
  if (tokens.id_token) {
    try {
      const { payload } = await jwtVerify(tokens.id_token, GOOGLE_JWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: requiredEnv("GOOGLE_CLIENT_ID"),
      });
      const grantedEmail = String((payload as { email?: string }).email ?? "").toLowerCase();
      if (grantedEmail !== session.email.toLowerCase()) {
        return redirect("/?gmail=mismatch", [clearState]);
      }
    } catch (error) {
      console.error("Gmail id_token verification failed:", error);
      return redirect("/?gmail=error", [clearState]);
    }
  }

  if (!tokens.refresh_token) {
    // Google omits it if a grant already exists; prompt=consent should prevent this.
    return redirect("/?gmail=norefresh", [clearState]);
  }

  await storeRefreshToken(session.email, tokens.refresh_token, tokens.scope ?? "");
  return redirect("/?gmail=connected", [clearState]);
}

async function handleGmailStatus(request: Request): Promise<Response> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthenticated" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const connection = await getConnection(session.email);
  return new Response(JSON.stringify({ connected: connection != null, ...connection }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function handleGmailDisconnect(request: Request): Promise<Response> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return new Response(null, { status: 401 });
  }
  await disconnect(session.email);
  return new Response(null, { status: 204 });
}

/** Returns a Response for /api/auth/* or /api/gmail/* requests, or null to fall through to the app. */
export async function handleAuthRequest(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/auth/") && !pathname.startsWith("/api/gmail/")) return null;

  try {
    if (pathname === "/api/gmail/connect" && request.method === "GET") {
      return await handleGmailConnect(request);
    }
    if (pathname === "/api/gmail/callback" && request.method === "GET") {
      return await handleGmailCallback(request);
    }
    if (pathname === "/api/gmail/status" && request.method === "GET") {
      return await handleGmailStatus(request);
    }
    if (pathname === "/api/gmail/disconnect" && request.method === "POST") {
      return await handleGmailDisconnect(request);
    }
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
