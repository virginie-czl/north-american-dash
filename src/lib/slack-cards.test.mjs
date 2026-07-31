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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
