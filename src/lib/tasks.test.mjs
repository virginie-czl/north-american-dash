/**
 * The task board's rules.
 *
 * The one that matters most is the boundary between the two kinds of card: a tracker
 * says whether work is open, and the board says where the card sits. Neither may
 * overwrite the other, and every assertion about `open`, `staleDone` and the resolved
 * population below is really about that line holding.
 */
import { readFileSync } from "node:fs";
import {
  COLUMN_ORDER,
  NO_FILTER,
  boardStats,
  buildBoard,
  columnCounts,
  columnTasks,
  compareTasks,
  daysBetween,
  derivedKey,
  dueInfo,
  formatDay,
  initials,
  isManualKey,
  isFiltered,
  isOverdue,
  isTaskColumn,
  listOrder,
  matchesFilter,
  rankTask,
  refLabel,
  resolveHint,
  shortName,
  sourceLabel,
  sourceOptions,
  trackerBadge,
  trackerCounts,
  validateManualTask,
} from "./tasks.ts";
import { cardTasks, commissionTasks, slackTasks } from "./task-feeds.ts";
import {
  activitySubject,
  activityTitle,
  ignoredBecause,
  isActionItem,
  mentionsPerson,
  normaliseActivity,
} from "./slack-activity.ts";
import { buildRows, aggregateProviders, emptyTerms, NO_EVIDENCE } from "./card-tracking.ts";

let pass = 0,
  fail = 0;
const t = (name, cond, got = "") => {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, got);
  }
};

const derived = (o = {}) => ({
  tracker: "na-cards",
  kind: "card-ask",
  ref: "O-A001",
  title: "Never asked — no Slack approval, nothing in the email scan.",
  subject: "Hyatt Regency",
  amount: "1,000.00 USD",
  owner: "us",
  ...o,
});

const state = (o = {}) => ({
  key: derivedKey("na-cards", "O-A001", "card-ask"),
  manual: false,
  column: "todo",
  assignee: null,
  note: null,
  priority: "normal",
  due: null,
  title: null,
  tracker: "na-cards",
  ref: "O-A001",
  created_by: null,
  updated_by: null,
  updated_at: null,
  ...o,
});

console.log("\n[identity]");
t("a derived key names all three parts", derivedKey("na", "C-P222", "pay") === "na::c-p222::pay");
t(
  "and is case-insensitive",
  derivedKey("na", "c-p222", "PAY") === derivedKey("na", "C-P222", "pay"),
);
// A booking with a payment and a claim is two cards, and the board has to hold one in
// Doing while the other waits.
t(
  "two jobs on one booking are two keys",
  derivedKey("na", "C-P222", "pay") !== derivedKey("na", "C-P222", "recover"),
);
t(
  "a manual key cannot be mistaken for a derived one",
  isManualKey("manual::abc") && !isManualKey("na::c-p222::pay"),
);
t("every column is a column", COLUMN_ORDER.every(isTaskColumn) && !isTaskColumn("later"));

