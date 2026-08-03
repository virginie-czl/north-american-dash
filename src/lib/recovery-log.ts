/**
 * The shared ledger of recovery emails already sent — pure part.
 *
 * A recovery ask is a conversation with one counterparty about one booking, and
 * it can only be opened once: a second email from a colleague who could not see
 * the first reads as disorganised at best, and as two people chasing the same
 * money at worst. Everything that decides "has this already gone out?" lives
 * here so the button, the dialog row and the server-side lock agree on it.
 */

/** What the email asks for. */
export type RecoveryMode = "commission" | "refund" | "combined" | "client";

/**
 * Which side of the marketplace the ask belongs to, and the unit the lock works
 * in. A provider's commission, an overpayment refund and the combined ask are one
 * conversation with that provider: whichever went out first is the one that
 * counts, so they share a scope.
 */
export type RecoveryScope = "client" | "partner";

export function recoveryScopeOf(mode: RecoveryMode | string): RecoveryScope {
  return mode === "client" ? "client" : "partner";
}

export type RecoverySend = {
  event_ref: string;
  /** Lowercased address, so the key never depends on how it was typed. */
  recipient: string;
  scope: RecoveryScope;
  mode: string;
  recipient_name: string | null;
  subject: string | null;
  sent_at: string;
  sent_by: string;
  sent_by_name: string | null;
};

/** Ledger key: one booking, one recipient, one side of the marketplace. */
export function recoveryKey(
  eventRef: string,
  address: string,
  modeOrScope: RecoveryMode | RecoveryScope | string,
): string {
  return `${eventRef}::${address.trim().toLowerCase()}::${recoveryScopeOf(modeOrScope)}`;
}

export function recoveryIndex(rows: RecoverySend[]): Map<string, RecoverySend> {
  const map = new Map<string, RecoverySend>();
  for (const r of rows) map.set(recoveryKey(r.event_ref, r.recipient, r.scope), r);
  return map;
}

/**
 * How far a booking's chase has got.
 *
 * `targets` is how many counterparties on the booking have a claim worth an email;
 * `sent` is how many of them have had one. A booking is only chased when every one of
 * them has: two providers owing a commission and one email sent still leaves an email
 * to write, and writing it is our move, not theirs.
 */
export type ChaseProgress = {
  targets: number;
  sent: number;
  /** ISO timestamp of the most recent send, for the label. */
  lastSentAt: string | null;
};

/**
 * Chase progress per booking, from the plans and the shared ledger.
 *
 * Fed the same plans the buttons and the dialog work from, so a booking cannot be
 * labelled "chased" while a button still offers to chase it — the two disagreeing is
 * how somebody sends a second copy.
 */
export function chaseProgress(
  plans: Array<{ eventRef: string; address: string; mode: RecoveryMode | RecoveryScope | string }>,
  ledger: Map<string, RecoverySend> | null | undefined,
): Map<string, ChaseProgress> {
  const byEvent = new Map<string, ChaseProgress>();
  for (const plan of plans) {
    const entry = byEvent.get(plan.eventRef) ?? { targets: 0, sent: 0, lastSentAt: null };
    entry.targets += 1;
    const send = ledger?.get(recoveryKey(plan.eventRef, plan.address, plan.mode));
    if (send) {
      entry.sent += 1;
      if (entry.lastSentAt == null || send.sent_at > entry.lastSentAt) {
        entry.lastSentAt = send.sent_at;
      }
    }
    byEvent.set(plan.eventRef, entry);
  }
  return byEvent;
}

/** Every counterparty with a claim on this booking has been written to. */
export function fullyChased(progress: ChaseProgress | null | undefined): boolean {
  return progress != null && progress.targets > 0 && progress.sent >= progress.targets;
}

/** `Chased 03/08/26` — the pill on a booking whose email has gone out. */
export function chasedLabel(progress: ChaseProgress): string {
  if (!progress.lastSentAt) return "Chased";
  return `Chased ${sentDay(progress.lastSentAt)}`;
}

/** Who sent it, as short as it can be said without becoming ambiguous. */
export function recoverySender(send: RecoverySend): string {
  const name = send.sent_by_name?.trim();
  if (name) return name;
  const local = send.sent_by.split("@")[0] ?? send.sent_by;
  return local || send.sent_by;
}

export function sentDay(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10);
  try {
    return new Date(t).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

export function recoverySentDay(send: RecoverySend): string {
  return sentDay(send.sent_at);
}

/** The label a disabled button carries once the email has gone out. */
export function recoverySentLabel(send: RecoverySend): string {
  return `Sent on ${recoverySentDay(send)} by ${recoverySender(send)}`;
}
