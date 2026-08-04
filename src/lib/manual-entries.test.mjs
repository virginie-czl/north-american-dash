/**
 * The reconciliation between hand-typed stand-ins and the warehouse.
 *
 * This is the piece that, if wrong, puts a confidently wrong figure on a document a client
 * reads — too low while the warehouse lags, too high the moment it catches up and the same
 * invoice is counted twice. So the two steps it exists for are pinned hardest: which
 * entries the warehouse has superseded, and what the union then contains.
 */
import { readFileSync } from "node:fs";
import {
  normaliseRef,
  reconcile,
  refWarning,
  seriesPrefix,
  signedAmount,
  validateManualEntry,
} from "./manual-entries.ts";

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

const doc = (ref, amount, o = {}) => ({
  ref,
  kind: amount < 0 ? "CREDIT_NOTE" : "INVOICE",
  status: "ISSUED",
  currency: "USD",
  amount,
  issued: "2026-08-04",
  due: "2026-08-11",
  ...o,
});

const pay = (amount, paid_on, o = {}) => ({
  paid_on,
  amount,
  currency: "USD",
  method: "Bank transfer",
  reference: null,
  ...o,
});

const entry = (o = {}) => ({
  id: 1,
  event_ref: "C-U332",
  kind: "invoice",
  document_ref: "USI-US26-00063",
  issued_on: "2026-08-04",
  due_on: "2026-08-11",
  amount: 12000,
  currency: "USD",
  method: null,
  note: null,
  created_by: "shayma.ndiaye@naboo.app",
  created_at: "2026-08-04T09:00:00Z",
  ...o,
});

const total = (docs) => Math.round(docs.reduce((n, d) => n + d.amount, 0) * 100) / 100;

// ── Step 4: the union while the warehouse still lags ────────────────────────
console.log("\n[what the statement shows while the warehouse lags]");
{
  const warehouse = [doc("USI-US26-00002", 148056, { issued: "2026-06-10" })];
  const r = reconcile({ documents: warehouse, payments: [], entries: [entry()] });
  t("the hand-typed invoice reaches the statement", r.documents.length === 2);
  t("nothing is superseded yet", r.supersededIds.length === 0);
  t("and it is kept", r.keptIds.join() === "1");
  t("the total moves by its amount", total(r.documents) === 160056);
  const added = r.documents.find((d) => d.ref === "USI-US26-00063");
  t("it carries its own reference", added != null);
  t("its dates come through", added.issued === "2026-08-04" && added.due === "2026-08-11");
  t("and it reads as an ordinary invoice", added.kind === "INVOICE" && added.status === "ISSUED");
}

// ── Step 3: the warehouse catches up ────────────────────────────────────────
// The failure this whole feature would otherwise create: the real document lands, the
// stand-in is still there, and the statement bills the client twice for one invoice.
console.log("\n[when the warehouse catches up]");
{
  const real = doc("USI-US26-00063", 12000);
  const r = reconcile({ documents: [real], payments: [], entries: [entry()] });
  t("the stand-in is marked for deletion", r.supersededIds.join() === "1");
  t("it does not survive into the union", r.documents.length === 1);
  t("the figure is the warehouse's", total(r.documents) === 12000);
  t("and nothing was kept", r.keptIds.length === 0);

  // Idempotence: the caller deletes what step 3 named, so a second pass has nothing to do
  // and cannot change a number.
  const second = reconcile({ documents: [real], payments: [], entries: [] });
  t("a second generation is a no-op", second.supersededIds.length === 0);
  t("with identical figures", total(second.documents) === total(r.documents));
}

// The reference is the only identifier both sides share, so it has to survive being typed
// by a human: different case, spaces for dashes, a stray trailing space.
console.log("\n[matching a reference the way a person types it]");
{
  const real = [doc("USI-US26-00063", 12000)];
  for (const typed of [
    "usi-us26-00063",
    "USI US26 00063",
    "  USI-US26-00063  ",
    "usiUS2600063",
    "USI/US26/00063",
  ]) {
    const r = reconcile({
      documents: real,
      payments: [],
      entries: [entry({ document_ref: typed })],
    });
    t(
      `"${typed}" is the same document`,
      r.supersededIds.length === 1,
      JSON.stringify(r.supersededIds),
    );
  }
  const other = reconcile({
    documents: real,
    payments: [],
    entries: [entry({ document_ref: "USI-US26-00064" })],
  });
  t("a different number is a different document", other.supersededIds.length === 0);
  t("and it is kept", other.documents.length === 2);
  t("an empty reference matches nothing", normaliseRef("") === "" && normaliseRef(null) === "");
}