console.log("\n[buildBoard]");
{
  const board = buildBoard([derived()], []);
  t("an untouched action item is a card", board.length === 1);
  t("it starts in To do", board[0].column === "todo");
  t("with no database row behind it", board[0].assignee === null && board[0].note === null);
  t("the tracker's words are the card's", board[0].title === derived().title);
  t("and it links back to the page", board[0].href === "/card-tracking-na");
  t("it is open, because the tracker says so", board[0].open === true);
  t("and it is not editable here", board[0].manual === false);
}
{
  const board = buildBoard([derived()], [state({ column: "doing", assignee: "shayma@naboo.app" })]);
  t("a moved card stays where it was put", board[0].column === "doing");
  t("and remembers who has it", board[0].assignee === "shayma@naboo.app");
  // The whole point of storing state per key: a refresh of the tracker data must not
  // sweep the card back to To do.
  t("its text still comes from the tracker", board[0].title === derived().title);
}
{
  // Parked in Done while the tracker still reports it. Shown, flagged, not corrected.
  const board = buildBoard([derived()], [state({ column: "done" })]);
  t("a card parked in Done stays in Done", board[0].column === "done");
  t("but says the work is still open", board[0].staleDone === true);
  t("and is still reported as open", board[0].open === true);
}
{
  // The tracker stopped reporting it: the work resolved itself.
  const board = buildBoard([], [state({ column: "doing", title: "Ask O-A001 about card" })]);
  t("a resolved card is not dropped", board.length === 1);
  t("it moves to Done on its own", board[0].column === "done");
  t("and says it is no longer open", board[0].open === false);
  t("keeping a name to be known by", board[0].title === "Ask O-A001 about card");
  t("with no stale-done warning, because nobody parked it", board[0].staleDone === false);
}
{
  const manual = state({
    key: "manual::1",
    manual: true,
    title: "Chase the Fairmont credit note",
    column: "blocked",
    tracker: "na",
    ref: "C-P222",
  });
  const board = buildBoard([derived()], [manual]);
  t("a typed task is its own card", board.length === 2);
  const card = board.find((x) => x.manual);
  t("its title is what was typed", card.title === "Chase the Fairmont credit note");
  t("it can be edited", card.manual === true);
  t("it links to the tracker it names", card.href === "/tracking-north-america");
  t("a typed task in Blocked is still open", card.open === true);
  t("and one in Done is not", buildBoard([], [{ ...manual, column: "done" }])[0].open === false);
}
{
  // The same action item reported twice in one round must not become two cards.
  const board = buildBoard([derived(), derived()], []);
  t("a repeated action item is one card", board.length === 1);
}

console.log("\n[columns, order and filters]");
{
  const cards = buildBoard(
    [
      derived({ ref: "O-1", kind: "a" }),
      derived({ ref: "O-2", kind: "b", tracker: "na-commissions" }),
    ],
    [state({ key: derivedKey("na-commissions", "O-2", "b"), column: "doing" })],
  );
  const counts = columnCounts(cards);
  t("the counts follow the columns", counts.todo === 1 && counts.doing === 1);
  t("and a column lists its own", columnTasks(cards, "doing").length === 1);
  t(
    "every card is in exactly one column",
    counts.todo + counts.doing + counts.blocked + counts.done === cards.length,
  );

  const chips = trackerCounts(cards);
  t(
    "the chips name the trackers",
    chips.some((c) => c.label === "Card tracking NA"),
  );
  t("and count them", chips.reduce((n, c) => n + c.n, 0) === cards.length);
  t(
    "a typed task is its own chip",
    trackerCounts(buildBoard([], [state({ key: "manual::1", manual: true, title: "x" })]))[0]
      .label === "Added by hand",
  );

  t(
    "a tracker filter narrows",
    matchesFilter(cards[0], { trackers: ["na-cards"], assignee: null, search: "" }),
  );
  t("and excludes", !matchesFilter(cards[0], { trackers: ["veolia"], assignee: null, search: "" }));
  t(
    "only-mine matches the assignee",
    !matchesFilter(cards[0], { trackers: [], assignee: "shayma@naboo.app", search: "" }),
  );
  t(
    "search reaches the subject",
    matchesFilter(cards[0], { trackers: [], assignee: null, search: "hyatt" }),
  );
  t(
    "and the booking ref",
    matchesFilter(cards[0], { trackers: [], assignee: null, search: "o-1" }),
  );
  t(
    "an empty search matches everything",
    matchesFilter(cards[0], { trackers: [], assignee: null, search: "  " }),
  );
}
{
  // Dates first, and money never. A small chase three weeks late outranks a big one
  // raised this morning.
  const a = { ...buildBoard([derived()], [state({ due: "2026-08-01" })])[0] };
  const b = { ...buildBoard([derived({ ref: "O-2" })], [])[0] };
  t("a dated card sorts before an undated one", compareTasks(a, b) < 0);
  t("and the reverse holds", compareTasks(b, a) > 0);
  t("overdue is measured against today", isOverdue(a, "2026-08-03") === true);
  t("a card due later is not overdue", isOverdue(a, "2026-07-01") === false);
  t("and a done card never is", isOverdue({ ...a, column: "done" }, "2026-08-03") === false);
}

