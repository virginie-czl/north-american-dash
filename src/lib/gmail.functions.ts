/**
 * Gmail server functions exposed to the tracker UI.
 *
 * Every call resolves the mailbox from the caller's own session — a user can only
 * ever reach their own Gmail, never a colleague's, even though the tracker itself
 * is shared.
 */
import { createServerFn } from "@tanstack/react-start";

export type PartnerEmailStatus = {
  address: string;
  subject: string;
  lastAt: string;
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
  /** True when their most recent message is newer than ours. */
  replied: boolean;
  link: string;
};

export const lookupPartnerEmails = createServerFn({ method: "GET" })
  .validator((input: { addresses: string[] }) => {
    if (!Array.isArray(input?.addresses)) throw new Error("addresses is required");
    const addresses = input.addresses
      .filter((a): a is string => typeof a === "string" && a.includes("@"))
      .slice(0, 12);
    return { addresses };
  })
  .handler(async ({ data }): Promise<PartnerEmailStatus[]> => {
    if (data.addresses.length === 0) return [];
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { findContactThreads } = await import("./gmail.server");
    const threads = await findContactThreads(session.email, data.addresses);
    return threads.map((t) => ({
      address: t.address,
      subject: t.subject,
      lastAt: t.lastAt,
      lastOutboundAt: t.lastOutboundAt,
      lastInboundAt: t.lastInboundAt,
      replied:
        t.lastInboundAt != null &&
        (t.lastOutboundAt == null || t.lastInboundAt > t.lastOutboundAt),
      link: t.link,
    }));
  });

function validateMessage(input: { to: string; subject: string; body: string }) {
  const to = typeof input?.to === "string" ? input.to.trim() : "";
  const subject = typeof input?.subject === "string" ? input.subject.trim() : "";
  const body = typeof input?.body === "string" ? input.body.trim() : "";
  if (!to.includes("@")) throw new Error("A valid recipient address is required");
  if (!subject) throw new Error("A subject is required");
  if (!body) throw new Error("A message body is required");
  if (body.length > 20_000) throw new Error("Message is too long");
  // One recipient per call: no accidental bulk sends from a finance tool.
  if (/[,;]/.test(to)) throw new Error("Send to one recipient at a time");
  return { to, subject, body };
}

export const draftPartnerEmail = createServerFn({ method: "POST" })
  .validator(validateMessage)
  .handler(async ({ data }): Promise<{ draftId: string; link: string }> => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { createDraft } = await import("./gmail.server");
    return createDraft(session.email, data.to, data.subject, data.body);
  });

export const sendPartnerEmail = createServerFn({ method: "POST" })
  .validator(validateMessage)
  .handler(async ({ data }): Promise<{ messageId: string; threadId: string }> => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { sendMessage } = await import("./gmail.server");
    return sendMessage(session.email, data.to, data.subject, data.body);
  });
