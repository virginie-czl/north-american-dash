/**
 * Gmail API access on behalf of the connected user (server-only).
 *
 * Reads are always narrowed by a search query built from partner addresses — the
 * app never enumerates a mailbox. Writes are one message at a time.
 */
import { getAccessToken } from "./google-tokens.server";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export type ThreadContact = {
  /** Partner address this thread was matched on. */
  address: string;
  threadId: string;
  subject: string;
  /** Last message in the thread, whichever direction. */
  lastAt: string;
  /** Last message we sent to them, if any. */
  lastOutboundAt: string | null;
  /** Last message they sent us, if any. */
  lastInboundAt: string | null;
  link: string;
};

async function gmail<T>(
  email: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const token = await getAccessToken(email);
  const response = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    const raw = await response.text();
    let message = raw;
    try {
      message = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? raw;
    } catch {
      /* keep raw */
    }
    throw new Error(`Gmail: ${message}`);
  }
  return (await response.json()) as T;
}

function header(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * Finds the most recent thread exchanged with each of the given addresses.
 * One search per address, capped, so the query stays bounded and auditable.
 */
export async function findContactThreads(
  email: string,
  addresses: string[],
): Promise<ThreadContact[]> {
  const unique = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const results: ThreadContact[] = [];

  for (const address of unique.slice(0, 12)) {
    const q = encodeURIComponent(`(from:${address} OR to:${address}) newer_than:1y`);
    const list = await gmail<{ messages?: Array<{ id: string; threadId: string }> }>(
      email,
      `/messages?q=${q}&maxResults=10`,
    );
    const messages = list.messages ?? [];
    if (messages.length === 0) continue;

    let subject = "";
    let threadId = messages[0].threadId;
    let lastAt: string | null = null;
    let lastOutboundAt: string | null = null;
    let lastInboundAt: string | null = null;

    for (const m of messages) {
      const detail = await gmail<{
        id: string;
        threadId: string;
        internalDate?: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
      }>(email, `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`);
      const headers = detail.payload?.headers ?? [];
      const at = detail.internalDate
        ? new Date(Number(detail.internalDate)).toISOString()
        : null;
      if (!at) continue;
      const from = header(headers, "From").toLowerCase();
      const outbound = from.includes(email.toLowerCase());
      if (!lastAt || at > lastAt) {
        lastAt = at;
        subject = header(headers, "Subject") || "(no subject)";
        threadId = detail.threadId;
      }
      if (outbound && (!lastOutboundAt || at > lastOutboundAt)) lastOutboundAt = at;
      if (!outbound && (!lastInboundAt || at > lastInboundAt)) lastInboundAt = at;
    }

    if (lastAt) {
      results.push({
        address,
        threadId,
        subject,
        lastAt,
        lastOutboundAt,
        lastInboundAt,
        link: `https://mail.google.com/mail/u/0/#all/${threadId}`,
      });
    }
  }
  return results;
}

function buildMime(to: string, subject: string, body: string): string {
  // Subject is RFC 2047 encoded so accents survive.
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const mime = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64"),
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

export async function createDraft(
  email: string,
  to: string,
  subject: string,
  body: string,
): Promise<{ draftId: string; link: string }> {
  const draft = await gmail<{ id: string; message?: { id: string } }>(email, "/drafts", {
    method: "POST",
    body: { message: { raw: buildMime(to, subject, body) } },
  });
  return {
    draftId: draft.id,
    link: `https://mail.google.com/mail/u/0/#drafts?compose=${draft.message?.id ?? draft.id}`,
  };
}

export async function sendMessage(
  email: string,
  to: string,
  subject: string,
  body: string,
): Promise<{ messageId: string; threadId: string }> {
  const sent = await gmail<{ id: string; threadId: string }>(email, "/messages/send", {
    method: "POST",
    body: { raw: buildMime(to, subject, body) },
  });
  return { messageId: sent.id, threadId: sent.threadId };
}