console.log("\n[what a person may type]");
{
  const input = (o = {}) => ({
    title: "Chase it",
    tracker: null,
    ref: null,
    assignee: null,
    due: null,
    note: null,
    column: "todo",
    ...o,
  });
  t("a title is required", validateManualTask(input({ title: "  " })) != null);
  t("a good one passes", validateManualTask(input()) === null);
  t("a tracker has to be one of ours", validateManualTask(input({ tracker: "nope" })) != null);
  t("no tracker is fine", validateManualTask(input({ tracker: null })) === null);
  t("a due date has to be a day", validateManualTask(input({ due: "next tuesday" })) != null);
  t("an ISO day is fine", validateManualTask(input({ due: "2026-08-14" })) === null);
  t("a column has to exist", validateManualTask(input({ column: "someday" })) != null);
  t(
    "and a title cannot be an essay",
    validateManualTask(input({ title: "x".repeat(201) })) != null,
  );
}

console.log("\n[names]");
t("a mailbox becomes a name", shortName("shayma.ndiaye@naboo.app") === "shayma ndiaye");
t("initials from both ends", initials("shayma.ndiaye@naboo.app") === "SN");
t("one word still gives two letters", initials("finance@naboo.app") === "FI");
t("nobody is a question mark", initials(null) === "?");

console.log("\n[the feeds restate the trackers, they do not re-decide]");
{
  const quote = (o = {}) => ({
    owner_code: "O-A001",
    quote_id: "q1",
    provider_name: "Hyatt Regency",
    country: "US",
    email: "ap@hyatt.com",
    venue_name: null,
    partner_name: null,
    event_ref: "C-P222",
    currency: "USD",
    outstanding: 1000,
    start_date: "2026-06-21",
    payment_method: "CREDIT_CARD",
    venue_type: "HOTEL",
    ...o,
  });
  const rows = buildRows(aggregateProviders([quote()]), new Map(), new Map());
  const tasks = cardTasks(rows);
  t("an unasked provider is a task", tasks.length === 1);
  t("keyed as the asking job", tasks[0].kind === "card-ask");
  // The card says what to do; the tracker's own sentence rides along as the detail, so
  // the board can be verb-led without paraphrasing the page it came from.
  t(
    "titled with the move, not the state",
    tasks[0].title === "Ask Hyatt Regency whether they take a card",
    tasks[0].title,
  );
  t("with the tracker's own sentence kept", tasks[0].detail.startsWith("Never asked"));
  t("carrying the provider", tasks[0].subject === "Hyatt Regency");
  t("and one currency's figure", tasks[0].amount === "1,000.00 USD");

  // Settled on the tracker means absent from the board. The feed does not get a second
  // opinion about it.
  const settled = buildRows(
    aggregateProviders([quote()]),
    new Map([["O-A001", { ...emptyTerms("O-A001"), accepts_card: "yes", naboo_pays_card: "yes" }]]),
    new Map([["O-A001", NO_EVIDENCE]]),
  );
  t("a settled provider contributes nothing", cardTasks(settled).length === 0);

  // An accepting provider with a fee and no answer is the other job, and a different key.
  const undecided = buildRows(
    aggregateProviders([quote()]),
    new Map([["O-A001", { ...emptyTerms("O-A001"), accepts_card: "yes", fee_percent: 2 }]]),
    new Map(),
  );
  const decide = cardTasks(undecided);
  t("an undecided fee is the deciding job", decide[0].kind === "card-decide");
  t("so it is a different card from the asking one", decide[0].kind !== tasks[0].kind);
}
{
  const row = (o = {}) => ({
    readable_id: "C-P222",
    company_name: "Altman Solon",
    currency_client: "USD",
    total_commission_ht: 4732,
    partners: [{ partner_name: "Hyatt", mismatch: false }],
    ...o,
  });
  t("a booking whose rates agree is not a task", commissionTasks([row()]).length === 0);
  const one = commissionTasks([row({ partners: [{ partner_name: "Hyatt", mismatch: true }] })]);
  t("a mismatch is", one.length === 1);
  t("named for one line", one[0].title.includes("one line does not match"));
  t("carrying the client and the provider", one[0].subject === "Altman Solon · Hyatt");
  t("and the commission at stake", one[0].amount === "4,732.00 USD");
  const two = commissionTasks([
    row({
      partners: [
        { partner_name: "Hyatt", mismatch: true },
        { partner_name: "Fairmont", mismatch: true },
      ],
    }),
  ]);
  t("two lines say two", two[0].title.includes("2 lines do not match"));
  t("a booking with no ref is skipped", commissionTasks([row({ readable_id: null })]).length === 0);
}

