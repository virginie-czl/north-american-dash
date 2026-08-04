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

/** One provider's approvals, collapsed — the shape the mirror stores. */
export type ProviderApprovals = {
  ownerCode: string;
  /** How many approved cards this provider has in the channel. */
  count: number;
  /** ISO of the earliest, and of the most recent. Null when none carried a date. */
  firstAt: string | null;
  lastAt: string | null;
  /** From the most recent approval: who approved it, and for which booking. */
  approvedBy: string | null;
  eventRef: string | null;
};

/**
 * Collapses the channel's approvals onto one row per provider.
 *
 * A hotel gets one approved card per booking, so 559 approvals cover 287 providers. The
 * mirror is keyed on the owner code, and feeding it the raw list made Postgres refuse
 * the whole write: ON CONFLICT DO UPDATE cannot touch the same row twice in one
 * statement (21000). Reducing here is what makes the batch legal — and the count and
 * the dates are worth more than the single most recent row anyway.
 *
 * Approvals with no timestamp still count; they simply cannot win "most recent".
 */
export function aggregateApprovals(approvals: CardApproval[]): ProviderApprovals[] {
  const byOwner = new Map<string, ProviderApprovals>();
  for (const a of approvals) {
    const code = (a.ownerCode ?? "").trim().toUpperCase();
    if (!code) continue;
    const at = (a.at ?? "").trim() || null;
    const current = byOwner.get(code);
    if (!current) {
      byOwner.set(code, {
        ownerCode: code,
        count: 1,
        firstAt: at,
        lastAt: at,
        approvedBy: a.approvedBy ?? null,
        eventRef: a.eventRef ?? null,
      });
      continue;
    }
    current.count += 1;
    if (at && (current.firstAt == null || at < current.firstAt)) current.firstAt = at;
    if (at && (current.lastAt == null || at > current.lastAt)) {
      current.lastAt = at;
      // The approver and the booking travel with the most recent approval, so the row
      // reads as one coherent fact rather than fields from different messages.
      current.approvedBy = a.approvedBy ?? null;
      current.eventRef = a.eventRef ?? null;
    }
  }
  return [...byOwner.values()].sort((a, b) => a.ownerCode.localeCompare(b.ownerCode));
}

/**
 * Reads the channel live. The only path in the app that calls Slack.
 *
 * There was a second Postgres cache here (slack_card_approvals_cache, kept warm by a
 * 15-minute cron) from when page loads read approvals through Slack. They read the
 * slack_card_approvals mirror now, so that cache had no readers left — a table and a
 * cron that looked live and served nobody. Both are gone; the table itself can be
 * dropped by hand.
 */
export async function fetchCardApprovalsLive(): Promise<CardApproval[]> {
  return fetchFromSlack();
}
