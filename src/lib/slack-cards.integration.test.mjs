/**
 * The mirror write, against a real Postgres.
 *
 * Two defects have now shipped in these fifteen lines: a double-encoded payload
 * (jsonb_to_recordset on a non-array) and a batch with repeated keys against a
 * single-row-per-provider primary key (ON CONFLICT DO UPDATE cannot affect row a second
 * time). Neither is visible to a type checker, and both take seconds to catch by running
 * the real reducer and the real insert against a realistic batch — which is what this
 * does. It drives the exported production functions, not a copy of them.
 *
 * Needs a database. Set DATABASE_URL to a throwaway Postgres and it runs; without one it
 * skips, so it never fails a machine that has no server:
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5432/scratch \
 *     node --experimental-strip-types src/lib/slack-cards.integration.test.mjs
 */
import { aggregateApprovals } from "./slack-cards.server.ts";
import { mirrorRows, writeMirror } from "./slack-cards.functions.ts";

if (!process.env.DATABASE_URL) {
  console.log("  – skipped: set DATABASE_URL to a throwaway Postgres to run this");
  process.exit(0);
}

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

const { db } = await import("./db.server.ts");
const sql = await db();
await sql`TRUNCATE slack_card_approvals`;

// A batch shaped like the channel: 559 approvals over 287 providers, most with several.
const approvals = [];
for (let p = 0; p < 287; p++) {
  const code = `O-A${String(p).padStart(4, "0")}`;
  const times = p < 200 ? 2 : 1; // 200 × 2 + 87 = 487
  for (let i = 0; i < times; i++) {
    approvals.push({
      ownerCode: code,
      eventRef: `C-B${String(p)}${i}`,
      amount: "$1,000.00",
      approvedBy: i === 0 ? "Shayma Ndiaye" : "Virginie Czl",
      at: `2026-0${(i % 7) + 1}-1${i % 9}T09:00:00.000Z`,
    });
  }
}
// A handful with many, and one with none of the usual metadata.
for (let i = 0; i < 70; i++) {
  approvals.push({
    ownerCode: "O-BUSY1",
    eventRef: `C-C${i}`,
    amount: null,
    approvedBy: "Shayma Ndiaye",
    at: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
  });
}
approvals.push({ ownerCode: "O-NODATE", eventRef: null, amount: null, approvedBy: null, at: "" });

console.log("\n[the reducer]");
{
  const providers = aggregateApprovals(approvals);
  t("many approvals collapse onto few providers", providers.length === 289, providers.length);
  t(
    "the batch is much larger than the mirror",
    approvals.length === 558 && approvals.length > providers.length,
    approvals.length,
  );
  const busy = providers.find((p) => p.ownerCode === "O-BUSY1");
  t("a provider's approvals are counted, not overwritten", busy.count === 70, busy?.count);
  t("earliest first", busy.firstAt.startsWith("2026-07-01"), busy.firstAt);
  t("latest last", busy.lastAt.startsWith("2026-07-28"), busy.lastAt);
  const undated = providers.find((p) => p.ownerCode === "O-NODATE");
  t("an approval with no date still counts", undated.count === 1 && undated.lastAt === null);
  // The whole reason the write failed: one row per provider, keys unique.
  const codes = providers.map((p) => p.ownerCode);
  t("keys are unique", new Set(codes).size === codes.length);
}

console.log("\n[the write]");
{
  const rows = mirrorRows(approvals);
  const written = await writeMirror(rows);
  const stored = await sql`SELECT COUNT(*)::int AS n FROM slack_card_approvals`;
  t("the insert succeeds on a batch with repeated owner codes upstream", written === rows.length);
  t("one row per provider landed", stored[0].n === rows.length, stored[0].n);
  t("far fewer rows than approvals", stored[0].n < approvals.length);

  const busy = await sql`
    SELECT approval_count, approved_at, first_approved_at, approved_by, event_ref
    FROM slack_card_approvals WHERE owner_code = 'O-BUSY1'`;
  t("the count is stored", busy[0].approval_count === 70, busy[0].approval_count);
  t(
    "the dates bracket the run",
    busy[0].first_approved_at.toISOString().startsWith("2026-07-01") &&
      busy[0].approved_at.toISOString().startsWith("2026-07-28"),
  );
  t("the approver comes from the most recent approval", busy[0].approved_by === "Shayma Ndiaye");
}

console.log("\n[running it twice — an upsert that only works on an empty table is not one]");
{
  const before = (await sql`SELECT COUNT(*)::int AS n FROM slack_card_approvals`)[0].n;
  await writeMirror(mirrorRows(approvals));
  const after = await sql`SELECT COUNT(*)::int AS n FROM slack_card_approvals`;
  t("the second run succeeds", after[0].n === before, `${before} → ${after[0].n}`);

  // And a changed batch updates in place rather than adding.
  const grown = [
    ...approvals,
    {
      ownerCode: "O-BUSY1",
      eventRef: "C-LATEST",
      amount: null,
      approvedBy: "Gaspard De Surville",
      at: "2027-01-15T08:00:00.000Z",
    },
  ];
  await writeMirror(mirrorRows(grown));
  const busy = await sql`
    SELECT approval_count, approved_at, approved_by, event_ref
    FROM slack_card_approvals WHERE owner_code = 'O-BUSY1'`;
  const count = (await sql`SELECT COUNT(*)::int AS n FROM slack_card_approvals`)[0].n;
  t(
    "a new approval raises the count in place",
    busy[0].approval_count === 71,
    busy[0].approval_count,
  );
  t(
    "and moves the latest approver and booking",
    busy[0].approved_by === "Gaspard De Surville" && busy[0].event_ref === "C-LATEST",
  );
  t("without adding a row", count === before, `${before} → ${count}`);
}

console.log("\n[the guard]");
{
  const dupes = [...mirrorRows(approvals.slice(0, 2)), ...mirrorRows(approvals.slice(0, 2))];
  let message = "";
  try {
    await writeMirror(dupes);
  } catch (error) {
    message = String(error.message);
  }
  // Named here rather than surfacing as a Postgres 21000 three layers down.
  t(
    "a batch with duplicate keys is refused by name",
    /duplicate owner codes/.test(message),
    message,
  );
}

console.log("\n[the mirror's age]");
{
  const age = await sql`
    SELECT EXTRACT(EPOCH FROM (now() - MAX(synced_at)))::int AS age FROM slack_card_approvals`;
  t("synced just now", age[0].age != null && age[0].age < 60, age[0].age);
}

await sql.end();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
