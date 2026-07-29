/**
 * Credit card approvals from Slack (server-only).
 *
 * #finance-paiement-by-card carries a structured Finance Bot feed. An approval
 * is the strongest possible evidence that a partner takes card: it means a Pliant
 * card was actually issued for them, not that someone read a hopeful email.
 *
 * Message shape:
 *   *Credit Card Request Approved* :white_check_mark:
 *   *Approved by:* Shayma Ndiaye
 *   *Amount:* $44,802.00
 *   *Client Request:* C-V308
 *   *Partner:* O-G2013
 *   *Pliant Card ID:* 0caf4f16-...
 *
 * Matching is on the O- owner code, so it is exact — no name fuzzing.
 */

export const CARD_CHANNEL_ID = "C09GQEKBEAX";

export type CardApproval = {
  /** Owner code, e.g. O-G2013 */
  ownerCode: string;
  /** Booking readable id, e.g. C-V308 */
  eventRef: string | null;
  amount: string | null;
  approvedBy: string | null;
  at: string;
};

type SlackMessage = { text?: string; ts?: string };

/**
 * Reads a `*Label:* value` line out of a Finance Bot message.
 * Line-based rather than regex-based: the bot's format is stable and this avoids
 * escaping asterisks, which is easy to get subtly wrong.
 */
function field(text: string, label: string): string | null {
  const prefix = `*${label.toLowerCase()}:*`;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return null;
}

/** Parses the approval messages out of a channel page. Ignores pending/refused. */
export function parseApprovals(messages: SlackMessage[]): CardApproval[] {
  const out: CardApproval[] = [];
  for (const m of messages) {
    const text = m.text ?? "";
    // Only approvals. "Amount Update Refused" and "Request Refused" must not match.
    if (!/Credit Card Request Approved/i.test(text)) continue;
    const ownerCode = field(text, "Partner");
    if (!ownerCode || !/^O-/i.test(ownerCode)) continue;
    out.push({
      ownerCode: ownerCode.toUpperCase(),
      eventRef: field(text, "Client Request"),
      amount: field(text, "Amount"),
      approvedBy: field(text, "Approved by"),
      at: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : "",
    });
  }
  return out;
}

/**
 * Reads the channel directly and returns every card approval seen. Paginates
 * back through history; the channel is high-volume so this is capped.
 */
async function fetchFromSlack(): Promise<CardApproval[]> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "SLACK_BOT_TOKEN is not set — required to read credit card approvals from #finance-paiement-by-card.",
    );
  }

  const approvals: CardApproval[] = [];
  let cursor: string | undefined;
  const MAX_PAGES = 10; // 10 × 200 messages ≈ a few weeks of this channel

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      channel: CARD_CHANNEL_ID,
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });
    const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Slack HTTP ${res.status}`);
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      messages?: SlackMessage[];
      response_metadata?: { next_cursor?: string };
    };
    if (!data.ok) throw new Error(`Slack: ${data.error ?? "unknown error"}`);

    approvals.push(...parseApprovals(data.messages ?? []));
    cursor = data.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  return approvals;
}

// Per-instance fast path — a warm Fluid Compute instance serving several
// requests in a row does not need to re-read Postgres every time.
const MEMORY_CACHE_TTL_MS = 5 * 60_000;
let memoryCache: { at: number; approvals: CardApproval[] } | null = null;

// How stale the shared Postgres cache may be before a request pays the cost of
// a live Slack call itself. Set generously above the 15-minute cron cadence so
// one missed tick does not immediately fall back to Slack for every request.
const SHARED_CACHE_MAX_AGE_MS = 20 * 60_000;

/** Called by the 15-minute cron: always hits Slack, then republishes the shared cache. */
export async function refreshSharedCardApprovalsCache(): Promise<CardApproval[]> {
  const approvals = await fetchFromSlack();
  const { db } = await import("./db.server");
  const sql = await db();
  await sql`
    INSERT INTO slack_card_approvals_cache (id, approvals, refreshed_at)
    VALUES (1, ${sql.json(approvals)}, now())
    ON CONFLICT (id) DO UPDATE SET approvals = EXCLUDED.approvals, refreshed_at = now()
  `;
  memoryCache = { at: Date.now(), approvals };
  return approvals;
}

/**
 * Card approvals for the tracker to read. Serverless instances share no
 * memory, so the source of truth is the Postgres cache the cron keeps warm —
 * this only calls Slack directly if that shared cache is missing or stale
 * (e.g. before the cron has ever run, or after it has been failing).
 */
export async function fetchCardApprovals(): Promise<CardApproval[]> {
  if (memoryCache && Date.now() - memoryCache.at < MEMORY_CACHE_TTL_MS) {
    return memoryCache.approvals;
  }

  const { db } = await import("./db.server");
  const sql = await db();
  const rows = await sql<{ approvals: CardApproval[]; refreshed_at: Date }[]>`
    SELECT approvals, refreshed_at FROM slack_card_approvals_cache WHERE id = 1
  `;
  const row = rows[0];
  if (row && Date.now() - new Date(row.refreshed_at).getTime() < SHARED_CACHE_MAX_AGE_MS) {
    memoryCache = { at: Date.now(), approvals: row.approvals };
    return row.approvals;
  }

  // Shared cache missing or stale — fetch live and repair it, so the next
  // request (and the next cron tick) find it warm again.
  return refreshSharedCardApprovalsCache();
}
