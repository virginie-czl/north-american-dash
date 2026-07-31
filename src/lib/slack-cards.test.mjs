import { readFileSync } from "node:fs";
import { parseApprovals } from "./slack-cards.server.ts";

let pass = 0,
  fail = 0;
const t = (n, c, g = "") => {
  if (c) {
    pass++;
    console.log("  ✓", n);
  } else {
    fail++;
    console.log("  ✗", n, g);
  }
};

// Real message bodies from #finance-paiement-by-card
const approved = {
  ts: "1785334445.000000",
  text: `*Credit Card Request Approved* :white_check_mark:

*Approved by:* Shayma Ndiaye
*Amount:* $44,802.00
*Client Request:* C-V308
*Partner:* O-G2013
*Pliant Card ID:* 0caf4f16-fcd3-46d0-9316-899d86d74c23

<https://admin.naboo.app/credit-card-requests?tab=card-requests&creditCardRequestId=6a6a07873cf02c4ea5f2fd76|View Request>`,
};

const pending = {
  ts: "1785334000.000000",
  text: `*New Credit Card Request*

*Requestor:* Emily Osei
*Amount:* $5,953.74
*Client Request:* C-V578
*Partner:* O-G1942
*Status:* PENDING`,
};

const refused = {
  ts: "1785333900.000000",
  text: `*Credit Card Request Refused* :x:

*Refused by:* Shayma Ndiaye
*Amount:* €4,375.34
*Client Request:* C-X169
*Partner:* O-G1041`,
};

const amountRefused = {
  ts: "1785333800.000000",
  text: `*Credit Card Amount Update Refused* :x:

*Refused by:* Shayma Ndiaye
*Reverted to amount:* $10,606.37
*Client Request:* C-V114
*Partner:* O-F9350`,
};

const locked = {
  ts: "1785333700.000000",
  text: `*Cards locked for security review* :lock:

*Partner ID:* 677d3341a76db06bf5833f1e
*Reason:* Partner email changed via backoffice`,
};

const all = parseApprovals([approved, pending, refused, amountRefused, locked]);

t("only approvals are kept", all.length === 1, JSON.stringify(all.map((a) => a.ownerCode)));
t("owner code extracted", all[0]?.ownerCode === "O-G2013", all[0]?.ownerCode);
t("event ref extracted", all[0]?.eventRef === "C-V308", all[0]?.eventRef);
t("amount extracted", all[0]?.amount === "$44,802.00", all[0]?.amount);
t("approver extracted", all[0]?.approvedBy === "Shayma Ndiaye", all[0]?.approvedBy);
t("timestamp converted", all[0]?.at.startsWith("2026-"), all[0]?.at);

// The critical negatives — a refusal must never read as an approval
t("pending is not an approval", !all.some((a) => a.ownerCode === "O-G1942"));
t("refused is not an approval", !all.some((a) => a.ownerCode === "O-G1041"));
t("amount-update refusal is not an approval", !all.some((a) => a.ownerCode === "O-F9350"));
t("lock notice ignored (no O- code)", all.length === 1);

// Approvals by someone else are still approvals
const byOther = parseApprovals([
  {
    ts: "1785333600.000000",
    text: `*Credit Card Request Approved* :white_check_mark:

*Approved by:* Gaspard De Surville
*Amount:* €1,512.00
*Client Request:* C-S900
*Partner:* O-G0264
*Pliant Card ID:* a535aaf6-7e4b-4669-aecd-5d8c242f33cc`,
  },
]);
t(
  "approval by a colleague counts",
  byOther[0]?.ownerCode === "O-G0264" && byOther[0]?.approvedBy === "Gaspard De Surville",
);

// ── Where Slack may be called from, and how failures travel ─────────────────
// Three defects made the refresh button lie: the insert was double-encoded, the read
// path refreshed itself, and a try/catch turned every failure into a 200. The first is
// covered by a live Postgres check; these pin the other two in place.
console.log("\n[the mirror's plumbing]");
{
  const src = readFileSync(new URL("./slack-cards.functions.ts", import.meta.url), "utf8");
  const body = (name) => {
    const start = src.indexOf(name);
    if (start < 0) return "";
    // To the start of the next top-level declaration.
    const rest = src.slice(start);
    const end = rest.slice(1).search(/\n(?:export |async function |function |\/\*\*)/);
    return end < 0 ? rest : rest.slice(0, end + 1);
  };

  // Comments explain the old bug by name, so the checks below read code only.
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*$/gm, "");
  const code = stripComments(src);

  const refresh = body("async function refreshMirror");
  const read = body("export const fetchCardApprovals");
  const sync = body("export const syncCardApprovals");

  t(
    "only refreshMirror reaches the Slack module",
    (src.match(/slack-cards\.server/g) ?? []).length === 1,
  );
  t("and it is refreshMirror that does", /slack-cards\.server/.test(refresh));
  t("the read path never imports it", !/slack-cards\.server/.test(read));
  t("the read path never refreshes", !/refreshMirror/.test(read));
  // A refresh that cannot refresh is a failed call: the button's path must not catch.
  t("syncCardApprovals does not catch", !/\bcatch\b/.test(sync), sync);
  // The insert: no manual serialisation, no jsonb round-trip.
  t("the insert does not stringify its rows", !/JSON\.stringify/.test(stripComments(refresh)));
  t("nor go through jsonb_to_recordset", !/jsonb_to_recordset/.test(code));
  t("it uses the driver's bulk insert", /INSERT INTO slack_card_approvals \$\{sql\(/.test(refresh));
  t("and still upserts on the owner code", /ON CONFLICT \(owner_code\) DO UPDATE/.test(refresh));
  // Both failure modes are named, because the difference is the diagnosis.
  t("a Slack failure says the mirror was untouched", /The mirror was left as it was/.test(refresh));
  t("a write failure says nothing was saved", /Nothing was saved/.test(refresh));
  t(
    "both keep the original error as the cause",
    (refresh.match(/cause: error/g) ?? []).length === 2,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
