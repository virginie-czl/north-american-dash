import { readFileSync } from "node:fs";
import {
  chaseProgress,
  chasedLabel,
  fullyChased,
  recoveryScopeOf,
  recoveryKey,
  recoveryIndex,
  recoverySender,
  recoverySentDay,
  recoverySentLabel,
} from "./recovery-log.ts";

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

const send = (o = {}) => ({
  event_ref: "C-O621",
  recipient: "kevin.cabrera2@hilton.com",
  scope: "partner",
  mode: "refund",
  recipient_name: "Double Tree",
  subject: "Overpayment on Booking C-O621",
  sent_at: "2026-07-12T09:14:00.000Z",
  sent_by: "marie.dupont@naboo.app",
  sent_by_name: "Marie Dupont",
  ...o,
});

console.log("\n[recoveryScopeOf]");
t("a client ask is its own scope", recoveryScopeOf("client") === "client");
t("commission is a partner ask", recoveryScopeOf("commission") === "partner");
t("refund is a partner ask", recoveryScopeOf("refund") === "partner");
t("combined is a partner ask", recoveryScopeOf("combined") === "partner");

console.log("\n[recoveryKey]");
{
  const k = (mode) => recoveryKey("C-O621", "Kevin.Cabrera2@Hilton.com", mode);
  t(
    "case and spacing never change the key",
    k("refund") === recoveryKey("C-O621", " kevin.cabrera2@hilton.com ", "refund"),
  );
  t(
    "one provider conversation: the commission ask closes the door on the refund ask",
    k("commission") === k("refund") && k("refund") === k("combined"),
  );
  t("a client ask is a different lock from a provider ask", k("client") !== k("refund"));
  t(
    "the same provider on another booking is a different lock",
    k("refund") !== recoveryKey("C-R621", "kevin.cabrera2@hilton.com", "refund"),
  );
}

console.log("\n[recoveryIndex]");
{
  const index = recoveryIndex([
    send(),
    send({ event_ref: "C-R621", mode: "commission" }),
    send({ scope: "client", mode: "client", recipient: "ap@sopacins.com" }),
  ]);
  t("indexes by booking, recipient and scope", index.size === 3);
  t(
    "a combined ask finds the refund already sent",
    index.get(recoveryKey("C-O621", "KEVIN.CABRERA2@hilton.com", "combined"))?.mode === "refund",
  );
  t(
    "a client ask is found on its own key",
    index.get(recoveryKey("C-O621", "ap@sopacins.com", "client"))?.mode === "client",
  );
  t(
    "nothing sent to this provider on that other booking's client side",
    index.get(recoveryKey("C-R621", "kevin.cabrera2@hilton.com", "client")) === undefined,
  );
}

console.log("\n[labels]");
t("day reads dd/mm/yy", recoverySentDay(send()) === "12/07/26", recoverySentDay(send()));
t("sender is the recorded name", recoverySender(send()) === "Marie Dupont");
t(
  "falls back to the mailbox name when no display name",
  recoverySender(send({ sent_by_name: null })) === "marie.dupont",
);
t(
  "label answers who and when",
  recoverySentLabel(send()) === "Sent on 12/07/26 by Marie Dupont",
  recoverySentLabel(send()),
);
t(
  "an unparseable timestamp still says something",
  recoverySentDay(send({ sent_at: "not a date" })) === "not a date",
);

// ── A chase this app never saw ──────────────────────────────────────────────
// Most of the value of the ledger is negative: it tells the next colleague not to
// send. An email written from a personal mailbox, or a reply in a thread already
// running, is invisible to it — and invisible reads as "nobody has chased this",
// which is how the same provider gets written to twice. So a send can be recorded by
// hand, and the record says which it is: this app saw one of them and not the other,
// and one word is the whole difference between evidence and somebody's word.
console.log("\n[a send recorded by hand]");
t(
  "it never claims we sent it",
  recoverySentLabel(send({ by_hand: true })) === "Marked sent on 12/07/26 by Marie Dupont",
  recoverySentLabel(send({ by_hand: true })),
);
t(
  "and a real send still reads plainly",
  recoverySentLabel(send()) === "Sent on 12/07/26 by Marie Dupont",
);
// It locks the ask exactly like a send: same key, same scope. A mark that did not lock
// would be a note nobody acts on.
t(
  "it locks on the same key a send does",
  recoveryKey("C-O621", "Kevin.Cabrera2@Hilton.com", "combined") ===
    recoveryKey("C-O621", "kevin.cabrera2@hilton.com", "refund"),
);
{
  const fns = readFileSync(new URL("./recovery-log.functions.ts", import.meta.url), "utf8");
  t("the mark is stamped with the session", /sent_by: session\.email/.test(fns));
  t("and the browser cannot name a sender", !/sent_by:\s*(data|input)\./.test(fns));
  t("it is stored as recorded by hand", /by_hand: true/.test(fns));

  const server = readFileSync(new URL("./recovery-log.server.ts", import.meta.url), "utf8");
  const undo = (server.match(/DELETE FROM recovery_emails[\s\S]*?by_hand = true/) ?? [""])[0];
  // The one that matters: a real send left a message in somebody's Sent folder, and no
  // button may make that record disappear. Undo reaches hand-recorded rows only.
  t("undo only ever reaches a hand-recorded row", undo.includes("by_hand = true"));
  t(
    "and the insert carries the flag",
    /by_hand\)\s*\n?[\s\S]{0,200}input\.by_hand === true/.test(server),
  );
}

