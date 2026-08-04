/**
 * The event manager's mailbox, derived from their name.
 *
 * A booking records who manages it but not how to reach them, and a client
 * statement has to name someone who can answer for the figures. Naboo mailboxes
 * follow `first.last@naboo.app`, so the address is derivable — but only for a real
 * first/last pair. Everything else (a single word, a placeholder, a team label we
 * do not know) returns null so the caller can fall back to finance@ rather than
 * inventing an address that bounces off a client's reply.
 *
 * Pure and dependency-free: it is the kind of rule that is easy to get subtly
 * wrong and cheap to pin down in tests.
 */

/** Team labels that are not people. Named, never derived. */
const SHARED_MAILBOXES: Record<string, string> = {
  "support naboo": "support@naboo.app",
  "naboo support": "support@naboo.app",
  support: "support@naboo.app",
  "finance naboo": "finance@naboo.app",
  "naboo finance": "finance@naboo.app",
  finance: "finance@naboo.app",
};

/** Words that mean "nobody recorded a name". */
const PLACEHOLDERS = new Set(["", "-", "--", "n/a", "na", "none", "tbd", "tbc", "unknown", "x"]);

export const FINANCE_MAILBOX = "finance@naboo.app";

/**
 * Accents are dropped, hyphens survive.
 *
 * `Eugénie` → `eugenie`, `Anne-Marie` → `anne-marie`. Apostrophes and dots go
 * (`O'Brien` → `obrien`), because a mailbox never carries them.
 */
function slug(part: string): string {
  return part
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The address, or null when the name is not a usable first/last pair.
 *
 * The surname is every word after the first, run together with no separator:
 * `Astrid Isle de Beauchaine` → `astrid.isledebeauchaine@naboo.app`. That is how
 * the mailboxes are actually spelled, so a compound surname is not a special case
 * to detect — it falls out of the rule.
 */
export function emEmail(fullName: string | null | undefined): string | null {
  const raw = (fullName ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;

  const shared = SHARED_MAILBOXES[raw.toLowerCase()];
  if (shared) return shared;

  const words = raw.split(" ").filter((w) => !PLACEHOLDERS.has(w.toLowerCase()));
  if (words.length < 2) return null;

  const first = slug(words[0]);
  const last = words.slice(1).map(slug).filter(Boolean).join("");
  if (!first || !last) return null;

  return `${first}.${last}@naboo.app`;
}

export type EmContact = {
  /** Always an address that exists: the manager's, or finance as the fallback. */
  email: string;
  /** The person to name, when there is one. */
  name: string | null;
  /** False when the name could not be turned into a mailbox. */
  derived: boolean;
};

/** Who the statement tells the client to write to. */
export function emContact(fullName: string | null | undefined): EmContact {
  const email = emEmail(fullName);
  const name = (fullName ?? "").replace(/\s+/g, " ").trim() || null;
  if (!email) return { email: FINANCE_MAILBOX, name: null, derived: false };
  // A shared mailbox is a real address but not a person to name.
  const isShared = !!SHARED_MAILBOXES[(name ?? "").toLowerCase()];
  return { email, name: isShared ? null : name, derived: true };
}