console.log("\n[the board's own rules are enforced on the server too]");
{
  const src = readFileSync(new URL("./tasks.functions.ts", import.meta.url), "utf8");
  // A derived card's words belong to its tracker.
  t(
    "only a typed task can be edited",
    /if \(!isManualKey\(data\.key\)\) throw new Error/.test(src),
  );
  t("and the typed rules are checked again here", /validateManualTask\(data\)/.test(src));
  // A feed the caller cannot open contributes nothing.
  t(
    "each feed is gated by its own tracker",
    /if \(!trackers\.includes\(feed\.tracker\)\) continue;/.test(src),
  );
  // A failed feed is named, never silently dropped.
  t("a broken feed is reported", /error: error instanceof Error \? error\.message/.test(src));
  // A drag carries a column and must not wipe the note on the card.
  t(
    "a partial save keeps what it was not sent",
    /column_key = COALESCE\(\$\{data\.column\}, tracker_tasks\.column_key\)/.test(src),
  );
  t(
    "the board never invents a key for a typed task",
    /manual::\$\{crypto\.randomUUID\(\)\}/.test(src),
  );
}

// ── Somebody's own Slack ────────────────────────────────────────────────────
// The rule that matters here is a privacy one, and half of it lives in SQL: these rows
// are only ever read for the session's own account. What the model has to get right is
// that a Slack card carries no tracker, so it can never be grouped, filtered or linked
// as though it belonged to a shared page.
console.log("\n[the Slack feed]");
{
  const items = [
    {
      slack_id: "Rm1",
      kind: "reminder",
      title: "Call the Fairmont back",
      due: "2026-08-05",
      permalink: null,
    },
    {
      slack_id: "C123:1785.1",
      kind: "saved",
      title: "Invoice query from Arora",
      due: null,
      permalink: "https://naboo.slack.com/archives/C123/p1785",
    },
  ];
  const tasks = slackTasks(items);
  t("each item is a card", tasks.length === 2);
  t(
    "with no tracker on it",
    tasks.every((x) => x.tracker === null),
  );
  t(
    "labelled as the person's own Slack",
    tasks.every((x) => x.sourceLabel === "My Slack"),
  );
  t(
    "a reminder and a save are different kinds",
    tasks[0].kind === "slack-reminder" && tasks[1].kind === "slack-saved",
  );
  t("the words are the person's own", tasks[0].title === "Call the Fairmont back");
  t("a reminder's own date comes with it", tasks[0].due === "2026-08-05");
  t(
    "and a saved message links back to Slack",
    tasks[1].permalink?.startsWith("https://naboo.slack.com"),
  );
  t(
    "no figure is invented for it",
    tasks.every((x) => x.amount === null),
  );

  const board = buildBoard(tasks, []);
  t("they reach the board", board.length === 2);
  t("keyed under slack, never under a tracker", board[0].key.startsWith("slack::"));
  t(
    "the card opens Slack rather than a tracker page",
    board[1].href?.includes("slack.com") === true,
  );
  t("a Slack reminder's date is the card's due date", board[0].due === "2026-08-05");
  // Board state still wins: a date typed here is the one that counts.
  const dated = buildBoard(tasks, [{ ...state({ key: board[0].key }), due: "2026-08-10" }]);
  t("a date typed on the card overrides Slack's", dated[0].due === "2026-08-10");
  t(
    "and it can be moved like any other card",
    buildBoard(tasks, [{ ...state({ key: board[0].key }), column: "doing" }])[0].column === "doing",
  );

  const chips = trackerCounts(board);
  t(
    "they get their own chip",
    chips.some((c) => c.label === "My Slack"),
  );
  t(
    "and filter as their own group",
    matchesFilter(board[0], { trackers: ["slack"], assignee: null, search: "" }) &&
      !matchesFilter(board[0], { trackers: ["na-cards"], assignee: null, search: "" }),
  );
}