// ── Payments: no reference of their own ─────────────────────────────────────
console.log("\n[payments match on the day, the amount and the currency]");
{
  const p = entry({
    id: 7,
    kind: "payment",
    document_ref: null,
    due_on: null,
    amount: 57314.85,
    issued_on: "2026-07-23",
    method: "Bank transfer",
  });
  const warehouse = [pay(57314.85, "2026-07-23")];
  const r = reconcile({ documents: [], payments: warehouse, entries: [p] });
  t("the same money on the same day is the same payment", r.supersededIds.join() === "7");
  t("and it is not counted twice", r.payments.length === 1);

  // Any of the three differing makes it a different payment.
  const otherDay = reconcile({
    documents: [],
    payments: warehouse,
    entries: [{ ...p, issued_on: "2026-07-24" }],
  });
  t("a different day is a different payment", otherDay.payments.length === 2);
  const otherAmount = reconcile({
    documents: [],
    payments: warehouse,
    entries: [{ ...p, amount: 57314.86 }],
  });
  t("a cent apart is a different payment", otherAmount.payments.length === 2);
  const otherCcy = reconcile({
    documents: [],
    payments: warehouse,
    entries: [{ ...p, currency: "CAD" }],
  });
  t("a different currency is a different payment", otherCcy.payments.length === 2);
  t(
    "and none of those was superseded",
    otherDay.supersededIds.length === 0 && otherCcy.supersededIds.length === 0,
  );

  // A payment typed before the warehouse had it keeps the method and reference typed.
  const alone = reconcile({
    documents: [],
    payments: [],
    entries: [{ ...p, document_ref: "RAMP-8891" }],
  });
  t("a hand-typed payment reaches the statement", alone.payments.length === 1);
  t("with its own method", alone.payments[0].method === "Bank transfer");
  t("and its own reference", alone.payments[0].reference === "RAMP-8891");
  const bare = reconcile({ documents: [], payments: [], entries: [{ ...p, method: null }] });
  t("and says so when no method was given", bare.payments[0].method === "Recorded by hand");
}

// Two manual payments onto one warehouse row: one is the stand-in, the other might be a
// second genuine payment. Guessing costs either a double count or a lost payment.
console.log("\n[two payments that look alike]");
{
  const p = (id) =>
    entry({
      id,
      kind: "payment",
      document_ref: null,
      due_on: null,
      amount: 5000,
      issued_on: "2026-08-01",
    });
  const r = reconcile({
    documents: [],
    payments: [pay(5000, "2026-08-01")],
    entries: [p(11), p(12)],
  });
  t("one of them is superseded", r.supersededIds.join() === "11");
  t("the other survives", r.keptIds.join() === "12");
  t("it is flagged rather than dropped", r.conflicts.length === 1);
  t("the flag names the entry", r.conflicts[0].entryId === 12);
  t("and says why", r.conflicts[0].reason === "duplicate-payment");
  t("the statement shows both", r.payments.length === 2);

  // Two warehouse rows for two stand-ins: both are superseded and nothing is flagged.
  const twin = reconcile({
    documents: [],
    payments: [pay(5000, "2026-08-01"), pay(5000, "2026-08-01")],
    entries: [p(11), p(12)],
  });
  t("two real payments retire two stand-ins", twin.supersededIds.join() === "11,12");
  t("with nothing flagged", twin.conflicts.length === 0);
  t("and nothing added", twin.payments.length === 2);

  // Nothing in the warehouse at all: two identical hand-typed payments are two payments.
  const none = reconcile({ documents: [], payments: [], entries: [p(11), p(12)] });
  t("no warehouse row means no conflict to raise", none.conflicts.length === 0);
  t("and both are kept", none.payments.length === 2);
}

// ── A credit note is negative, and the type decides ─────────────────────────
console.log("\n[a credit note never adds to the invoiced total]");
{
  t("a positive typed under credit note is signed", signedAmount("credit_note", 4800) === -4800);
  t("and a negative one stays negative", signedAmount("credit_note", -4800) === -4800);
  t("an invoice is always positive", signedAmount("invoice", -1200) === 1200);
  const r = reconcile({
    documents: [doc("USI-US26-00002", 10000)],
    payments: [],
    entries: [
      entry({
        id: 3,
        kind: "credit_note",
        document_ref: "USI-US26-00055",
        amount: signedAmount("credit_note", 4800),
      }),
    ],
  });
  t("it reduces the total", total(r.documents) === 5200);
  t("and reads as a credit note", r.documents[1].kind === "CREDIT_NOTE");
}

