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
  buildBoard,
  columnCounts,
  columnTasks,
  compareTasks,
  derivedKey,
  initials,
  isManualKey,
  isOverdue,
  isTaskColumn,
  matchesFilter,
  shortName,
  trackerCounts,
  validateManualTask,
} from "./tasks.ts";
import { cardTasks, commissionTasks } from "./task-feeds.ts";
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
  t("named by the tracker's own sentence", tasks[0].title.startsWith("Never asked"));
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