// ── What a card looks like ──────────────────────────────────────────────────
// The visible layer has rules of its own, and they are the ones a reader trusts without
// checking: a date said in words, urgency that actually reorders the column, and a badge
// that promises a card will leave on its own.
console.log("\n[dates, as a card says them]");
{
  const on = (due, column = "todo") => ({ ...derived(), due, column, priority: "normal" });
  t("no date is said, not left blank", dueInfo(on(null), "2026-08-03").label === "No date");
  t("today is today", dueInfo(on("2026-08-03"), "2026-08-03").label === "Today");
  t("and tomorrow is tomorrow", dueInfo(on("2026-08-04"), "2026-08-03").label === "Tomorrow");
  t(
    "late says how late",
    dueInfo(on("2026-07-29"), "2026-08-03").label === "5d overdue",
    dueInfo(on("2026-07-29"), "2026-08-03").label,
  );
  t("and it reads as a problem", dueInfo(on("2026-07-29"), "2026-08-03").tone === "red");
  t("further out is a date", dueInfo(on("2026-08-12"), "2026-08-03").label === "Aug 12");
  // A closed card's date is history, not a deadline — so it never reads as overdue.
  t(
    "a closed card's date is history",
    dueInfo(on("2026-07-29", "done"), "2026-08-03").label === "Jul 29" &&
      dueInfo(on("2026-07-29", "done"), "2026-08-03").tone === "green",
  );
  t("month and day, no year", formatDay("2026-08-12") === "Aug 12");
  t("a month boundary counts in days", daysBetween("2026-07-29", "2026-08-03") === 5);
  t("and a bad day is not guessed at", daysBetween("", "2026-08-03") === null);
}

console.log("\n[urgent, then late, then the rest]");
{
  const card = (o) =>
    buildBoard(
      [derived({ ref: o.ref, kind: o.ref })],
      [state({ key: derivedKey("na-cards", o.ref, o.ref), ...o })],
    )[0];
  const urgent = card({ ref: "u", priority: "urgent", due: "2026-08-20" });
  const late = card({ ref: "l", priority: "normal", due: "2026-07-30" });
  const soon = card({ ref: "s", priority: "normal", due: "2026-08-04" });
  const undated = card({ ref: "n", priority: "normal", due: null });
  const day = "2026-08-03";
  const order = [undated, soon, late, urgent].sort((a, b) => compareTasks(a, b, day));
  t(
    "urgent outranks a nearer date",
    order.map((c) => c.ref).join(" ") === "u l s n",
    order.map((c) => c.ref).join(" "),
  );
  t("and both outrank an undated card", order[3].ref === "n");
  t(
    "urgent and late is the top rank",
    rankTask(card({ ref: "b", priority: "urgent", due: "2026-07-01" }), day) === -1,
  );
  t("plain and undated is the bottom", rankTask(undated, day) === 2);
  // Without a day the lateness half simply does not apply — the order stays a pure
  // function of its inputs rather than of the clock.
  t("no day means no lateness", rankTask(late, "") === 2);

  const board = [undated, late, urgent];
  t(
    "the list groups by column before it sorts",
    listOrder([{ ...undated, column: "done" }, late], day)
      .map((c) => c.column)
      .join(" ") === "todo done",
  );
  t("the board's stats count what is shown", boardStats(board, day).open === 3);
  t("late cards are counted once", boardStats(board, day).overdue === 1);
  t("and urgency is counted separately", boardStats(board, day).urgent === 1);
  const withManual = [...board, { ...undated, manual: true, open: true }];
  t("automatic means nobody typed it", boardStats(withManual, day).automatic === 3);
}

