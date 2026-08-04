/**
 * How a partner line is named and found — pure, so both rules are testable without the
 * server runtime na.functions.ts drags in.
 *
 * Two names per line, and the distinction is the whole point. The owner's company invoices
 * us and is what every stored key is derived from; the house is what was booked and what a
 * person reading the booking recognises. Changing which one is *displayed* must never
 * change which one is *stored*, or an email fact filed under one name stops being found
 * under the other.
 */
import type { NaPartnerLine } from "./na.functions";

/**
 * The name to show for a partner line.
 *
 * The house, then the company, then the address. What somebody scanning a booking is
 * looking for is the venue they booked, not the legal entity behind it — and where one
 * owner holds several houses ("Nitro Racing" twice) the company name makes two different
 * lines look like a duplicate, which is worse than unhelpful.
 *
 * Deliberately not used for identity: `name` remains the key everything stored is filed
 * under, so changing what is displayed cannot orphan an email fact or a sent-recovery row.
 */
export function partnerDisplayName(
  p: Pick<NaPartnerLine, "name" | "house_name" | "email" | "is_provision">,
): string {
  const house = (p.house_name ?? "").trim();
  if (house) return house;
  const name = (p.name ?? "").trim();
  // A provision leg is booked against a placeholder house, and the warehouse says so in
  // as many words. "Default house used for provision quote" is a database artefact, not
  // the name of anything, so it never reaches the screen.
  if (p.is_provision || /^default house used for provision/i.test(name)) return "Provision";
  return name || (p.email ?? "").trim() || "—";
}

/**
 * The company behind the house, when it is worth saying — null when it would only repeat
 * the line above. Shown small under the name: an invoice arrives from Piazza Hospitality
 * Group and somebody has to be able to tie it to Hotel Healdsburg without leaving the page.
 */
export function partnerLegalName(
  p: Pick<NaPartnerLine, "name" | "house_name" | "email" | "is_provision">,
): string | null {
  const name = (p.name ?? "").trim();
  if (!name) return null;
  // A provision leg invoices nobody: its name is the placeholder house, which would
  // otherwise be printed as though a company were called that.
  if (p.is_provision || /^default house used for provision/i.test(name)) return null;
  // Nothing new to say: "Charter Up" under "Charter UP", or "Valette" under "Valette
  // Healdsburg". A second line that only repeats the first in different capitals is worse
  // than blank space — it reads as a distinction the reader then has to go looking for.
  const shown = flatten(partnerDisplayName(p));
  return shown.includes(flatten(name)) ? null : name;
}

/** Case, accents and punctuation removed — for comparing two names, never for display. */
function flatten(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Every string a partner line can be found by. */
export function partnerHaystack(p: NaPartnerLine): string {
  return [p.house_name, p.name, p.email, p.owner_code, p.house_code]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Does this partner line match what somebody typed?
 *
 * Every word has to appear somewhere in the line, in any order and in any of its fields —
 * so "healdsburg valette" finds Valette Healdsburg and "hotel heald" finds the hotel. An
 * empty query matches everything, because a search box nobody has typed in is not a filter.
 */
export function partnerMatches(p: NaPartnerLine, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = partnerHaystack(p);
  return words.every((w) => hay.includes(w));
}
