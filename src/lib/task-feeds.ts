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
 * disagree. The sentence is `nextMove`'s — the same prose the queue card shows.
 */
export function cardTasks(rows: CardRow[]): DerivedTask[] {
  return rows.filter(needsDecision).map((row) => ({
    tracker: "na-cards" as const,
    // Two shapes of open card question, and they are different jobs: nobody has asked
    // the provider, versus they answered and we have not.
    kind: row.verdict.status === "unknown" ? "card-ask" : "card-decide",
    ref: row.provider.owner_code,
    title: nextMove(row) ?? "Decide whether we pay this provider by card",
    subject: row.provider.provider_name,
    amount: providerAmount(row),
    // An unasked provider is waiting on us to write; one that accepts is waiting on our
    // own decision. Both are ours, which is why neither is "partner".
    owner: "us" as const,
  }));
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
 */
export function slackTasks(items: StoredSlackTask[]): DerivedTask[] {
  return items.map((item) => ({
    tracker: null,
    kind: item.kind === "saved" ? "slack-saved" : "slack-reminder",
    ref: item.slack_id,
    title: item.title,
    subject: item.kind === "saved" ? "Saved in Slack" : "Slack reminder",
    amount: null,
    owner: "us" as const,
    permalink: item.permalink,
    due: item.due,
    sourceLabel: "My Slack",
  }));
}

/** Re-exported so the feeds and their tests share one notion of "accepting". */
export { accepts };
