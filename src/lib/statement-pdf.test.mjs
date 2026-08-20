import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { renderStatementPdf } from "./statement-pdf.ts";

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

/** The same five faces the app bundles. */
const face = (name) => {
  const file = readFileSync(new URL(`../assets/fonts/${name}.ttf`, import.meta.url));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
};
const fonts = {
  display600: face("bricolage-grotesque-600"),
  display700: face("bricolage-grotesque-700"),
  display800: face("bricolage-grotesque-800"),
  body400: face("roboto-400"),
  body500: face("roboto-500"),
};

const line = (n) => ({
  ref: `USI-US26-${String(n).padStart(5, "0")}`,
  type: "invoice",
  issued: "6 August 2026",
  due: "13 August 2026",
  amount: 1000 + n,
});

const seed = {
  billedTo: "Bland AI",
  event: "Offsite · 10–13 August 2026",
  bookingRef: "C-U332",
  billingEntity: "Naboo Inc",
  currency: "USD",
  issuedOn: "20 August 2026",
  dueOn: "13 August 2026",
  lines: [line(1), line(2), { ref: "USI-US26-00083", type: "credit_note", amount: -777.32 }],
  payments: [
    { paidOn: "12 August 2026", method: "Bank transfer", reference: "USI-US26-00002", amount: 900 },
  ],
  receivedTotal: 900,
  payee: "Naboo Inc",
  paymentReference: "C-U332",
};

/** Read the file back the way a PDF reader would. */
const read = async (bytes) => {
  const doc = await PDFDocument.load(bytes);
  const { width, height } = doc.getPage(0).getSize();
  return { pages: doc.getPageCount(), title: doc.getTitle(), width, height };
};

const bytes = await renderStatementPdf(seed, fonts);
const raw = Buffer.from(bytes).toString("latin1");
const one = await read(bytes);

t("it is a PDF", raw.startsWith("%PDF-") && raw.trimEnd().endsWith("%%EOF"));
t("one statement of this size is one page", one.pages === 1, String(one.pages));
t("the page is US Letter", one.width === 612 && one.height === 792);
t(
  "the brand faces travel with the document",
  (raw.match(/\/FontFile2/g) ?? []).length === 5,
  String((raw.match(/\/FontFile2/g) ?? []).length),
);
t(
  "the file names itself, so a reader's tab and a mail attachment read right",
  one.title === "Statement of account · C-U332",
  String(one.title),
);
t("a statement stays small enough to email", bytes.length < 200_000, `${bytes.length} bytes`);

// Sixty documents cannot fit on one page, and the pages that follow have to
// carry the running header and footer with them.
const long = await renderStatementPdf(
  { ...seed, lines: Array.from({ length: 60 }, (_, i) => line(i + 1)) },
  fonts,
);
const longPages = (await read(long)).pages;
t("a long statement breaks onto further pages", longPages >= 2, String(longPages));
t(
  "the extra pages cost a page each, not a document each",
  long.length < bytes.length * 2,
  `${bytes.length} → ${long.length} bytes`,
);

// An empty statement is a real case — a booking with nothing issued yet — and it
// must still be a document rather than a crash.
const nothing = await renderStatementPdf(
  { ...seed, lines: [], payments: [], receivedTotal: 0, dueOn: null },
  fonts,
);
t("a statement with nothing on it still renders", (await read(nothing)).pages === 1);

// Glyphs the latin subsets do not carry must not take the document down with
// them: the line is drawn without them.
const exotic = await renderStatementPdf(
  { ...seed, billedTo: "Bland AI → 株式会社", event: "Offsite ✓" },
  fonts,
);
t("an unencodable glyph does not fail the render", Buffer.from(exotic).length > 10_000);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