console.log("\n[which badge a card wears]");
{
  const card = buildBoard([derived()], [])[0];
  t("a tracker card wears its tracker", trackerBadge(card).label === "Card tracking NA");
  t("with the tint that tracker has elsewhere", trackerBadge(card).tone === "orange");
  t("and the kind is named in words", sourceLabel(card) === "Card question");
  const manual = buildBoard([], [state({ key: "manual::1", manual: true, title: "x" })])[0];
  t("a typed card says so", trackerBadge(manual).label === "Added by hand");
  t("and its source is the same thing", sourceLabel(manual) === "Added by hand");
  const mention = buildBoard(
    [
      {
        tracker: null,
        kind: "slack-mention",
        ref: "C1:1",
        title: "look at this",
        subject: "Mentioned in #finance-na",
        amount: null,
        owner: "us",
        sourceLabel: "My Slack",
      },
    ],
    [],
  )[0];
  t("a Slack card is not a tracker's", trackerBadge(mention).label === "My Slack");
  t("and knows it came from a mention", sourceLabel(mention) === "Slack mention");

  const tasks = [card, manual, mention];
  t("the source select lists what is there", sourceOptions(tasks).length === 3);
  t(
    "and filtering by one keeps only it",
    tasks.filter((x) => matchesFilter(x, { ...NO_FILTER, source: "Slack mention" })).length === 1,
  );
  t(
    "unassigned is a real answer",
    tasks.filter((x) => matchesFilter(x, { ...NO_FILTER, assignee: "none" })).length === 3,
  );
  t("an unfiltered board says so", !isFiltered(NO_FILTER));
  t("and a filtered one says so too", isFiltered({ ...NO_FILTER, source: "Slack mention" }));

  // A booking ref means something to a reader; a Slack message id does not, and printing
  // it where a ref goes claims it is one.
  t("a booking ref is printed", refLabel(card) === "O-A001");
  t("a Slack id is not", refLabel(mention) === null);

  // Three different promises, because three different things are true.
  t("a tracker card leaves on its own", resolveHint(card).includes("stops reporting"));
  t("a typed card never does", resolveHint(manual).includes("until you close it"));
  t("a mention ages out", resolveHint(mention).includes("kept for a week"));
  t(
    "and a reminder closes in Slack",
    resolveHint(
      buildBoard(
        [
          {
            tracker: null,
            kind: "slack-reminder",
            ref: "Rm1",
            title: "call back",
            subject: null,
            amount: null,
            owner: "us",
            sourceLabel: "My Slack",
          },
        ],
        [],
      )[0],
    ).includes("Completing it in Slack"),
  );
  t(
    "a resolved card says what happened",
    resolveHint(buildBoard([], [state({ title: "x" })])[0]).includes("closed itself"),
  );
}

