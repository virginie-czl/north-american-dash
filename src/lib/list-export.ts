/**
 * "Download this list" — the rows of an action list, exactly as they read on
 * screen.
 *
 * The point of this export is that the file and the screen agree: the same
 * sentence, the same evidence, the same two figures. Anything that needs the
 * underlying ledger has the per-event exports instead.
 */

export type ExportableRow = {
  lead: string;
  strong: string;
  tail: string;
  ref: string;
  meta: string;
  state: string | null;
  a: string;
  b: string;
  trail: string;
};

function escape(value: string): string {
  if (/[",\n;]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function listCsv(rows: ExportableRow[], columns: [string, string, string]): string {
  const lines = [
    ["Action", "Reference", "Detail", "State", ...columns].map(escape).join(","),
    ...rows.map((r) =>
      [`${r.lead} ${r.strong} ${r.tail}`.trim(), r.ref, r.meta, r.state ?? "", r.a, r.b, r.trail]
        .map(escape)
        .join(","),
    ),
  ];
  // A BOM, so Excel opens the accented names as UTF-8.
  return `\uFEFF${lines.join("\n")}`;
}

/** `pay-partners-2026-08-18.csv` */
export function listFileName(name: string, today: string): string {
  return `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}-${today}.csv`;
}
