/**
 * Reading the recovery ledger. Every approved user sees every send: that is the
 * whole point — you cannot avoid a duplicate you cannot see.
 *
 * Only who/when/what-for is stored, never the message body, in keeping with the
 * rest of the annotation layer.
 */
import { createServerFn } from "@tanstack/react-start";
import type { RecoverySend } from "./recovery-log";

export const fetchRecoveryEmails = createServerFn({ method: "GET" }).handler(
  async (): Promise<RecoverySend[]> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { listRecoveryEmails } = await import("./recovery-log.server");
    return listRecoveryEmails();
  },
);

const REF = /^[A-Z]-[A-Z0-9]{2,12}$/;

function claim(input: { event_ref: string; recipient: string; mode: string }) {
  const event_ref = String(input?.event_ref ?? "")
    .trim()
    .toUpperCase();
  if (!REF.test(event_ref)) throw new Error("Invalid booking reference");
  const recipient = String(input?.recipient ?? "")
    .trim()
    .toLowerCase();
  if (!recipient.includes("@")) throw new Error("Give the address it was sent to.");
  const mode = String(input?.mode ?? "");
  if (!["commission", "refund", "combined", "client"].includes(mode)) {
    throw new Error("Unknown recovery mode");
  }
  return { event_ref, recipient, mode };
}

/**
 * Records a chase that went out from somewhere else.
 *
 * Same claim, same lock, same table as a send made from here — the ledger's job is to
 * answer "has anyone written to this counterparty about this booking", and an email
 * sent from a personal mailbox counts. What differs is the word it is stored under:
 * `by_hand` is set, and every label reads "Marked sent" rather than "Sent".
 *
 * Who is taken from the session, never from the browser: this is the record colleagues
 * rely on to decide not to send, so its author has to be the person who clicked. Gated
 * like the send itself — an approved session — because the two do the same thing to the
 * same ledger and gating the honest one harder would only push people to the other.
 */
export const markRecoverySent = createServerFn({ method: "POST" })
  .validator(
    (input: {
      event_ref: string;
      recipient: string;
      mode: string;
      recipient_name?: string | null;
    }) => ({
      ...claim(input),
      recipient_name: (String(input?.recipient_name ?? "").trim() || null)?.slice(0, 200) ?? null,
    }),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; existing: RecoverySend | null }> => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { claimRecoveryEmail } = await import("./recovery-log.server");
    const result = await claimRecoveryEmail({
      ...data,
      recipient_name: data.recipient_name,
      sent_by: session.email,
      sent_by_name: session.name ?? null,
      by_hand: true,
    });
    // Losing the race is not an error here: somebody else already answered the
    // question this was about to answer, and the caller shows their row instead.
    return result.ok ? { ok: true, existing: null } : { ok: false, existing: result.existing };
  });

/** Takes a hand-recorded mark back off. Never touches a send this app actually made. */
export const unmarkRecoverySent = createServerFn({ method: "POST" })
  .validator((input: { event_ref: string; recipient: string; mode: string }) => claim(input))
  .handler(async ({ data }): Promise<{ removed: boolean }> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { unmarkRecoveryByHand } = await import("./recovery-log.server");
    return unmarkRecoveryByHand(data);
  });