// ── Activity: what a mention is, and what it is not ─────────────────────────
// The rule the user set is narrow and worth pinning exactly: everything that mentions them
// is a task except the queued-payment acknowledgement. So there are two failure modes to
// guard against — the exclusion not firing because the text arrived in a different shape,
// and the exclusion firing on real work that happens to look similar.
console.log("\n[mentions become action items, except the one that never is]");
{
  const queued = "Payment in queue — tag @Shayma if you need urgent validation.";
  t("the acknowledgement is not a task", !isActionItem(queued));
  t("and it says why", (ignoredBecause(queued) ?? "").includes("no reply is expected"));

  // The same line as Slack actually sends it: raw mention markup, plain dashes, shouting,
  // ragged whitespace. An exclusion that only works on the tidy version is worse than none.
  const shapes = [
    "Payment in queue <@U012SHAYMA|shayma> if you need urgent validation",
    "payment in queue -- tag @shayma if you need urgent validation",
    "PAYMENT IN QUEUE — TAG @SHAYMA IF YOU NEED URGENT VALIDATION.",
    "Payment in queue  —  tag  @shayma  if you need urgent validation",
  ];
  t(
    "in every shape Slack sends it",
    shapes.every((s) => !isActionItem(s)),
    shapes.filter(isActionItem).join(" | "),
  );
  t(
    "the raw mention flattens to a handle",
    normaliseActivity("Ping <@U012SHAYMA|shayma> about it") === "ping @shayma about it",
  );
  t(
    "and a link keeps its label, not its url",
    normaliseActivity("see <https://naboo.app/x|the invoice>") === "see the invoice",
  );

  // Real work, including work that mentions a payment queue. Nothing here may be dropped.
  const real = [
    "@shayma the Fairmont invoice is wrong",
    "Payment in queue for CR893 has been stuck since Friday — can you look?",
    "tag @shayma if you need urgent validation on the new process doc",
    "queue is empty, payment went out",
  ];
  t(
    "everything else is a task",
    real.every(isActionItem),
    real.filter((x) => !isActionItem(x)).join(" | "),
  );
  t("an empty message is not", !isActionItem("   "));

  // The mention has to be of the person reading the board — search is full text, so this
  // is what stops somebody else's mention becoming their card.
  const me = { id: "U012SHAYMA", handle: "shayma" };
  t("a raw mention counts", mentionsPerson("hi <@U012SHAYMA> can you check", me));
  t("a rendered handle counts", mentionsPerson("hi @shayma can you check", me));
  t("somebody else's mention does not", !mentionsPerson("hi <@U099VIRGINIE> ping", me));
  t("nor a name in passing", !mentionsPerson("shayma is on the Fairmont one", me));
  t("nor a longer handle that starts the same", !mentionsPerson("@shaymandiaye ping", me));

  // The card says what was said, in the words it was said in.
  t(
    "the title is the person's own words",
    activityTitle("<@U012SHAYMA|shayma> the Fairmont invoice is wrong") ===
      "@shayma the Fairmont invoice is wrong",
  );
  const flat = `${"word ".repeat(60)}end`;
  const long = activityTitle(flat, 40);
  // Cut at a word boundary means: what is kept is a prefix of the original, and the
  // original carries on with a space rather than mid-word.
  const kept = long.slice(0, -1);
  t(
    "a long message is cut at a word",
    long.length <= 41 && flat.startsWith(kept) && flat[kept.length] === " ",
    long,
  );
  t("and marked as cut", long.endsWith("…"));
  t(
    "a short one is left alone",
    activityTitle("Call the Fairmont back") === "Call the Fairmont back",
  );
  t("the channel is named", activitySubject("finance-na") === "Mentioned in #finance-na");
  t("with or without its hash", activitySubject("#finance-na") === "Mentioned in #finance-na");
  t("and a DM still says where", activitySubject(null) === "Mentioned in Slack");

  // On the board: a mention is a card like any other, and the exclusion applies again on
  // the way out so a rule added today quiets rows stored yesterday.
  const stored = [
    {
      slack_id: "C123:1785.2",
      kind: "mention",
      title: "@shayma the Fairmont invoice is wrong",
      subject: "Mentioned in #finance-na",
      due: null,
      permalink: "https://naboo.slack.com/archives/C123/p17852",
    },
    {
      slack_id: "C123:1785.3",
      kind: "mention",
      title: queued,
      subject: "Mentioned in #finance-na",
      due: null,
      permalink: null,
    },
  ];
  const mentionTasks = slackTasks(stored);
  t("the acknowledgement is dropped even once stored", mentionTasks.length === 1);
  t("the mention is its own kind", mentionTasks[0].kind === "slack-mention");
  t("and says where it was said", mentionTasks[0].subject === "Mentioned in #finance-na");
  t("it carries no tracker", mentionTasks[0].tracker === null);
  const mentionBoard = buildBoard(mentionTasks, []);
  t("it lands in To do", mentionBoard[0].column === "todo");
  t("keyed as a Slack card", mentionBoard[0].key === "slack::c123:1785.2::slack-mention");
  t("and opens the thread", mentionBoard[0].href?.includes("/archives/C123/") === true);
}

