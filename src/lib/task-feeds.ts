/**
 * What each tracker contributes to the task board — pure, so the mapping is testable
 * without a database.
 *
 * The board never invents work and never re-decides it. Each feed reads the tracker's
 * own already-shared rule for "this is open" and restates it as a card: Card tracking's
 * `needsDecision`, Commissions NA's rate mismatch, and so on. That is the whole
 * contract — if a tracker changes its mind about what is open, the board changes with
 * it, because there is only one rule and it lives with the tracker.
 *
 * Wording comes from the tracker too. A job described one way on its own page and
 * another way on the board is two jobs as far as the reader is concerned.
 */
import { accepts, fmtAmount, needsDecision, nextMove, type CardRow } from "./card-tracking.ts";
import type { CommissionRow } from "./commission.functions";
import { isActionItem } from "./slack-activity.ts";
import type { DerivedTask } from "./tasks";
import type { StoredSlackTask } from "./slack-user.server";

/** The largest single-currency figure on a provider, formatted. Never a total. */
function providerAmount(row: CardRow): string | null {
  const first = row.provider.amounts[0];
  return first ? fmtAmount(first.amount, first.currency) : null;
}

/**
 * Card tracking NA: one card per provider still needing a human.
 *
 * Straight off `needsDecision`, so the board's count and the page's queue badge cannot
 * disagree.
 *
 * The title is a verb phrase naming the next move, because that is what a task is: a card
 * reading "Never asked — no Slack approval" describes a state and leaves the reader to work
 * out what to do about it. The tracker's own sentence is not thrown away — it travels as
 * `detail` and is what the drawer shows, so the board and the page still say the same thing
 * in the same words, one level down.
 */
export function cardTasks(rows: CardRow[]): DerivedTask[] {
  return rows.filter(needsDecision).map((row) => {
    const unasked = row.verdict.status === "unknown";
    const name = row.provider.provider_name;
    return {
      tracker: "na-cards" as const,
      // Two shapes of open card question, and they are different jobs: nobody has asked
      // the provider, versus they answered and we have not.
      kind: unasked ? "card-ask" : "card-decide",
      ref: row.provider.owner_code,
      title: unasked
        ? `Ask ${name} whether they take a card`
        : `Decide whether we pay ${name} by card`,
      subject: name,
      detail: nextMove(row),
      amount: providerAmount(row),
      // An unasked provider is waiting on us to write; one that accepts is waiting on our
      // own decision. Both are ours, which is why neither is "partner".
      owner: "us" as const,
    };
  });
}

/**
 * Commissions NA: one card per booking whose commission does not match its rate.
 *
 * The page's own alert counts exactly this, and a mismatch is the only thing on that
 * page that is a job rather than a figure to read.
 */
export function commissionTasks(rows: CommissionRow[]): DerivedTask[] {
  const tasks: DerivedTask[] = [];
  for (const row of rows) {
    const ref = (row.readable_id ?? "").trim();
    if (!ref) continue;
    const mismatched = (row.partners ?? []).filter((p) => p.mismatch);
    if (mismatched.length === 0) continue;
    const names = mismatched
      .map((p) => p.partner_name ?? p.venue_name)
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
    tasks.push({
      tracker: "na-commissions",
      kind: "rate-mismatch",
      ref,
      title:
        mismatched.length === 1
          ? "Check the commission rate — one line does not match"
          : `Check the commission rates — ${mismatched.length} lines do not match`,
      detail:
        mismatched.length === 1
          ? "The commission charged does not match the rate on the booking."
          : `${mismatched.length} partner lines charge something other than their rate.`,
      subject: [row.company_name, names].filter(Boolean).join(" · ") || null,
      amount:
        row.total_commission_ht != null
          ? fmtAmount(row.total_commission_ht, row.currency_client)
          : null,
      owner: "us",
    });
  }
  return tasks;
}

/**
 * Somebody's own Slack, as cards.
 *
 * Personal in a way no tracker feed is: these rows are only ever read for the session's
 * own account, and they carry no tracker, so nothing about them is visible to anyone else
 * on this shared board. The board does not interpret them — a reminder is a reminder, in
 * the words the person wrote — and completing it in Slack is what closes it here.
 *
 * Mentions are filtered again on the way out. The exclusion list already ran when they were
 * read, but a rule added afterwards has to apply to what is already stored, or quieting the
 * board would mean waiting for rows to age out.
 */
export function slackTasks(items: StoredSlackTask[]): DerivedTask[] {
  const tasks: DerivedTask[] = [];
  for (const item of items) {
    if (item.kind === "mention" && !isActionItem(item.title)) continue;
    tasks.push({
      tracker: null,
      kind: SLACK_KINDS[item.kind],
      ref: item.slack_id,
      title: item.title,
      // Only a mention has a "where". A reminder's kind is already said by the card's
      // source label, and repeating it as a subject printed it on the card twice.
      subject: item.kind === "mention" ? (item.subject ?? "Mentioned in Slack") : null,
      amount: null,
      owner: "us" as const,
      permalink: item.permalink,
      due: item.due,
      sourceLabel: "My Slack",
    });
  }
  return tasks;
}

const SLACK_KINDS: Record<StoredSlackTask["kind"], string> = {
  reminder: "slack-reminder",
  saved: "slack-saved",
  mention: "slack-mention",
};

/** Re-exported so the feeds and their tests share one notion of "accepting". */
export { accepts };
