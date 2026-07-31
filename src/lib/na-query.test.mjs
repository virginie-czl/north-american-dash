/**
 * Static checks on the Marketplace NA query.
 *
 * A type error inside a SQL string compiles cleanly and fails only when someone opens
 * the page, which is how `Unrecognized name: cd` reached production: the
 * commission_doc_count field was added to both partner branches, and the join it needs
 * to only one of them. Twice now the same shape of mistake has taken the page down —
 * once as a hard SQL error, once as 147 bookings silently rendering "PARTNERS (0)"
 * because the fallback branch was missing fields the typed empty array declared.
 *
 * So two invariants are asserted here, cheaply, on every run:
 *
 *  1. Every table alias a CTE references is joined inside that same CTE.
 *  2. The two partner branches and the typed empty array they fall back to declare
 *     the same fields, in the same order.
 *
 * The query text is read off disk rather than imported: na.functions.ts pulls in
 * TanStack's server runtime, and this needs nothing but the string.
 */
import { readFileSync } from "node:fs";

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

const source = readFileSync(new URL("./na.functions.ts", import.meta.url), "utf8");
const match = /const QUERY = `([\s\S]*?)\n`;/.exec(source);
if (!match) {
  console.log("  ✗ could not find the QUERY template literal in na.functions.ts");
  process.exit(1);
}
// Unescape the template literal's own escapes: \` around table names, \\ in regexes.
const QUERY = match[1].split("\\`").join("`").split("\\\\").join("\\");

