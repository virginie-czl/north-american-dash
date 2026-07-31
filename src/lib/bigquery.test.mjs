import {
  collectQueryPages,
  MAX_RESULT_PAGES,
  RESULT_PAGE_SIZE,
  QUERY_TIMEOUT_MS,
} from "./bigquery.server.ts";

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

const SCHEMA = {
  fields: [
    { name: "readable_id", type: "STRING" },
    { name: "gmv", type: "FLOAT64" },
  ],
};
const row = (id, gmv) => ({ f: [{ v: id }, { v: String(gmv) }] });

async function expectThrow(name, fn, match) {
  try {
    await fn();
    t(name, false, "did not throw");
  } catch (error) {
    const message = String(error?.message ?? error);
    t(name, match.test(message), message);
  }
}

console.log("\n[collectQueryPages — every page is read]");
{
  // What jobs.query actually returns when a result outgrows one page: rows, a
  // pageToken, and a totalRows that is larger than the page.
  const first = {
    jobComplete: true,
    schema: SCHEMA,
    rows: [row("C-A001", 100), row("C-A002", 200)],
    pageToken: "token-2",
    totalRows: "4",
    jobReference: { jobId: "job-1", location: "EU" },
  };
  const second = {
    jobComplete: true,
    schema: SCHEMA,
    rows: [row("C-A003", 300), row("C-A004", 400)],
    totalRows: "4",
  };
  const asked = [];
  const rows = await collectQueryPages(first, async (token) => {
    asked.push(token);
    return second;
  });
  t("both pages come back", rows.length === 4, rows.length);
  t(
    "in order",
    rows.map((r) => r.readable_id).join(",") === "C-A001,C-A002,C-A003,C-A004",
    rows.map((r) => r.readable_id).join(","),
  );
  t("the page token is followed exactly once", asked.join(",") === "token-2", asked.join(","));
  t(
    "values are still converted by schema type",
    rows[3].gmv === 400 && typeof rows[3].gmv === "number",
  );
}
{
  const single = { jobComplete: true, schema: SCHEMA, rows: [row("C-A001", 1)], totalRows: "1" };
  let called = false;
  const rows = await collectQueryPages(single, async () => {
    called = true;
    return {};
  });
  t("a single page asks for nothing more", rows.length === 1 && called === false);
}
{
  // Three pages, to prove the loop is a loop and not one extra fetch.
  const pages = {
    t2: { jobComplete: true, rows: [row("b", 2)], pageToken: "t3", totalRows: "3" },
    t3: { jobComplete: true, rows: [row("c", 3)], totalRows: "3" },
  };
  const rows = await collectQueryPages(
    { jobComplete: true, schema: SCHEMA, rows: [row("a", 1)], pageToken: "t2", totalRows: "3" },
    async (token) => pages[token],
  );
  t("three pages", rows.map((r) => r.readable_id).join("") === "abc");
  t("later pages inherit the first page's schema", rows[2].gmv === 3);
}

console.log("\n[collectQueryPages — a short result is an error, never a result]");
await expectThrow(
  "a totalRows mismatch throws with both counts",
  () =>
    collectQueryPages(
      { jobComplete: true, schema: SCHEMA, rows: [row("C-A001", 1)], totalRows: "265" },
      async () => ({}),
    ),
  /returned 1 of 265 rows — result was truncated/,
);
await expectThrow(
  "the message names the real numbers",
  () =>
    collectQueryPages(
      {
        jobComplete: true,
        schema: SCHEMA,
        rows: Array.from({ length: 180 }, (_, i) => row(`C-${i}`, i)),
        totalRows: "265",
      },
      async () => ({}),
    ),
  /returned 180 of 265 rows/,
);
{
  // The count agreeing is the whole point: it must not throw when it does.
  const rows = await collectQueryPages(
    { jobComplete: true, schema: SCHEMA, rows: [row("a", 1), row("b", 2)], totalRows: "2" },
    async () => ({}),
  );
  t("a complete result does not throw", rows.length === 2);
}
{
  const rows = await collectQueryPages(
    { jobComplete: true, schema: SCHEMA, rows: [row("a", 1)] },
    async () => ({}),
  );
  t("no totalRows at all is not treated as a mismatch", rows.length === 1);
}
{
  const rows = await collectQueryPages(
    { jobComplete: true, schema: SCHEMA, rows: [], totalRows: "0" },
    async () => ({}),
  );
  t("an empty result is a legitimate answer", rows.length === 0);
}

console.log("\n[collectQueryPages — guards]");
await expectThrow(
  "an incomplete job throws rather than reading as empty",
  () => collectQueryPages({ jobComplete: false, schema: SCHEMA }, async () => ({})),
  /did not complete in time/,
);
await expectThrow(
  "a job that goes incomplete mid-walk throws too",
  () =>
    collectQueryPages(
      { jobComplete: true, schema: SCHEMA, rows: [row("a", 1)], pageToken: "t2", totalRows: "2" },
      async () => ({ jobComplete: false }),
    ),
  /did not complete in time/,
);
await expectThrow(
  "a runaway pager hits the cap and throws",
  () =>
    collectQueryPages(
      {
        jobComplete: true,
        schema: SCHEMA,
        rows: [row("a", 1)],
        pageToken: "t",
        totalRows: "999999",
      },
      async () => ({ jobComplete: true, rows: [row("a", 1)], pageToken: "t", totalRows: "999999" }),
      3,
    ),
  /spans more than 3 pages/,
);
{
  let calls = 0;
  try {
    await collectQueryPages(
      { jobComplete: true, schema: SCHEMA, rows: [row("a", 1)], pageToken: "t", totalRows: "99" },
      async () => {
        calls += 1;
        return { jobComplete: true, rows: [row("a", 1)], pageToken: "t", totalRows: "99" };
      },
      4,
    );
  } catch {
    /* expected */
  }
  t("the cap bounds the number of fetches", calls === 3, calls);
}

console.log("\n[settings]");
t("a page size is set explicitly", RESULT_PAGE_SIZE > 0);
t("the page cap is bounded", MAX_RESULT_PAGES === 20);
t("the query timeout is well past BigQuery's 10 s default", QUERY_TIMEOUT_MS >= 60_000);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
