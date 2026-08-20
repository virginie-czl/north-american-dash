/**
 * What ⌘K searches over, and the two rules it has to keep.
 *
 * 1. **Search reaches every booking**, not the filtered list. A filter is a
 *    statement about a list — "show me the ones that need paying" — and must
 *    never decide what can be found. A booking hidden by the default "hors
 *    turnkey" filter, or by "events older than 100 days", is still one search
 *    away.
 * 2. **Anything found can be opened.** Resolving the open booking out of the
 *    filtered list is what makes a search result land on nothing, so the lookup
 *    goes against the same population the search does.
 *
 * The pages build their own rows — only the matching lives here, so it can be
 * tested without a page.
 */

/** A row as the search sees it: its reference, and everything worth matching. */
export type Searchable = { ref: string; hay: string };

/** Case-folded, so a query never has to guess how a name was typed. */
export function haystack(parts: Array<string | number | null | undefined>): string {
  return parts
    .filter((p) => p != null && String(p).trim() !== "")
    .join(" ")
    .toLowerCase();
}

/**
 * Every row whose haystack contains the query, in order. Substring matching on
 * purpose: `0847` is how anyone actually remembers `CA-2411-0847`, and `4501`
 * is how they remember a PO.
 */
export function matching<T extends Searchable>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return rows.filter((row) => row.hay.includes(q));
}

/**
 * A panel that lists 25 of 43 matches has to say so, or it is lying by
 * omission — the missing ones look like they do not exist.
 */
export function overflowNote(total: number, shown: number, noun: string): string | null {
  if (total <= shown) return null;
  return `${total - shown} more ${noun} match — narrow the query`;
}
