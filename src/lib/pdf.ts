/**
 * A minimal PDF writer — enough to hand someone a statement.
 *
 * A statement leaves the company: it goes to a supplier or to a client, gets
 * printed, gets filed. That makes it a document, not a spreadsheet export, so
 * this writes real PDFs rather than CSV.
 *
 * Dependency-free, like the zip writer next to it, and for the same reason: the
 * output is a page of text and two tables, which is a couple of hundred lines of
 * PDF syntax, against a library to keep in step with forever.
 *
 * Two deliberate constraints keep it honest:
 *
 * - **The 14 standard fonts only** (Helvetica, Helvetica-Bold, Courier). No font
 *   embedding, so no glyph widths to carry around — and every reader has them.
 * - **Figures are set in Courier**, whose glyphs are all 600/1000 em wide. That
 *   is what makes right-aligned columns exact without a width table, and it is
 *   also how the design sets figures anyway.
 *
 * Streams are left uncompressed: a statement is a few kilobytes either way, and
 * it means the text can be read straight out of the file — by a person
 * debugging, and by the tests.
 */

/** A4, in points. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 64;

/** Courier is 600/1000 em wide per glyph, whatever the glyph. */
const MONO_RATIO = 0.6;
/** Helvetica averages near this; only used to wrap prose, never to align. */
const SANS_RATIO = 0.5;

export type Font = "regular" | "bold" | "mono";

export type Cell = {
  text: string;
  /** Fraction of the content width. The row's cells should add up to 1. */
  width: number;
  align?: "left" | "right";
  font?: Font;
  size?: number;
  muted?: boolean;
};

export type Block =
  | { kind: "title"; text: string }
  | { kind: "subtitle"; text: string }
  /** A small uppercase section label. */
  | { kind: "label"; text: string }
  /** Label on the left, value right-aligned in mono — the statement's spine. */
  | { kind: "kv"; label: string; value: string; strong?: boolean; alert?: boolean }
  | { kind: "row"; cells: Cell[]; header?: boolean }
  | { kind: "rule"; strong?: boolean }
  | { kind: "space"; height: number }
  /** Wrapped prose. */
  | { kind: "note"; text: string };

const INK = [0.08, 0.06, 0.05] as const;
/** The design's single alert tone — spent only on money we are owed back. */
const ALERT = [0.64, 0.16, 0.11] as const;
const MUTED = [0.43, 0.4, 0.36] as const;
const LABEL = [0.54, 0.51, 0.46] as const;
const RULE = [0.86, 0.84, 0.8] as const;
const RULE_STRONG = [0.72, 0.69, 0.64] as const;

/**
 * WinAnsi is Latin-1 plus a handful of typographic characters in 0x80–0x9F.
 * Those are exactly the ones our copy uses — curly quotes, dashes, the euro —
 * so they are mapped rather than dropped.
 */
const WIN_ANSI_EXTRA: Record<string, number> = {
  "€": 0x80,
  "‚": 0x82,
  ƒ: 0x83,
  "„": 0x84,
  "…": 0x85,
  "†": 0x86,
  "‡": 0x87,
  ˆ: 0x88,
  "‰": 0x89,
  Š: 0x8a,
  "‹": 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "˜": 0x98,
  "™": 0x99,
  š: 0x9a,
  "›": 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
};

/**
 * Characters our copy uses that WinAnsi has no room for. Dropping them to "?"
 * would put a typo in front of a supplier, so they degrade to something that
 * still reads.
 */
const TRANSLITERATE: Record<string, string> = {
  "→": "-",
  "⟶": "-",
  "⇒": "=>",
  "↵": "",
  "✓": "ok",
  "✗": "x",
  "≥": ">=",
  "≤": "<=",
  "×": "x",
  "≈": "~",
  "⌘": "Cmd",
};

/** One byte per character, escaped for a PDF string literal. */
function pdfString(text: string): string {
  let out = "";
  const source = [...text].map((ch) => (ch in TRANSLITERATE ? TRANSLITERATE[ch] : ch)).join("");
  for (const ch of source) {
    const code = WIN_ANSI_EXTRA[ch] ?? ch.codePointAt(0) ?? 63;
    // Anything still outside WinAnsi becomes "?" rather than a mangled byte.
    const byte = code <= 0xff ? code : 63;
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 32 || byte > 126) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return out;
}

function fontRef(font: Font): string {
  return font === "bold" ? "/F2" : font === "mono" ? "/F3" : "/F1";
}

function ratio(font: Font): number {
  return font === "mono" ? MONO_RATIO : SANS_RATIO;
}

