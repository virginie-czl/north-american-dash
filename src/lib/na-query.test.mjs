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
// Pure module on purpose: na.functions.ts pulls in TanStack's server runtime, so the two
// naming rules live in na-partners.ts where they can be called directly.
import { partnerDisplayName, partnerLegalName, partnerMatches } from "./na-partners.ts";

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

// ── A booking is as many jobs as it owes ────────────────────────────────────
// Marketplace NA used to pick one move per booking by precedence, so a booking with a
// provider to pay *and* a commission to claw back showed only the claim: the payment
// vanished from "Ours to move" and the only way to find it was to open the booking.
// The three sides are collected independently now.
console.log("\n[the move list]");
{
  const page = readFileSync(
    new URL("../routes/_authenticated/tracking-north-america.tsx", import.meta.url),
    "utf8",
  );
  t("the derivation returns a list", /const movesFor = useCallback\(/.test(page));
  t("and its type says so", /recovery: NaClientRecovery\): Move\[\]/.test(page));
  t(
    "the three sides are collected, not raced",
    /\[claimMove\(\), payMove\(\), clientMove\(\)\]\.filter/.test(page),
  );
  // The claim and the payment are the pair that used to hide each other.
  t("the claim is its own collector", /const claimMove = \(\): Move \| null =>/.test(page));
  t("the payment is its own collector", /const payMove = \(\): Move \| null =>/.test(page));
  t("the client side is one question", /const clientMove = \(\): Move \| null =>/.test(page));
  // Two collectors can reach the same pill; one job should be one line.
  t("duplicate pills are collapsed", /`\$\{m\.group\}::\$\{m\.label\}`/.test(page));

  // Every chip asks the whole list, so a booking counts in each category it belongs to
  // rather than only in the one its winner happened to name.
  t("needs-a-move asks every move", /moves\.some\(\(m\) => needsAMove\(m\.group\)\)/.test(page));
  t(
    "so does the commission chip",
    /moves\.some\(\(m\) => m\.headlineLabel\.includes\("commission"\)\)/.test(page),
  );
  t(
    "and the refund chip",
    /moves\.some\(\(m\) => m\.headlineLabel\.includes\("refund to recover"\)\)/.test(page),
  );
  t(
    "and the client-refund chip",
    /moves\.some\(\(m\) => m\.headlineLabel\.includes\("client to refund"\)\)/.test(page),
  );

  // The list groups by move, so one booking can appear under two headings.
  t("the grouping walks the moves", /for \(const move of item\.moves\) \{/.test(page));
  t(
    "a booking can be listed twice in one group",
    /key=\{`\$\{ref\}::\$\{move\.label\}`\}/.test(page),
  );
  // The no-cash payment and a client balance both speak for the client; the labels
  // have to differ or the dedupe above would drop one of them.
  t("the two client labels are distinct", /label: "Client to pay first"/.test(page));
}

// ── The name a partner is shown by ──────────────────────────────────────────
// Two names per line, doing two different jobs. The house is what was booked and what a
// reader recognises; the owner's company is who invoices us and — critically — what every
// stored key is derived from, so it must survive a change of what the screen displays.
console.log("\n[house name on the screen, owner name underneath]");
{
  const line = (o = {}) => ({
    name: "Piazza Hospitality Group",
    house_name: "Hotel Healdsburg",
    email: "jason@hotelhealdsburg.com",
    owner_code: "O-B9275",
    house_code: "H-B3551",
    is_provision: false,
    ...o,
  });

  t("the house is what the card shows", partnerDisplayName(line()) === "Hotel Healdsburg");
  t("with the company underneath", partnerLegalName(line()) === "Piazza Hospitality Group");
  // Most lines have the same name twice. Repeating it under itself is noise.
  const same = line({ name: "The Matheson", house_name: "The Matheson" });
  t("a line named the same twice says it once", partnerLegalName(same) === null);
  t("and still shows it", partnerDisplayName(same) === "The Matheson");
  // Nor is a capitalisation or a suffix a second name worth printing: "Charter Up" under
  // "Charter UP" reads as a distinction the reader then goes looking for.
  t(
    "capitals alone are not a second name",
    partnerLegalName(line({ name: "Charter Up", house_name: "Charter UP" })) === null,
  );
  t(
    "nor a house that just adds the town",
    partnerLegalName(line({ name: "Valette", house_name: "Valette Healdsburg" })) === null,
  );
  t(
    "nor an accent",
    partnerLegalName(line({ name: "Hôtel Birks", house_name: "Hotel Birks" })) === null,
  );
  // But a genuinely different company still gets its line.
  t(
    "a different company is still named",
    partnerLegalName(
      line({ name: "Nitro Racing", house_name: "Nitro City Racing - Fairfield" }),
    ) === "Nitro Racing",
  );
  // No house on file: the company name is the best there is.
  const noHouse = line({ house_name: null });
  t(
    "no house falls back to the company",
    partnerDisplayName(noHouse) === "Piazza Hospitality Group",
  );
  t(
    "and then to the address",
    partnerDisplayName({ ...line(), house_name: null, name: null }) === "jason@hotelhealdsburg.com",
  );
  // The warehouse's placeholder for a provision leg is not the name of anything.
  const prov = line({
    name: "Default house used for provision quote",
    house_name: null,
    is_provision: true,
  });
  t("a provision leg is called a provision", partnerDisplayName(prov) === "Provision");
  t("and claims no company", partnerLegalName(prov) === null);

  // Two houses under one owner: the whole reason the display changed. Both lines read
  // "Nitro Racing" under the old rule, which looked like the same partner listed twice.
  const fairfield = line({ name: "Nitro Racing", house_name: "Nitro City Racing - Fairfield" });
  const rohnert = line({ name: "Nitro Racing", house_name: "Nitro City Racing - Rohnert Park" });
  t(
    "two houses of one owner are two different names",
    partnerDisplayName(fairfield) !== partnerDisplayName(rohnert),
  );

  // Search: every word has to land somewhere on the line, in any order, in any field.
  t("an empty query matches everything", partnerMatches(line(), "   "));
  t("the house is searchable", partnerMatches(line(), "healdsburg"));
  t("so is the company", partnerMatches(line(), "piazza"));
  t("and the address", partnerMatches(line(), "jason@"));
  t("and the owner code", partnerMatches(line(), "o-b9275"));
  t("and the house code", partnerMatches(line(), "h-b3551"));
  t("case does not matter", partnerMatches(line(), "HOTEL HeaLdsburg"));
  t("words can be in any order", partnerMatches(line(), "healdsburg hotel"));
  t("across both names at once", partnerMatches(line(), "piazza healdsburg"));
  t("a word that is nowhere fails the line", !partnerMatches(line(), "healdsburg brewsters"));
  t("and so does anything unrelated", !partnerMatches(line(), "matheson"));
}

console.log("\n[the query carries both names]");
{
  const src = readFileSync(new URL("./na.functions.ts", import.meta.url), "utf8");
  // The field has to exist in all three struct definitions or the COALESCE between the
  // branches is a runtime error — the parity test above enforces the order, this one
  // catches a missing branch by name.
  t("house_name is in all three struct definitions", (src.match(/house_name/g) ?? []).length >= 4);
  t("it comes from the house's own title", /NULLIF\(h\.title, ''\)/.test(src));
  // A provision leg is booked against a placeholder house, so it must not get a name.
  t(
    "and never from the provision placeholder",
    /IF\(q\.provision_name IS NULL, NULLIF\(rm\.venue_name, ''\), NULL\)/.test(src),
  );
  // Identity is unchanged: the page still keys stored facts on the owner's name.
  const page = readFileSync(
    new URL("../routes/_authenticated/tracking-north-america.tsx", import.meta.url),
    "utf8",
  );
  t(
    "stored keys still come from the owner name",
    /partnerKey\(p\.name \?\? p\.email \?\? ""\)/.test(page),
  );
  t("the card shows the display name", /\{partnerDisplayName\(p\)\}/.test(page));
  t(
    "and the search filters the list",
    /partners\.filter\(\(p\) => partnerMatches\(p, query\)\)/.test(page),
  );
  // The subtotal is not allowed to follow the filter: a total that quietly changed with a
  // search would be a wrong total presented as the truth.
  t(
    "the totals ignore the search",
    /const payableCount = partners\.filter/.test(page) && /shown\.map\(\(p, i\)/.test(page),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
