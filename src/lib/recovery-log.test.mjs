import {
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