/** Wrap prose to the content width. Approximate by design — it is prose. */
function wrap(text: string, size: number, width: number): string[] {
  const max = Math.max(Math.floor(width / (size * SANS_RATIO)), 8);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") line = word;
    else if (`${line} ${word}`.length <= max) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

class Page {
  ops: string[] = [];

  text(x: number, y: number, value: string, font: Font, size: number, color: readonly number[]) {
    this.ops.push(
      `BT ${color[0]} ${color[1]} ${color[2]} rg ${fontRef(font)} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(value)}) Tj ET`,
    );
  }

  /** Right-aligned text. Exact for mono, close enough for a label. */
  textRight(
    right: number,
    y: number,
    value: string,
    font: Font,
    size: number,
    color: readonly number[],
  ) {
    const width = value.length * size * ratio(font);
    this.text(right - width, y, value, font, size, color);
  }

  rule(y: number, from: number, to: number, color: readonly number[]) {
    this.ops.push(
      `${color[0]} ${color[1]} ${color[2]} RG 0.7 w ${from.toFixed(2)} ${y.toFixed(2)} m ${to.toFixed(2)} ${y.toFixed(2)} l S`,
    );
  }
}

const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const RIGHT = PAGE_WIDTH - MARGIN_X;

/**
 * Lay the blocks out down the page, breaking to a new one when the space runs
 * out. Returns the finished PDF.
 */
export function buildPdf(blocks: Block[], footer?: string): Uint8Array<ArrayBuffer> {
  const pages: Page[] = [];
  let page = new Page();
  pages.push(page);
  let y = PAGE_HEIGHT - MARGIN_TOP;

  const room = (needed: number) => {
    if (y - needed >= MARGIN_BOTTOM) return;
    page = new Page();
    pages.push(page);
    y = PAGE_HEIGHT - MARGIN_TOP;
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "title":
        room(30);
        page.text(MARGIN_X, y - 20, block.text, "bold", 19, INK);
        y -= 30;
        break;
      case "subtitle":
        room(20);
        page.text(MARGIN_X, y - 12, block.text, "regular", 11.5, MUTED);
        y -= 20;
        break;
      case "label":
        room(20);
        page.text(MARGIN_X, y - 11, block.text.toUpperCase(), "bold", 8, LABEL);
        y -= 18;
        break;
      case "kv": {
        room(18);
        const size = block.strong ? 11 : 10;
        const color = block.alert ? ALERT : INK;
        page.text(MARGIN_X, y - 11, block.label, "regular", size, color);
        page.textRight(RIGHT, y - 11, block.value, "mono", size, color);
        y -= 17;
        break;
      }
      case "row": {
        room(18);
        let x = MARGIN_X;
        for (const cell of block.cells) {
          const width = CONTENT_WIDTH * cell.width;
          const size = cell.size ?? (block.header ? 8 : 9.5);
          const font: Font = cell.font ?? (block.header ? "bold" : "regular");
          const color = block.header ? LABEL : cell.muted ? MUTED : INK;
          const value = block.header ? cell.text.toUpperCase() : cell.text;
          if (cell.align === "right") page.textRight(x + width, y - 11, value, font, size, color);
          else page.text(x, y - 11, value, font, size, color);
          x += width;
        }
        y -= block.header ? 15 : 16;
        break;
      }
      case "rule":
        room(8);
        page.rule(y - 4, MARGIN_X, RIGHT, block.strong ? RULE_STRONG : RULE);
        y -= 10;
        break;
      case "space":
        room(block.height);
        y -= block.height;
        break;
      case "note": {
        const lines = wrap(block.text, 9.5, CONTENT_WIDTH);
        room(lines.length * 13);
        for (const line of lines) {
          page.text(MARGIN_X, y - 10, line, "regular", 9.5, MUTED);
          y -= 13;
        }
        break;
      }
    }
  }

  if (footer) {
    for (const p of pages) {
      p.rule(MARGIN_BOTTOM + 18, MARGIN_X, RIGHT, RULE);
      p.text(MARGIN_X, MARGIN_BOTTOM, footer, "regular", 8, LABEL);
      if (pages.length > 1) {
        p.textRight(
          RIGHT,
          MARGIN_BOTTOM,
          `${pages.indexOf(p) + 1} / ${pages.length}`,
          "mono",
          8,
          LABEL,
        );
      }
    }
  }

  return serialise(pages);
}

function serialise(pages: Page[]): Uint8Array<ArrayBuffer> {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // 1-based object number
  };

  // Reserve 1 for the catalog and 2 for the page tree, so the kids can be named
  // before their parent exists.
  const catalog = add("");
  const tree = add("");
  const fonts = [
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"),
  ];
  const resources = `<< /Font << /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R /F3 ${fonts[2]} 0 R >> >>`;

  const kids: number[] = [];
  for (const page of pages) {
    const stream = page.ops.join("\n");
    const contents = add(
      `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`,
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources ${resources} /Contents ${contents} 0 R >>`,
      ),
    );
  }

  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(bytes(out));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = bytes(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const encoded = new TextEncoder().encode(out);
  const buffer = new Uint8Array(new ArrayBuffer(encoded.length));
  buffer.set(encoded);
  return buffer;
}
