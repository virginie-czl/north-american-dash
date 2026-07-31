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
