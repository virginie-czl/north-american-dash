/**
 * Statement of account — its figures, and every word it says.
 *
 * This is the document's content, decided in one place and drawn in another
 * (`statement-pdf.ts`). What lives here is the part that has to be right: the
 * totals, which documents are netted off the listing, and the voice — a
 * statement that is settled must not ask to be paid, a client who overpaid is
 * not in arrears, and a supplier is owed rather than billed.
 *
 * Pure: a typed object in, figures and strings out. Nothing here knows about
 * the DOM, the tracker, or where the figures came from.
 */

export type StatementLineType = "invoice" | "credit_note";

export type StatementLine = {
  ref: string;
  type: StatementLineType;
  /** Overrides the word in the Type column — "Commission", "Adjustment". */
  chip?: string | null;
  /**
   * The invoice this line belongs with: its own reference, or the reference of
   * the invoice it cancels. A parent and its credit notes share a group.
   */
  group?: string | null;
  /** ISO or already-formatted; printed as given. */
  issued?: string | null;
  due?: string | null;
  /** Signed: a credit note is negative. */
  amount: number;
};

export type StatementReceipt = {
  paidOn: string;
  method?: string | null;
  reference?: string | null;
  amount: number;
};

export type StatementOfAccount = {
  billedTo: string;
  event: string;
  bookingRef: string;
  billingEntity: string;
  currency: string;
  /** The date the statement itself was drawn up. */
  issuedOn: string;
  dueOn?: string | null;
  lines: StatementLine[];
  payments: StatementReceipt[];
  /**
   * What was received, when the individual receipts are not in the tracker. The
   * payments table then says so rather than implying nothing was paid.
   */
  receivedTotal?: number | null;
  /** Who the money is paid to, and the reference to quote — the closing bar. */
  payee?: string | null;
  paymentReference?: string | null;
  /**
   * Anything deliberately left off the listing, said plainly in the footnote. A
   * document that quietly omits a line is worse than a longer one.
   */
  omissions?: string[];
  /** Reverses the voice: what we owe a supplier rather than what a client owes. */
  side?: "client" | "supplier";
  /**
   * Who to write to about this statement. The event manager, by name, rather
   * than a shared finance inbox: they ran the event, they know what each line
   * is, and a question that lands with them gets answered instead of forwarded.
   * Falls back to finance@naboo.app when no one is on the booking.
   */
  contactEmail?: string;
  contactName?: string | null;
};

/** `210,606.84`. A true minus sign, never a hyphen, on a negative figure. */
export function money(value: number): string {
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
  return value < 0 ? `−${formatted}` : formatted;
}

/**
 * Drop the documents that cancel each other out.
 *
 * An invoice and the credit notes that void it in full tell the reader nothing:
 * the group nets to zero and only makes the statement longer and harder to tie
 * to the balance. Every total is computed over all the lines, so hiding a
 * zero-sum group cannot move a figure — which is what makes it safe.
 *
 * Two rules, in order:
 *
 * 1. **By the link.** A credit note names the invoice it cancels, so a parent
 *    and its children form a group; if the group sums to zero, all of it goes.
 *    A *partially* cancelled invoice stays, children and all — the reduction is
 *    something the reader needs to see.
 * 2. **By the amount**, for lines with no link: one credit note against one
 *    invoice of the same amount. Conservative on purpose; a partial credit note
 *    never cancels anything.
 */