// ── What a person is allowed to type ────────────────────────────────────────
console.log("\n[validation, because these figures face a client]");
{
  const base = {
    kind: "invoice",
    document_ref: "USI-US26-00063",
    issued_on: "2026-08-04",
    due_on: "2026-08-11",
    amount: 12000,
    currency: "USD",
    method: null,
    note: null,
  };
  t("a complete entry is accepted", validateManualEntry(base) === null);
  t("zero is refused", validateManualEntry({ ...base, amount: 0 }) != null);
  t("and so is a missing amount", validateManualEntry({ ...base, amount: null }) != null);
  t(
    "a due date before the issue date is refused",
    validateManualEntry({ ...base, due_on: "2026-08-03" }) != null,
  );
  t("the same day is fine", validateManualEntry({ ...base, due_on: "2026-08-04" }) === null);
  t("no due date at all is fine", validateManualEntry({ ...base, due_on: null }) === null);
  t("a document needs its reference", validateManualEntry({ ...base, document_ref: "" }) != null);
  t(
    "a payment does not",
    validateManualEntry({ ...base, kind: "payment", document_ref: null, due_on: null }) === null,
  );
  t("every entry needs a date", validateManualEntry({ ...base, issued_on: null }) != null);
  t("and a currency", validateManualEntry({ ...base, currency: " " }) != null);

  // The series pattern warns and never blocks: a typo caught here is a wrong statement
  // avoided, a block here is a right statement prevented.
  const docs = [
    { ref: "USI-US26-00002", issued: "2026-06-10" },
    { ref: "USI-US26-00047", issued: "2026-07-30" },
  ];
  t("the series is read off the booking", seriesPrefix(docs) === "USI-US26-");
  t("a matching reference says nothing", refWarning("USI-US26-00063", docs) === null);
  t("case does not matter", refWarning("usi-us26-00063", docs) === null);
  t(
    "an off-series reference warns",
    (refWarning("NABI-FR26-00063", docs) ?? "").includes("USI-US26-"),
  );
  t("with no documents there is nothing to compare", refWarning("anything", []) === null);
  t("and an empty reference warns about nothing", refWarning("", docs) === null);
}

// ── Who is allowed in, and whose name goes on the line ──────────────────────
// These figures end up on a document sent to a client, so the same check that guards the
// booking has to guard them; and the audit trail is the only reason a hand-typed stand-in is
// acceptable at all, so `created_by` has to come from the session rather than from a field
// the browser can set.
console.log("\n[the gate on every entry point]");
{
  const src = readFileSync(new URL("./manual-entries.functions.ts", import.meta.url), "utf8")
    // Comments promise; code does. Count only the code.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const endpoints = (src.match(/createServerFn\(/g) ?? []).length;
  const gates = (src.match(/requireTracker\("na"\)/g) ?? []).length;
  t("there are five entry points", endpoints === 5, String(endpoints));
  t("and every one asks for the tracker", gates === endpoints, `${gates} of ${endpoints}`);
  t("none of them settle for a session", !/requireSession\(\)/.test(src));

  // The insert names the session, and nothing in the request can reach that column.
  t(
    "the row is stamped with the session's email",
    /created_by\s*\)[\s\S]*session\.email/.test(src),
  );
  t("and the browser cannot name an author", !/created_by:\s*(input|data)\b/.test(src));
  const accepted = (src.match(/type Input = \{[\s\S]*?\n\};/) ?? [""])[0];
  t("the shape it accepts has no author field", accepted !== "" && !/created_by/.test(accepted));
  // An UPDATE that set it would let a second editor take the first one's name off the line.
  const update = (src.match(/UPDATE manual_statement_entries SET[\s\S]*?WHERE/) ?? [""])[0];
  t("and an edit never rewrites it", update !== "" && !/created_by/.test(update));

  // A stale tab must not be able to store what the form refuses.
  t("the server re-runs the same validation", /validateManualEntry\(clean\)/.test(src));
  t("and re-applies the sign", /signedAmount\(kind, clean\.amount!\)/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
