/**
 * The brand faces the statement embeds.
 *
 * They are bundled with the app rather than fetched from Google Fonts: a
 * statement is a document that leaves the company and gets opened months later,
 * and a PDF has to carry its own type. Latin subsets, five faces, 240 KB in
 * total, fetched once per session and cached.
 */
import type { StatementFonts } from "./statement-pdf";

import display600 from "@/assets/fonts/bricolage-grotesque-600.ttf?url";
import display700 from "@/assets/fonts/bricolage-grotesque-700.ttf?url";
import display800 from "@/assets/fonts/bricolage-grotesque-800.ttf?url";
import body400 from "@/assets/fonts/roboto-400.ttf?url";
import body500 from "@/assets/fonts/roboto-500.ttf?url";

let cached: Promise<StatementFonts> | null = null;

async function load(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the statement's fonts (${res.status})`);
  return res.arrayBuffer();
}

/** Loaded on the first download and kept for the rest of the session. */
export function statementFonts(): Promise<StatementFonts> {
  cached ??= Promise.all([
    load(display600),
    load(display700),
    load(display800),
    load(body400),
    load(body500),
  ]).then(([d600, d700, d800, b400, b500]) => ({
    display600: d600,
    display700: d700,
    display800: d800,
    body400: b400,
    body500: b500,
  }));
  return cached;
}