export function netOffCancellingLines(lines: StatementLine[]): {
  lines: StatementLine[];
  netted: number;
  /** How many documents were left off, so the note can say. */
  omitted: number;
} {
  const remaining = new Set(lines);
  let netted = 0;
  let omitted = 0;

  // 1. Groups, as the back office draws them.
  const groups = new Map<string, StatementLine[]>();
  for (const line of lines) {
    const key = line.group ?? line.ref;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const total = members.reduce((sum, l) => sum + l.amount, 0);
    if (Math.abs(total) > 0.005) continue;
    for (const member of members) remaining.delete(member);
    netted += 1;
    omitted += members.length;
  }

  // 2. Unlinked one-for-one pairs. "Unlinked" means nothing else shares its
  //    group — a document the data does not tie to any other.
  const alone = (line: StatementLine) => (groups.get(line.group ?? line.ref)?.length ?? 1) === 1;
  const credits = [...remaining]
    .filter((l) => l.amount < -0.005 && alone(l))
    .sort((a, b) => a.amount - b.amount);
  for (const credit of credits) {
    if (!remaining.has(credit)) continue;
    const match = [...remaining].find(
      (l) =>
        l !== credit && alone(l) && l.amount > 0.005 && Math.abs(l.amount + credit.amount) < 0.005,
    );
    if (!match) continue;
    remaining.delete(credit);
    remaining.delete(match);
    netted += 1;
    omitted += 2;
  }

  return { lines: lines.filter((l) => remaining.has(l)), netted, omitted };
}

export type StatementTotals = {
  invoiced: number;
  received: number;
  balance: number;
};

/**
 * The totals come from every line, netted or not — cancelling pairs sum to zero,
 * so hiding them cannot move a total.
 */
