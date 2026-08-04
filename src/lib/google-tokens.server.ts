/**
 * Per-user Google credentials for Gmail access (server-only).
 *
 * Connecting Gmail is deliberately separate from signing in: the login flow only
 * ever asks for identity, so nobody is forced to hand over mailbox access to use
 * the tracker. Tokens are stored per user, encrypted, and can be revoked.
 */
import { decryptSecret, encryptSecret } from "./crypto.server";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  // Read-only access to Gmail *settings* — added so a draft or send can carry the
  // sender's own signature (`gmail.server.ts#getSignatureHtml`). A user connected
  // before this was added does not have it yet and must reconnect Gmail; until they
  // do, sends fail soft to no signature rather than breaking outright.
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// Access tokens last ~1h; cache them per instance so we don't refresh on every call.
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function storeRefreshToken(
  email: string,
  refreshToken: string,
  scopes: string,
): Promise<void> {
  const { db } = await import("./db.server");
  const sql = await db();
  await sql`
    INSERT INTO google_credentials (user_email, refresh_token, scopes, connected_at, updated_at)
    VALUES (${email}, ${encryptSecret(refreshToken)}, ${scopes}, now(), now())
    ON CONFLICT (user_email) DO UPDATE SET
      refresh_token = EXCLUDED.refresh_token,
      scopes = EXCLUDED.scopes,
      updated_at = now()
  `;
  accessTokenCache.delete(email);
}

export async function getConnection(
  email: string,
): Promise<{ scopes: string; connected_at: string } | null> {
  const { db, isoOrNull } = await import("./db.server");
  const sql = await db();
  const rows = await sql<{ scopes: string; connected_at: Date }[]>`
    SELECT scopes, connected_at FROM google_credentials WHERE user_email = ${email}
  `;
  const row = rows[0];
  return row ? { scopes: row.scopes, connected_at: isoOrNull(row.connected_at) ?? "" } : null;
}

export async function disconnect(email: string): Promise<void> {
  const { db } = await import("./db.server");
  const sql = await db();
  const rows = await sql<{ refresh_token: string }[]>`
    SELECT refresh_token FROM google_credentials WHERE user_email = ${email}
  `;
  // Best effort: tell Google to invalidate the grant as well as forgetting it here.
  if (rows[0]) {
    try {
      await fetch(REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: decryptSecret(rows[0].refresh_token) }),
      });
    } catch (error) {
      console.error("Google token revoke failed (continuing):", error);
    }
  }
  await sql`DELETE FROM google_credentials WHERE user_email = ${email}`;
  accessTokenCache.delete(email);
}

/** Thrown when the user has not connected Gmail (or the grant was revoked). */
export class GmailNotConnectedError extends Error {
  constructor(message = "Gmail is not connected for this account.") {
    super(message);
    this.name = "GmailNotConnectedError";
  }
}

export async function getAccessToken(email: string): Promise<string> {
  const cached = accessTokenCache.get(email);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const { db } = await import("./db.server");
  const sql = await db();
  const rows = await sql<{ refresh_token: string }[]>`
    SELECT refresh_token FROM google_credentials WHERE user_email = ${email}
  `;
  if (!rows[0]) throw new GmailNotConnectedError();

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: decryptSecret(rows[0].refresh_token),
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    // invalid_grant means the user revoked access or changed their password.
    if (body.includes("invalid_grant")) {
      await sql`DELETE FROM google_credentials WHERE user_email = ${email}`;
      accessTokenCache.delete(email);
      throw new GmailNotConnectedError(
        "Gmail access has expired — reconnect Gmail from the account menu.",
      );
    }
    throw new Error(`Google token refresh failed: ${body}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in?: number };
  const ttl = (data.expires_in ?? 3600) * 1000;
  accessTokenCache.set(email, {
    token: data.access_token,
    // Refresh a minute early to avoid using a token that expires mid-request.
    expiresAt: Date.now() + Math.max(ttl - 60_000, 30_000),
  });
  return data.access_token;
}
