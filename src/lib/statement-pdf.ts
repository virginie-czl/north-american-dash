/**
 * The statement of account, drawn as a PDF.
 *
 * The only renderer: the figures and the wording come from `statementVoice`, and
 * this file decides where each of them sits. It runs in the browser — pdf-lib and
 * the five brand faces are all it needs — so the button hands over a file with no
 * server, no headless browser and no print dialog in between.
 *
 * Measurements are written in the design's own pixels and converted once, at
 * `pt`, so the numbers here read against the brief (44px padding, 13px body)
 * rather than against a printer's points.
 */
import {
  PDFDocument,
  rgb,
  setCharacterSpacing,
  type PDFFont,
  type PDFPage,
  type RGB,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import {
  money,
  statementVoice,
  type StatementLine,
  type StatementOfAccount,
} from "./statement-of-account";

/** CSS pixels to PDF points. The design is specified in px. */
const pt = (px: number) => px * 0.75;

/** US Letter, in points. */
const PAGE_W = 612;
const PAGE_H = 792;

const PAD_X = pt(44);
const HEADER_H = pt(74);
const FOOTER_H = pt(44);
const CONTENT_TOP = PAGE_H - HEADER_H - pt(26);
const CONTENT_BOTTOM = FOOTER_H + pt(16);
const CONTENT_W = PAGE_W - PAD_X * 2;
const RIGHT = PAGE_W - PAD_X;

function hex(value: string): RGB {
  const n = parseInt(value.replace("#", ""), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const NAVY = hex("#101F34");
const YELLOW = hex("#EFF779");
const YELLOW_SURFACE = hex("#FBFDE7");
const OFF_WHITE = hex("#FAFAF8");
const BORDER = hex("#E5E7EB");
const GRAY_700 = hex("#374151");
const GRAY_500 = hex("#6B7280");
const GRAY_400 = hex("#9CA3AF");
const CHIP = hex("#F3F4F6");
const GREEN = hex("#00B67A");
const RED = hex("#DC2626");
const WHITE = rgb(1, 1, 1);

/** The Naboo mark, in its own 19×32 viewBox. */
const MARK =
  "M18.3224 18.2291V31.606H12.8998V17.355C12.8998 13.4644 12.1129 11.5406 10.1011 11.5406C7.78332 11.5406 5.68484 13.9889 5.37882 19.6714V31.606H0V13.4644C2.05549 13.1585 4.02281 12.0658 5.37882 10.7539V17.6609C5.99087 13.2896 7.91521 10.5791 12.3752 10.5791C16.2669 10.5791 18.2786 13.2459 18.3224 18.2291Z";

export type StatementFonts = {
  /** Bricolage Grotesque 600 / 700 / 800 — headings and every figure. */
  display600: ArrayBuffer;
  display700: ArrayBuffer;
  display800: ArrayBuffer;
  /** Roboto 400 / 500 — body and UI. */
  body400: ArrayBuffer;
  body500: ArrayBuffer;
};

type Faces = {
  d600: PDFFont;
  d700: PDFFont;
  d800: PDFFont;
  b400: PDFFont;
  b500: PDFFont;
};

/**
 * WinAnsi is not a constraint here — the fonts are embedded — but the latin
 * subsets do not carry every glyph our copy might contain. Anything missing
 * would throw on encode, so it degrades to something legible instead.
 */
const SUBSTITUTIONS: Record<string, string> = {
  "→": "-",
  "⟶": "-",
  "✓": "ok",
  "⌘": "Cmd",
  "≈": "~",
};

function safe(text: string, font: PDFFont): string {
  const mapped = [...text].map((ch) => SUBSTITUTIONS[ch] ?? ch).join("");
  // Drop anything the face cannot encode rather than failing the whole document.
  return [...mapped]
    .filter((ch) => {
      try {
        font.widthOfTextAtSize(ch, 10);
        return true;
      } catch {
        return false;
      }
    })
    .join("");
}

class Sheet {
  page: PDFPage;
  y: number;
  readonly pages: PDFPage[] = [];

  constructor(
    private doc: PDFDocument,
    private f: Faces,
    private chrome: (page: PDFPage) => void,
  ) {
    this.page = this.newPage();
    this.y = CONTENT_TOP;
  }

  private newPage(): PDFPage {
    const page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(page);
    this.chrome(page);
    return page;
  }

  /** Make room, breaking to a new page when the block will not fit. */
  room(height: number) {
    if (this.y - height >= CONTENT_BOTTOM) return;
    this.page = this.newPage();
    this.y = CONTENT_TOP;
  }

  text(
    value: string,
    opts: {
      x?: number;
      right?: number;
      size: number;
      font: PDFFont;
      color?: RGB;
      /** Extra tracking, in px, as the design's letter-spacing. */
      tracking?: number;
    },
  ) {
    const size = pt(opts.size);
    const font = opts.font;
    const clean = safe(value, font);
    const tracking = pt(opts.tracking ?? 0);
    const width = font.widthOfTextAtSize(clean, size) + tracking * clean.length;
    const x = opts.right != null ? opts.right - width : (opts.x ?? PAD_X);
    drawTracked(this.page, clean, x, this.y, size, font, opts.color ?? NAVY, tracking);
    return width;
  }

  width(value: string, size: number, font: PDFFont, tracking = 0): number {
    const clean = safe(value, font);
    return font.widthOfTextAtSize(clean, pt(size)) + pt(tracking) * clean.length;
  }

  rule(color: RGB = BORDER, from = PAD_X, to = RIGHT) {
    this.page.drawLine({
      start: { x: from, y: this.y },
      end: { x: to, y: this.y },
      thickness: 0.75,
      color,
    });
  }

  down(px: number) {
    this.y -= pt(px);
  }
}

/**
 * `drawText` has no letter-spacing option, and the design leans on it for every
 * uppercase label. The PDF operator for it does exist, so it is pushed around
 * the run — rather than drawing a glyph at a time, which would leave the label
 * unselectable as a phrase.
 */
function drawTracked(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
  color: RGB,
  tracking: number,
) {
  if (tracking !== 0) page.pushOperators(setCharacterSpacing(tracking));
  page.drawText(text, { x, y, size, font, color });
  if (tracking !== 0) page.pushOperators(setCharacterSpacing(0));
}

/** A rounded rectangle, as an SVG path in pdf-lib's y-down path space. */
function roundedRect(w: number, h: number, r: number): string {
  return [
    `M ${r} 0`,
    `H ${w - r}`,
    `A ${r} ${r} 0 0 1 ${w} ${r}`,
    `V ${h - r}`,
    `A ${r} ${r} 0 0 1 ${w - r} ${h}`,
    `H ${r}`,
    `A ${r} ${r} 0 0 1 0 ${h - r}`,
    `V ${r}`,
    `A ${r} ${r} 0 0 1 ${r} 0`,
    "Z",
  ].join(" ");
}

export async function renderStatementPdf(
  data: StatementOfAccount,
  fonts: StatementFonts,
): Promise<Uint8Array<ArrayBuffer>> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const f: Faces = {
    // Subsetted once per face, not per run: five embedded faces carrying only
    // the glyphs this statement uses take a 250 KB bundle down to ~30 KB in the
    // file, and every label stays one selectable run.
    d600: await doc.embedFont(fonts.display600, { subset: true }),
    d700: await doc.embedFont(fonts.display700, { subset: true }),
    d800: await doc.embedFont(fonts.display800, { subset: true }),
    b400: await doc.embedFont(fonts.body400, { subset: true }),
    b500: await doc.embedFont(fonts.body500, { subset: true }),
  };

  doc.setTitle(`Statement of account · ${data.bookingRef}`);
  doc.setSubject("Statement of account");
  doc.setProducer("Naboo tracker");

  // Every word and every figure is decided in one place; this file only draws.
  const v = statementVoice(data);
  const lines = v.lines;

  /** The running header and footer, drawn on every page as it is created. */
  const chrome = (page: PDFPage) => {
    page.drawRectangle({
      x: 0,
      y: PAGE_H - HEADER_H,
      width: PAGE_W,
      height: HEADER_H,
      color: OFF_WHITE,
    });
    page.drawLine({
      start: { x: 0, y: PAGE_H - HEADER_H },
      end: { x: PAGE_W, y: PAGE_H - HEADER_H },
      thickness: 0.75,
      color: BORDER,
    });
    page.drawSvgPath(MARK, {
      x: PAD_X,
      y: PAGE_H - pt(18),
      scale: pt(25) / 32,
      color: NAVY,
      borderWidth: 0,
    });

    const kind = v.title.toUpperCase();
    const kindSize = pt(13);
    const tracking = pt(0.08 * 13);
    const kindWidth = f.b500.widthOfTextAtSize(kind, kindSize) + tracking * kind.length;
    drawTracked(page, kind, RIGHT - kindWidth, PAGE_H - pt(34), kindSize, f.b500, NAVY, tracking);

    const meta = safe(v.headerMeta, f.b400);
    page.drawText(meta, {
      x: RIGHT - f.b400.widthOfTextAtSize(meta, pt(12)),
      y: PAGE_H - pt(52),
      size: pt(12),
      font: f.b400,
      color: GRAY_500,
    });

    page.drawLine({
      start: { x: 0, y: FOOTER_H },
      end: { x: PAGE_W, y: FOOTER_H },
      thickness: 0.75,
      color: BORDER,
    });
    const left = safe(v.footerLeft, f.b400);
    page.drawText(left, { x: PAD_X, y: pt(22), size: pt(10), font: f.b400, color: GRAY_400 });
    const right = safe(v.footerRight, f.b400);
    page.drawText(right, {
      x: RIGHT - f.b400.widthOfTextAtSize(right, pt(10)),
      y: pt(22),
      size: pt(10),
      font: f.b400,
      color: GRAY_400,
    });
  };

  const s = new Sheet(doc, f, chrome);

  // ── Title ────────────────────────────────────────────────────────────────
  s.down(26);
  const titleWidth = s.text(`${v.title} `, { size: 26, font: f.d800, tracking: -0.02 * 26 });
  s.text(`· ${data.bookingRef}`, {
    x: PAD_X + titleWidth,
    size: 26,
    font: f.d600,
    color: GRAY_400,
    tracking: -0.02 * 26,
  });

  // ── Meta strip ───────────────────────────────────────────────────────────
  s.down(16);
  s.rule();
  s.down(14);
  const columns = [1.4, 1, 0.8, 1];
  const unit = (CONTENT_W - pt(24) * 3) / columns.reduce((a, b) => a + b, 0);
  let x = PAD_X;
  const startY = s.y;
  let deepest = s.y;
  v.meta.forEach(([label, value], i) => {
    const width = unit * columns[i];
    s.y = startY;
    s.text(label.toUpperCase(), { x, size: 10, font: f.b400, color: GRAY_400, tracking: 0.1 * 10 });
    s.down(17);
    // The value wraps inside its own column rather than running into the next.
    for (const line of wrap(value, 14, width, f.b500, s)) {
      s.text(line, { x, size: 14, font: f.b500 });
      s.down(17);
    }
    deepest = Math.min(deepest, s.y);
    x += width + pt(24);
  });
  s.y = deepest;
  s.down(4);
  s.rule();

  // ── Summary tiles ────────────────────────────────────────────────────────
  s.down(14);
  const tileGap = pt(10);
  const tileCols = [1, 1, 1.15];
  const tileUnit = (CONTENT_W - tileGap * 2) / tileCols.reduce((a, b) => a + b, 0);
  const tileH = pt(78);

  s.room(pt(78) + pt(10));
  const tileTop = s.y;
  x = PAD_X;
  // Left to right: what was billed, what came in, and what is left — the third
  // tile is the one the reader is looking for, so it carries the brand surface.
  v.tiles.forEach((tile, i) => {
    const tone = i === 1 ? "green" : i === 2 ? "balance" : null;
    const width = tileUnit * tileCols[i];
    s.page.drawSvgPath(roundedRect(width, tileH, pt(12)), {
      x,
      y: tileTop,
      color: tone === "balance" ? YELLOW_SURFACE : WHITE,
      borderColor: BORDER,
      borderWidth: 0.75,
    });
    s.y = tileTop - pt(13) - pt(8);
    s.text(tile.label.toUpperCase(), {
      x: x + pt(16),
      size: 10,
      font: f.b400,
      color: GRAY_400,
      tracking: 0.1 * 10,
    });
    if (tile.pill) {
      const pillW = s.width(tile.pill, 10, f.b500) + pt(18);
      s.page.drawSvgPath(roundedRect(pillW, pt(16), pt(8)), {
        x: x + width - pt(16) - pillW,
        y: s.y + pt(12),
        color: YELLOW,
        borderWidth: 0,
      });
      s.text(tile.pill, { x: x + width - pt(16) - pillW + pt(9), size: 10, font: f.b500 });
    }
    s.down(25);
    s.text(tile.figure, {
      x: x + pt(16),
      size: 23,
      font: tone === "balance" ? f.d800 : f.d700,
      color: tone === "green" ? GREEN : NAVY,
      tracking: -0.01 * 23,
    });
    s.down(14);
    s.text(tile.caption, { x: x + pt(16), size: 10, font: f.b400, color: GRAY_500 });
    x += width + tileGap;
  });
  s.y = tileTop - tileH;

  // ── Tables ───────────────────────────────────────────────────────────────
  const lineCols = [0.26, 0.16, 0.19, 0.21, 0.18];
  const lineHead = ["Reference", "Type", "Issued", "Payment due", "Amount"];
  section(s, f, v.documents.title, v.documents.qualifier);
  tableHead(s, f, lineHead, lineCols);
  if (lines.length === 0) note(s, f, v.documents.empty);
  for (const line of lines) {
    s.room(pt(24));
    // A table that breaks across pages repeats its head on the new one.
    if (s.y === CONTENT_TOP) tableHead(s, f, lineHead, lineCols);
    lineRow(s, f, line, lineCols);
  }
  totalRow(s, f, v.documents.totalLabel, v.documents.totalFigure, lineCols);

  const payCols = [0.26, 0.24, 0.3, 0.2];
  const payHead = ["Date", "Method", "Reference", "Amount"];
  section(s, f, v.receipts.title, v.receipts.qualifier);
  tableHead(s, f, payHead, payCols);
  if (data.payments.length === 0) note(s, f, v.receipts.empty);
  for (const payment of data.payments) {
    s.room(pt(24));
    if (s.y === CONTENT_TOP) tableHead(s, f, payHead, payCols);
    s.down(18);
    let cx = PAD_X;
    const cells = [
      payment.paidOn,
      payment.method ?? "—",
      payment.reference ?? "—",
      money(payment.amount),
    ];
    cells.forEach((value, i) => {
      const width = CONTENT_W * payCols[i];
      if (i === 3) {
        s.text(value, { right: cx + width, size: 13, font: f.b500 });
      } else {
        s.text(value, { x: cx, size: 13, font: f.b400, color: i === 2 ? NAVY : GRAY_700 });
      }
      cx += width;
    });
    s.down(7);
    s.rule();
  }
  totalRow(s, f, v.receipts.totalLabel, v.receipts.totalFigure, payCols);

  // ── Closing balance ──────────────────────────────────────────────────────
  const footnoteRows = wrap(v.footnote, 10, CONTENT_W, f.b400, s);

  const barH = pt(64);
  s.down(18);
  // The bar and the note under it are one block: a balance on one page and its
  // note alone on the next reads as a mistake.
  s.room(barH + pt(14) + pt(13) * footnoteRows.length);
  const barTop = s.y;
  s.page.drawSvgPath(roundedRect(CONTENT_W, barH, pt(12)), {
    x: PAD_X,
    y: barTop,
    color: YELLOW,
    borderColor: NAVY,
    borderWidth: 0.75,
  });
  s.y = barTop - pt(16) - pt(13);
  s.text(v.closing.label, { x: PAD_X + pt(22), size: 17, font: f.d700 });
  s.down(15);
  s.text(v.closing.sub, { x: PAD_X + pt(22), size: 11, font: f.b400, color: GRAY_700 });

  s.y = barTop - pt(16) - pt(22);
  s.text(v.closing.figure, {
    right: RIGHT - pt(22),
    size: 28,
    font: f.d800,
    tracking: -0.02 * 28,
  });
  s.y -= pt(14);
  s.text(v.closing.currency, {
    right: RIGHT - pt(22),
    size: 10,
    font: f.b400,
    color: GRAY_700,
    tracking: 0.1 * 10,
  });

  // ── Footnote ─────────────────────────────────────────────────────────────
  s.y = barTop - barH;
  s.down(14);
  for (const row of footnoteRows) {
    s.text(row, { size: 10, font: f.b400, color: GRAY_400 });
    s.down(13);
  }

  // Plain cross-reference table rather than object streams: it costs a kilobyte
  // on a document this size and keeps the file readable by older viewers, which
  // is the kind of thing a statement gets opened in months later.
  const bytes = await doc.save({ useObjectStreams: false, objectsPerTick: Infinity });
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

function section(s: Sheet, f: Faces, title: string, qualifier: string) {
  s.down(22);
  s.room(pt(60));
  s.text(title, { size: 17, font: f.d700 });
  s.text(qualifier, { right: RIGHT, size: 11, font: f.b400, color: GRAY_500 });
}

function tableHead(s: Sheet, f: Faces, labels: string[], cols: number[]) {
  s.down(20);
  let x = PAD_X;
  labels.forEach((text, i) => {
    const label = text.toUpperCase();
    const width = CONTENT_W * cols[i];
    if (i === labels.length - 1) {
      s.text(label, { right: x + width, size: 10, font: f.b400, color: GRAY_400, tracking: 1 });
    } else {
      s.text(label, { x, size: 10, font: f.b400, color: GRAY_400, tracking: 1 });
    }
    x += width;
  });
  s.down(6);
  s.rule(NAVY);
}

/** A table with nothing in it says so, rather than showing a bare total. */
function note(s: Sheet, f: Faces, text: string) {
  s.down(18);
  s.text(text, { size: 9.5, font: f.b400, color: GRAY_700 });
  s.down(8);
  s.rule();
}

function lineRow(s: Sheet, f: Faces, line: StatementLine, cols: number[]) {
  s.down(18);
  const negative = line.amount < 0;
  const chip = line.chip ?? (negative ? "Credit note" : null);
  let x = PAD_X;
  const values = [
    line.ref,
    chip ?? "Invoice",
    line.issued ?? "—",
    line.due ?? "—",
    money(line.amount),
  ];
  values.forEach((value, i) => {
    const width = CONTENT_W * cols[i];
    if (i === 4) {
      s.text(value, { right: x + width, size: 13, font: f.b500, color: negative ? RED : NAVY });
    } else if (i === 1 && chip) {
      const w = s.width(value, 11, f.b400) + pt(14);
      s.page.drawSvgPath(roundedRect(w, pt(15), pt(4)), {
        x,
        y: s.y + pt(11),
        color: CHIP,
        borderWidth: 0,
      });
      s.text(value, { x: x + pt(7), size: 11, font: f.b400, color: GRAY_700 });
    } else {
      s.text(value, { x, size: 13, font: f.b400, color: i === 0 ? NAVY : GRAY_700 });
    }
    x += width;
  });
  s.down(7);
  s.rule();
}

function totalRow(s: Sheet, f: Faces, label: string, figure: string, cols: number[]) {
  s.room(pt(34));
  s.down(20);
  s.text(label, { size: 11, font: f.b400, color: GRAY_400, tracking: 1.1 });
  s.text(figure, {
    right: PAD_X + CONTENT_W * cols.reduce((a, b) => a + b, 0),
    size: 16,
    font: f.d700,
  });
  // The figure sits on this baseline; the next block starts below it.
  s.down(6);
}

/** Wrap to a width, using the face's own metrics. */
function wrap(text: string, size: number, width: number, font: PDFFont, s: Sheet): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const rows: string[] = [];
  let row = "";
  for (const word of words) {
    const candidate = row ? `${row} ${word}` : word;
    if (s.width(candidate, size, font) <= width || row === "") row = candidate;
    else {
      rows.push(row);
      row = word;
    }
  }
  if (row) rows.push(row);
  return rows;
}
