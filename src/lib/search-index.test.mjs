import { haystack, matching, overflowNote } from "./search-index.ts";

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

/** A tracker's rows, of the kind that used to fall out of the search. */
const rows = [
  {
    ref: "CA-2411-0847",
    hay: haystack([
      "CA-2411-0847",
      "4501277318",
      "L’Oréal Canada Inc",
      "MASTER_CLASS",
      "Espace Canal",
      "compta@espacecanal.ca",
      "FA-2026-0412",
    ]),
    turnkey: true,
    ancient: false,
  },
  {
    ref: "CA-2411-0798",
    hay: haystack([
      "CA-2411-0798",
      "4501276742",
      "L’Oréal Canada Inc",
      "SEMINAR",
      "Traiteur Agnus Dei",
      null,
      "FA-2026-0489",
    ]),
    turnkey: false,
    ancient: true,
  },
  {
    ref: "NA-2411-4362",
    hay: haystack(["NA-2411-4362", "Lightspeed", "Leadership offsite", "Hôtel Nelligan"]),
    turnkey: false,
    ancient: false,
  },
];

// A list filter is what the page shows; it must not narrow what can be found.
const listed = rows.filter((r) => !r.turnkey && !r.ancient);

t("a partial reference finds its booking", matching(rows, "0847")[0]?.ref === "CA-2411-0847");
t("a partial PO finds its booking", matching(rows, "45012773")[0]?.ref === "CA-2411-0847");
t("a company finds every booking of theirs", matching(rows, "l’oréal").length === 2);
t("case does not matter", matching(rows, "LIGHTSPEED")[0]?.ref === "NA-2411-4362");
t("an accent is matched as typed", matching(rows, "nelligan")[0]?.ref === "NA-2411-4362");
t(
  "a partner name finds the booking they are on",
  matching(rows, "agnus")[0]?.ref === "CA-2411-0798",
);
t(
  "an invoice reference finds its booking",
  matching(rows, "fa-2026-0489")[0]?.ref === "CA-2411-0798",
);
t("an empty query matches nothing", matching(rows, "   ").length === 0);

// The two regressions, stated as rules.
t(
  "a booking the default filter hides is still findable",
  !listed.some((r) => r.ref === "CA-2411-0847") &&
    matching(rows, "0847")[0]?.ref === "CA-2411-0847",
);
t(
  "a booking older than the age cut-off is still findable",
  !listed.some((r) => r.ref === "CA-2411-0798") &&
    matching(rows, "0798")[0]?.ref === "CA-2411-0798",
);
t(
  "every booking the search returns can be resolved from the full set",
  matching(rows, "24").every((hit) => rows.some((r) => r.ref === hit.ref)),
);

// Truncation has to announce itself.
t("nothing is said when everything is shown", overflowNote(4, 25, "bookings") === null);
t(
  "the count left out is named",
  overflowNote(43, 25, "bookings") === "18 more bookings match — narrow the query",
  String(overflowNote(43, 25, "bookings")),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
