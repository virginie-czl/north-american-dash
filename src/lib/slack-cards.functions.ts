/**
 * Server function exposing Slack credit-card approvals to the tracker.
 *
 * Returns owner codes only — no amounts, approvers or links, since this feeds a
 * shared sticker. The channel itself remains the source of record.
 */
import { createServerFn } from "@tanstack/react-start";

export type CardApprovalSummary = {
  owner_code: string;
  event_ref: string | null;
  approved_by: string | null;
  at: string;
};

export const fetchCardApprovals = createServerFn({ method: "GET" }).handler(
  async (): Promise<CardApprovalSummary[]> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { fetchCardApprovals: read } = await import("./slack-cards.server");
    const approvals = await read();
    return approvals.map((a) => ({
      owner_code: a.ownerCode,
      event_ref: a.eventRef,
      approved_by: a.approvedBy,
      at: a.at,
    }));
  },
);