/** Comments and backticked table names hold dots that are not alias references. */
function strip(sql) {
  return sql.replace(/--[^\n]*/g, "").replace(/`[^`]*`/g, "TABLE");
}

/** Splits `WITH a AS (...), b AS (...)` into [name, body] by matching parens. */
function cteBodies(sql) {
  const out = [];
  const re = /(^|[\s,(])([a-z_][a-z0-9_]*)\s+AS\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) != null) {
    const start = m.index + m[0].length;
    // Only top-level definitions: a nested `x AS (` inside a body is a subquery.
    let depth = 1;
    let i = start;
    while (i < sql.length && depth > 0) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
      i++;
    }
    out.push({ name: m[2], body: sql.slice(start, i - 1), start, end: i });
  }
  // Drop the ones that started inside another body — those are subqueries, and their
  // aliases are visible to the CTE that contains them anyway.
  return out.filter(
    (c, idx) => !out.some((o, j) => j !== idx && o.start < c.start && o.end > c.end),
  );
}

/** Aliases a body brings into scope: FROM x y, JOIN x y, UNNEST(...) AS y, (…) y. */
function definedAliases(body) {
  const names = new Set();
  const patterns = [
    /\b(?:FROM|JOIN)\s+TABLE\s+([a-z][a-z0-9_]*)/gi,
    /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\s+([a-z][a-z0-9_]*)/gi,
    /\bUNNEST\s*\([^)]*\)\s+AS\s+([a-z][a-z0-9_]*)/gi,
    /\)\s+([a-z][a-z0-9_]*)\s*(?:\n|$|,)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(body)) != null) names.add((m[2] ?? m[1]).toLowerCase());
  }
  return names;
}

const RESERVED = new Set([
  "on",
  "as",
  "and",
  "or",
  "where",
  "group",
  "order",
  "by",
  "select",
  "left",
  "join",
  "cross",
  "inner",
  "using",
  "having",
  "when",
  "then",
  "else",
  "end",
  "distinct",
  "not",
  "null",
  "is",
  "in",
  "unnest",
  "over",
  "partition",
  "true",
  "false",
  "limit",
  "asc",
  "desc",
  "nulls",
  "last",
  "first",
]);

/**
 * Aliases a body reads from, e.g. the `cd` in `cd.doc_count`.
 *
 * The lookbehind is what keeps nested struct access out of it: in
 * `inv.totals.totalamountincludingtaxes.amount` only `inv` is an alias, and the
 * segments after it are fields.
 */
function referencedAliases(body) {
  const names = new Set();
  const re = /(?<![.\w])([a-z_][a-z0-9_]*)\.[a-z_]/gi;
  let m;
  while ((m = re.exec(body)) != null) {
    const name = m[1].toLowerCase();
    if (!RESERVED.has(name)) names.add(name);
  }
  return names;
}

const bodies = cteBodies(strip(QUERY));
const cteNames = new Set(bodies.map((c) => c.name.toLowerCase()));

console.log("\n[the query parses into CTEs]");
t("every expected CTE is found", bodies.length >= 10, `${bodies.length} CTEs`);
for (const expected of [
  "commission_docs_by_quote",
  "partners_rm_dedup",
  "partners_rm",
  "partners_fi_fallback",
  "base",
]) {
  t(`${expected} is one of them`, cteNames.has(expected));
}

// The check that would have caught `Unrecognized name: cd`: the fallback branch used
// the alias of a CTE it never joined.
console.log("\n[every alias a CTE reads is joined in that CTE]");
for (const cte of bodies) {
  const defined = definedAliases(cte.body);
  const dangling = [...referencedAliases(cte.body)].filter(
    (name) => !defined.has(name) && !cteNames.has(name),
  );
  t(`${cte.name}: no dangling alias`, dangling.length === 0, dangling.join(", "));
}

// And the other half of the same trap: a field added to one branch and not the other.
console.log("\n[the two partner branches and their empty array agree]");
{
  const structFields = (body) => {
    const start = body.indexOf("ARRAY_AGG(STRUCT(");
    if (start < 0) return null;
    let depth = 0;
    let i = body.indexOf("(", body.indexOf("STRUCT", start));
    const from = i + 1;
    do {
      if (body[i] === "(") depth++;
      else if (body[i] === ")") depth--;
      i++;
    } while (i < body.length && depth > 0);
    const inner = body.slice(from, i - 1);
    // Split on top-level commas only: plenty of the expressions carry their own.
    const parts = [];
    let level = 0,
      current = "";
    for (const ch of inner) {
      if (ch === "(" || ch === "[") level++;
      if (ch === ")" || ch === "]") level--;
      if (ch === "," && level === 0) {
        parts.push(current);
        current = "";
      } else current += ch;
    }
    parts.push(current);
    return parts
      .map((p) => {
        const aliased = /\bAS\s+([a-z_][a-z0-9_]*)\s*$/i.exec(p.trim());
        // `name, email, …` in partners_rm are bare column references.
        return (aliased ? aliased[1] : p.trim()).toLowerCase();
      })
      .filter(Boolean);
  };

  const rm = bodies.find((c) => c.name === "partners_rm");
  const fb = bodies.find((c) => c.name === "partners_fi_fallback");
  const baseBody = bodies.find((c) => c.name === "base").body;

  const rmFields = structFields(rm.body);
  const fbFields = structFields(fb.body);

  // The typed empty array both branches are COALESCEd against.
  const emptyArray = /CAST\(\[\] AS ARRAY<STRUCT<([\s\S]*?)>>\)/.exec(baseBody);
  const declared = emptyArray[1]
    .split(",")
    .map((f) => f.trim().split(/\s+/)[0].toLowerCase())
    .filter(Boolean);

  t("partners_rm declares fields", rmFields.length > 15, String(rmFields.length));
  t(
    "the fallback branch has the same fields in the same order",
    rmFields.join("|") === fbFields.join("|"),
    `\n      rm: ${rmFields.join(", ")}\n      fb: ${fbFields.join(", ")}`,
  );
  t(
    "and the typed empty array declares exactly those",
    rmFields.join("|") === declared.join("|"),
    `\n      rm:       ${rmFields.join(", ")}\n      declared: ${declared.join(", ")}`,
  );
  t("commission_doc_count is in all three", rmFields.includes("commission_doc_count"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
