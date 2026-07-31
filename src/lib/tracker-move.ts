/**
 * The `move` model the redesign handoff asks for: one next action per
 * booking/event, its group, and the single figure that matters for it.
 *
 * Lives here rather than in a page so the list, the scope counts and the request
 * dialog cannot disagree — that is the explicit requirement in the handoff.
 *
 * Precedence, from the spec: blocked → money to recover → ours to pay or record
 * → waiting on a reply → nothing to do.
 */

export type MoveGroup = "ours" | "partner" | "client" | "waiting" | "blocked" | "done";

export type Move = {
  group: MoveGroup;
  /** Short label for the list pill, e.g. "Recover 6 532,00" or "Pay by transfer". */
  label: string;
  /** The one figure that matters, already formatted, plus its caption. */
  headline: string;
  headlineLabel: string;
};

export const GROUP_META: Record<MoveGroup, { title: string; dot: string }> = {
  ours: { title: "Ours to move", dot: "#101F34" },
  partner: { title: "Partner's move", dot: "#B45309" },
  client: { title: "Client's move", dot: "#0F766E" },
  waiting: { title: "Waiting", dot: "#9CA3AF" },
  blocked: { title: "Blocked", dot: "#DC2626" },
  done: { title: "Nothing to do", dot: "#00875A" },
};

/** Group order in the list. */
export const GROUP_ORDER: MoveGroup[] = ["ours", "partner", "client", "waiting", "blocked", "done"];

/** Pill tones, straight from the handoff's token table. */
export const MOVE_PILL: Record<MoveGroup, string> = {
  ours: "bg-[#EFF779] text-[#101F34]",
  partner: "bg-[#FFEED4] text-[#92400E]",
  client: "bg-[#E8F6F9] text-[#115E59]",
  waiting: "bg-[#F3F4F6] text-[#4B5563]",
  blocked: "bg-[#FEE2E2] text-[#991B1B]",
  done: "bg-[#E7F8F3] text-[#00593C]",
};

/** `Needs a move` = everything that is neither blocked nor done. */
export function needsAMove(group: MoveGroup): boolean {
  return group !== "blocked" && group !== "done";
}

/** `To recover` scope: the spec keys it off the move label. */
export function isRecover(move: Move): boolean {
  return move.label.startsWith("Recover");
}
