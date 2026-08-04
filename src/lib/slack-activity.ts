/**
 * Turning somebody's Slack Activity into action items — pure, so the judgement calls are
 * reviewable and tested without a token.
 *
 * The Activity tab is where mentions land, and a mention is usually somebody asking for
 * something. Usually, not always: bots mention people to announce things that need no
 * reply, and one of those arrives constantly here. So a mention becomes a card unless it
 * is on the ignore list.
 *
 * The list is deliberately conservative. Guessing at intent from keywords — a question
 * mark, "please", "can you" — reads well in a demo and drops real work in practice: half
 * the asks in this team are statements ("the Fairmont invoice is wrong"). So the rule is
 * the other way round: everything is a task, and only what is known to be noise is
 * dropped. Adding to IGNORED is how you make the board quieter, and each entry says who
 * sends it and why it is not work.
 */

/**
 * Notifications that mention someone without asking anything of them.
 *
 * Matched on the normalised text — case, whitespace, dash style and the @handle all vary
 * between Slack clients and locales, and an exclusion that only works in one of them is
 * worse than none, because it looks like it is working.
 */
export const IGNORED_ACTIVITY: Array<{ pattern: RegExp; why: string }> = [
  {
    // Finance Bot, on every card request. It is an acknowledgement: the queue moves on
    // its own, and the tag is only there in case somebody wants to jump it.
    //
    // Both ends are required, and the middle is not: whoever is tagged changes, and the
    // "tag @someone" clause arrives in half a dozen shapes depending on how the mention was
    // written. What never varies is a line that opens "payment in queue" and closes on
    // "if you need urgent validation" — and real work about a stuck queue says neither.
    pattern: /^payment in queue\b.*\bif you need urgent validation/,
    why: "Finance Bot acknowledging a queued card payment — no reply is expected",
  },
];

/**
 * One text, comparable across clients.
 *
 * Slack sends the same line as `<@U123>`, `@Shayma` or `Shayma` depending on where it is
 * read from, and em dashes arrive as `—`, `--` or `-`. Everything is flattened so a
 * pattern can be written once.
 */
export function normaliseActivity(text: string | null | undefined): string {
  return (
    (text ?? "")
      // `<@U123|shayma>` keeps the handle; `<@U123>` has none to keep, so the id stands in —
      // anything is better than a bare "@", which would swallow the following word.
      .replace(
        /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g,
        (_m, id: string, label?: string) => `@${label || id}`,
      )
      .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
      .replace(/<([^|>]+)>/g, "$1")
      .replace(/[–—]|--/g, "—")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  );
}

/** Why a mention was dropped, or null when it is a task. */
export function ignoredBecause(text: string | null | undefined): string | null {
  const normalised = normaliseActivity(text);
  if (!normalised) return "empty message";
  for (const rule of IGNORED_ACTIVITY) {
    if (rule.pattern.test(normalised)) return rule.why;
  }
  return null;
}

export function isActionItem(text: string | null | undefined): boolean {
  return ignoredBecause(text) === null;
}

/**
 * The card's title: the message, shortened without cutting a word in half.
 *
 * The person's own words rather than a summary. A paraphrase of somebody's Slack message
 * is a second version of what they said, and the reader cannot tell which one is accurate
 * without opening the thread anyway.
 */
export function activityTitle(text: string | null | undefined, max = 160): string {
  const flat = (text ?? "")
    // A mention with no handle attached is still a mention of somebody. "@someone" reads
    // better on a card than the raw user id, and the thread is one click away either way.
    .replace(/<@[UW][A-Z0-9]+(?:\|([^>]*))?>/g, (_m, label?: string) => `@${label || "someone"}`)
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^|>]+)>/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Does this message actually mention this person?
 *
 * Slack's search is full text, so a query for `@shayma` also matches "shayma is away" and
 * anything else the indexer thinks is close enough. Only a real mention is an action item,
 * and checking it here is also what keeps the read honest: a match that does not name the
 * person who connected the account is dropped rather than shown to them.
 *
 * `<@U123>` is the raw form; `@handle` is what a client renders and what a search export
 * sometimes returns. Both count, nothing else does.
 */
export function mentionsPerson(
  text: string | null | undefined,
  person: { id?: string | null; handle?: string | null },
): boolean {
  const raw = text ?? "";
  const id = (person.id ?? "").trim();
  if (id && new RegExp(`<@${id}(\\||>)`).test(raw)) return true;
  const handle = (person.handle ?? "").trim().replace(/^@/, "");
  if (!handle) return false;
  // Word-bounded, so @shay does not match a mention of @shayma.
  return new RegExp(`@${escapeRegExp(handle)}(?![\\w.-])`, "i").test(raw);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "mention in #finance-na" — where it came from, for the card's second line. */
export function activitySubject(channelName: string | null | undefined): string {
  const channel = (channelName ?? "").trim();
  return channel ? `Mentioned in #${channel.replace(/^#/, "")}` : "Mentioned in Slack";
}