export function statementTotals(data: StatementOfAccount): StatementTotals {
  const invoiced = data.lines.reduce((total, l) => total + l.amount, 0);
  const received =
    data.payments.length > 0
      ? data.payments.reduce((total, p) => total + p.amount, 0)
      : (data.receivedTotal ?? 0);
  return {
    invoiced: round(invoiced),
    received: round(received),
    balance: round(invoiced - received),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A summary tile: a label, a figure, a caption, and sometimes a due date. */
export type StatementTile = {
  label: string;
  figure: string;
  caption: string;
  pill?: string | null;
};

/**
 * Every word on the document, and the netted listing it goes with.
 *
 * Labels are given in sentence case; the renderer is what puts the uppercase
 * ones in uppercase, because that is a typographic decision and not a change of
 * wording.
 */
export type StatementVoice = {
  /** The listing, with fully cancelling groups netted off. */
  lines: StatementLine[];
  netted: number;
  omitted: number;
  totals: StatementTotals;
  /** True when the balance is zero — the document must not ask to be paid. */
  settled: boolean;
  /** Money owed back: to us by a supplier, or to a client who overpaid. */
  recovering: boolean;
  credit: boolean;
  contact: string;
  headerMeta: string;
  footerLeft: string;
  footerRight: string;
  title: string;
  /** The four cells of the meta strip, in order. */
  meta: Array<[string, string]>;
  tiles: [StatementTile, StatementTile, StatementTile];
  documents: {
    title: string;
    qualifier: string;
    empty: string;
    totalLabel: string;
    totalFigure: string;
  };
  receipts: {
    title: string;
    qualifier: string;
    empty: string;
    totalLabel: string;
    totalFigure: string;
  };
  closing: { label: string; sub: string; figure: string; currency: string };
  footnote: string;
};

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export function statementVoice(data: StatementOfAccount): StatementVoice {
  const totals = statementTotals(data);
  const { lines, netted, omitted } = netOffCancellingLines(data.lines);
  const supplier = data.side === "supplier";
  const contact = data.contactEmail?.trim() || "finance@naboo.app";
  // Named, when we know the name: "write to Emily" beats "write to an address".
  const contactLine = data.contactName?.trim()
    ? `${data.contactName.trim()} — ${contact}`
    : contact;

  const settled = Math.abs(totals.balance) < 0.005;
  // Money going the other way: a supplier we overpaid, or a client who paid us
  // more than we billed. Either way it is not a "balance due".
  const recovering = supplier && totals.balance < -0.005;
  const credit = !supplier && totals.balance < -0.005;

  // A settled statement must not ask to be paid: no due date, no payee, no
  // "balance due" over a zero.
  const balanceLabel = settled
    ? "Nothing outstanding"
    : credit
      ? "Credit balance"
      : supplier
        ? recovering
          ? "Balance to recover"
          : "Balance to pay"
        : "Balance due";
  // The direction is in the label, so the figure is written without its sign —
  // "Balance to recover −15,600.00" reads as a double negative.
  const balanceFigure = money(recovering || credit ? Math.abs(totals.balance) : totals.balance);

  const invoicedLabel = supplier ? "Total payable" : "Total invoiced";
  const receivedLabel = supplier ? "Total paid" : "Total received";
  const reference = data.paymentReference ?? data.bookingRef;

  const closingSub = settled
    ? `Settled in full · reference ${reference}`
    : credit
      ? `To be refunded by ${data.billingEntity} · reference ${reference}`
      : [
          data.payee
            ? recovering
              ? `To be refunded by ${data.payee}`
              : `Payable to ${data.payee}`
            : null,
          data.dueOn ? `due ${data.dueOn}` : null,
          data.paymentReference ? `reference ${data.paymentReference}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  const footnote = [
    `Generated on ${data.issuedOn}.`,
    netted > 0
      ? `${omitted} ${plural(omitted, "document")} that cancel each other in full — ${netted} ${plural(
          netted,
          "group",
        )} — ${omitted === 1 ? "is" : "are"} netted off and not listed; the totals are unchanged.`
      : "",
    ...(data.omissions ?? []),
    `Questions on any line: ${contactLine}.`,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    lines,
    netted,
    omitted,
    totals,
    settled,
    recovering,
    credit,
    contact,
    headerMeta: [`Booking ${data.bookingRef}`, `issued ${data.issuedOn}`, data.currency].join(
      " · ",
    ),
    footerLeft: `${data.billingEntity} · ${contact}`,
    footerRight: `Statement ${data.bookingRef} · ${data.issuedOn}`,
    title: "Statement of account",
    meta: [
      [supplier ? "Payable to" : "Billed to", data.billedTo],
      ["Event", data.event],
      ["Booking", data.bookingRef],
      ["Billing entity", data.billingEntity],
    ],
    tiles: [
      {
        label: invoicedLabel,
        figure: money(totals.invoiced),
        caption: `${lines.length} ${plural(lines.length, "line")} · ${data.currency}`,
      },
      {
        label: receivedLabel,
        figure: money(totals.received),
        caption:
          data.payments.length > 0
            ? `${data.payments.length} ${plural(data.payments.length, "payment")}`
            : "Recorded as a total",
      },
      {
        label: balanceLabel,
        figure: balanceFigure,
        caption: settled
          ? "Settled in full"
          : credit
            ? "Paid beyond what we invoiced"
            : `In ${data.currency}`,
        // A due date only means anything when something is actually due.
        pill: !settled && !credit && !recovering && data.dueOn ? `Due ${data.dueOn}` : null,
      },
    ],
    documents: {
      title: supplier ? "Amounts payable" : "Invoices and credit notes",
      qualifier: `All amounts inclusive of tax, in ${data.currency}`,
      empty: "Nothing issued on this booking yet.",
      totalLabel: invoicedLabel,
      totalFigure: money(totals.invoiced),
    },
    receipts: {
      title: supplier ? "Payments made" : "Payments received",
      qualifier:
        data.payments.length > 0
          ? "Applied in date order"
          : "Recorded as a total in the tracker; individual receipts are not itemised",
      empty:
        totals.received > 0.005
          ? "Receipts are held as a total, not line by line."
          : "No payment recorded yet.",
      totalLabel: receivedLabel,
      totalFigure: money(totals.received),
    },
    closing: {
      label: balanceLabel,
      sub: closingSub,
      figure: balanceFigure,
      currency: data.currency.toUpperCase(),
    },
    footnote,
  };
}