// ── Whose move is it once the email has gone out ────────────────────────────
// Marketplace NA files a booking with a commission or refund to recover under "Ours to
// move" — somebody has to write the email. Once it is written the money is theirs to
// return, so the booking belongs to the partner. The ledger is the only record of the
// send, so this is what the pill reads.
console.log("\n[chaseProgress]");
{
  const plans = [
    { eventRef: "C-O621", address: "Kevin.Cabrera2@Hilton.com", mode: "commission" },
    { eventRef: "C-O621", address: "ap@fairmont.com", mode: "refund" },
    { eventRef: "C-P222", address: "ap@convene.com", mode: "combined" },
  ];

  const none = chaseProgress(plans, new Map());
  t("nothing sent: two targets on the first booking", none.get("C-O621").targets === 2);
  t("and none of them chased", none.get("C-O621").sent === 0);
  t("so the booking is not chased", !fullyChased(none.get("C-O621")));
  t("an unknown booking is not chased either", !fullyChased(none.get("C-NOPE")));

  // One of two providers written to: the second email is still ours to send.
  const half = chaseProgress(plans, recoveryIndex([send({ event_ref: "C-O621" })]));
  t("one of two counts", half.get("C-O621").sent === 1);
  t("a half-chased booking is still ours", !fullyChased(half.get("C-O621")));

  // Both written to. Note the plan's address is mixed case and the ledger's is not:
  // the key lowercases, which is the whole reason it exists.
  const both = chaseProgress(
    plans,
    recoveryIndex([
      send({ event_ref: "C-O621" }),
      send({
        event_ref: "C-O621",
        recipient: "ap@fairmont.com",
        mode: "refund",
        sent_at: "2026-07-14T09:00:00.000Z",
      }),
    ]),
  );
  t("both counted despite the casing", both.get("C-O621").sent === 2);
  t("now it is the partner's move", fullyChased(both.get("C-O621")));
  t(
    "the label carries the latest send",
    chasedLabel(both.get("C-O621")) === "Chased 14/07/26",
    chasedLabel(both.get("C-O621")),
  );
  t("the other booking is untouched", !fullyChased(both.get("C-P222")));

  // A commission and a refund to the same provider are one conversation: the ledger
  // scope is the side of the marketplace, so either email marks it chased.
  const combined = chaseProgress(
    [{ eventRef: "C-P222", address: "ap@convene.com", mode: "combined" }],
    recoveryIndex([send({ event_ref: "C-P222", recipient: "ap@convene.com", mode: "commission" })]),
  );
  t("a commission email answers a combined plan", fullyChased(combined.get("C-P222")));

  // A client email is a different conversation and must never mark the partner chase
  // done — the scope in the key is what keeps them apart.
  const clientOnly = chaseProgress(
    [{ eventRef: "C-P222", address: "ap@convene.com", mode: "combined" }],
    recoveryIndex([
      send({ event_ref: "C-P222", recipient: "ap@convene.com", mode: "client", scope: "client" }),
    ]),
  );
  t("a client email does not chase the partner", !fullyChased(clientOnly.get("C-P222")));

  t("no plans at all is not a chased booking", chaseProgress([], new Map()).size === 0);
  t(
    "a missing ledger is treated as nothing sent",
    !fullyChased(chaseProgress(plans, undefined).get("C-O621")),
  );
  t(
    "a send with no timestamp still labels",
    chasedLabel({ targets: 1, sent: 1, lastSentAt: null }) === "Chased",
  );
}

console.log("\n[the page is wired to it]");
{
  const src = readFileSync(
    new URL("../routes/_authenticated/tracking-north-america.tsx", import.meta.url),
    "utf8",
  );
  // Built from the plans the buttons use, not from a second list — the two disagreeing
  // is how a provider gets chased twice.
  t(
    "the chase index comes from the recovery plans",
    /chaseProgress\(\s*recoveryPlans\.map/.test(src),
  );
  t("and from the shared ledger", /recoveryLog,\s*\),/.test(src));
  t(
    "the move asks before claiming the booking is ours",
    /if \(fullyChased\(chase\)\) \{/.test(src),
  );
  t("and hands it to the partner", /group: "partner", label: chasedLabel/.test(src));
  // The figure and its caption must not move: the Commission and Refund chips count
  // bookings by headlineLabel, so changing it would empty them.
  const branch = src.slice(
    src.indexOf("const chase = partnerChase.get"),
    src.indexOf('group: "ours",'),
  );
  t("the headline is not rewritten on the way", !/headline:\s*`/.test(branch));
  t("moveFor re-runs when a send lands", /\[actionFor, partnerChase\]/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