console.log("\n[the connector can only read the connecting person]");
{
  const src = readFileSync(new URL("./slack-user.server.ts", import.meta.url), "utf8");
  // The scopes are the promise. All three are user scopes — they see what this person can
  // already see and nothing further — and no bot or channel scope is asked for.
  t(
    "three user scopes, and only three",
    /SLACK_USER_SCOPES = \["reminders:read", "stars:read", "search:read"\]/.test(src),
  );
  t("no channel scope is requested", !/channels:|groups:|im:|mpim:/.test(src));
  // The endpoints, and each anchored to the token's owner.
  const methods = [...src.matchAll(/slack<[^>]*>\(\s*email,\s*[`"]([^`"]+)[`"]/g)].map((m) => m[1]);
  t("exactly four Slack methods are called", methods.length === 4, methods.join(", "));
  t(
    "and they are the personal ones",
    methods.every((m) => /^reminders\.list|^stars\.list|^auth\.test|^search\.messages/.test(m)),
    methods.join(", "),
  );
  // Search is the one read that takes a query, so the anchoring is the code's job: the
  // handle comes from auth.test on this person's own token, never from a caller.
  t("the search query is the caller's own handle", /query=\$\{query\}/.test(src));
  t(
    "and that handle is asked of Slack, not passed in",
    /const query = encodeURIComponent\(`@\$\{me\.handle \|\| me\.id\}`\)/.test(src) &&
      /const me = await whoAmI\(email\)/.test(src),
  );
  t(
    "every match is checked against that same person",
    /if \(!mentionsPerson\(match\.text, me\)\) continue/.test(src),
  );
  t(
    "nothing lists channels or people",
    !/conversations\.history|conversations\.list|users\.list|users\.info/.test(src),
  );
  t(
    "the excluded acknowledgement never becomes a task",
    /if \(!isActionItem\(match\.text\)\) continue/.test(src),
  );
  // Reads and writes are both keyed on the owner.
  t("the read is scoped to one person", /WHERE owner_email = \$\{email\}/.test(src));
  t("so is the replace", /DELETE FROM slack_tasks\s+WHERE owner_email = \$\{email\}/.test(src));
  // Reminders are state and can be replaced; a mention happened once and would be lost.
  t(
    "only reminders and saves are replaced",
    /WHERE owner_email = \$\{email\} AND kind IN \$\{tx\(STATE_KINDS\)\}/.test(src),
  );
  t(
    "a mention read twice stays one card",
    /ON CONFLICT \(owner_email, slack_id\) DO NOTHING/.test(src),
  );
  t("and old mentions are pruned", /AND kind = 'mention'\s+AND first_seen_at </.test(src));
  t(
    "the window and the cron are one number",
    /MENTION_WINDOW_MINUTES = 15/.test(src) && /windowMinutes = MENTION_WINDOW_MINUTES/.test(src),
  );
  t(
    "disconnecting takes the tasks with it",
    /DELETE FROM slack_tasks WHERE owner_email[\s\S]{0,200}DELETE FROM slack_credentials/.test(src),
  );
  t("and revokes at Slack, not just here", /auth\.revoke/.test(src));
  t("the token is encrypted at rest", /encryptSecret\(input\.token\)/.test(src));

  const board = readFileSync(new URL("./tasks.functions.ts", import.meta.url), "utf8");
  // The privacy rule in one line: the address is the session's, never the client's.
  t("the board reads Slack for the session only", /readSlackTasks\(session\.email\)/.test(board));
  t("and reports only the caller's connection", /getSlackConnection\(session\.email\)/.test(board));
  t("Slack is not a shared feed", !/tracker: "slack"/.test(board));

  const cron = readFileSync(new URL("./cron-routes.server.ts", import.meta.url), "utf8");
  t("the cron answers to a secret", /auth !== `Bearer \$\{secret\}`/.test(cron));
  t("and refuses when there is none configured", /CRON_SECRET is not set/.test(cron));
  t("it loops over grants, not over people", /connectedSlackUsers\(\)/.test(cron));
  t(
    "one person's failure is theirs alone",
    /failed\.push\(\{ email, error: message \}\)/.test(cron),
  );

  const vercel = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
  t("every fifteen minutes", vercel.crons[0].schedule === "*/15 * * * *");
  t("on the Slack job", vercel.crons[0].path === "/api/cron/slack-tasks");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
