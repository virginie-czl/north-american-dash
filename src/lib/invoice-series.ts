/**
 * Which invoice series a document belongs to — the client's, or a provider's commission
 * note.
 *
 * Every billing entity issues two numbered series, and the pair always has the same shape:
 * the client's invoices end the prefix in `I`, the commission notes we raise against
 * providers end it in `CO`.
 *
 *     NABOO GROUP (FR)      NABI-FR26-00825     NABCO-FR26-00814
 *     NABOO CA Events       CAI-CA26-00159      CACO-CA26-00035
 *     NABOO US Inc.         USI-US26-00002      USCO-US26-00002
 *     NABOO Deutschland     DEI-DE26-00011      DECO-DE26-00052
 *     NABOO ESP             ESI-ES26-00018      ESCO-ES26-00019
 *     Bizmeeting            BIZI-FR26-00339     BIZCO-FR26-00184
 *
 * This exists because three queries used to test `LIKE 'NABI-%'` or `LIKE 'NABCO-%'`,
 * which is the French entity's series and nobody else's. On C-U332 — billed from NABOO US
 * Inc., invoiced 148,056 USD and credited twice — the client statement found zero
 * documents and printed a page saying so. It was not one booking: 86 of the 131 North
 * American bookings that have any invoice at all had a statement that read empty, and 35
 * had commission notes the tracker could not see.
 *
 * The rule is by number rather than by billing entity because the number is on the
 * document the counterparty holds, and it is what finance reconciles against. It is
 * corroborated by the line items: across every one of the six families, a `…CO-` document
 * carries FEE_OWNER lines and nothing else, and an `…I-` document carries SERVICE and
 * FEE_CLIENT and never FEE_OWNER. Both signals are used where a query already joins the
 * lines; where it does not, the number alone decides.
 */

/** The commission series: any prefix ending in CO — NABCO, USCO, CACO, DECO, ESCO, BIZCO. */
const COMMISSION_NUMBER = /^[A-Za-z]*CO-/;

/**
 * Is this a commission note we raised against a provider?
 *
 * These never belong on a client's statement of account: the client neither received them
 * nor owes them.
 */
export function isCommissionNote(invoiceNumber: string | null | undefined): boolean {
  return COMMISSION_NUMBER.test((invoiceNumber ?? "").trim());
}

/**
 * Is this a document the client actually received?
 *
 * Everything income-side that is not a commission note. Deliberately a negative rule: a
 * whitelist of client prefixes would have to be edited the day a seventh entity is added,
 * and the failure mode of forgetting is exactly the bug this replaces — a statement that
 * quietly reads empty. Forgetting to add a new *commission* series is the safer direction:
 * a document appears that should not, which somebody notices immediately.
 */
export function isClientInvoice(invoiceNumber: string | null | undefined): boolean {
  const number = (invoiceNumber ?? "").trim();
  return number.length > 0 && !isCommissionNote(number);
}

/** The same rule as SQL, for the queries. `alias` is the invoices table's alias. */
export function commissionNoteSql(alias: string): string {
  return `REGEXP_CONTAINS(${alias}.invoiceNumber, r'^[A-Za-z]*CO-')`;
}

/** The same rule as SQL, negated — every income document the client received. */
export function clientInvoiceSql(alias: string): string {
  return `NOT ${commissionNoteSql(alias)}`;
}

/**
 * Documents that still stand, as SQL: a cancelled one and the credit note that cancels it
 * are both left out.
 *
 * They belong in a total and not on a page. Every figure a statement adds up has to include
 * them — the pair nets to zero and dropping only one half moves the balance by the whole
 * invoice — but a reader seeing "Invoice 03065  512.68" beside "Credit note 03067  −512.68"
 * has to work out for themselves that the two are the same non-event. On C-Q382 that is two
 * of nine lines saying nothing.
 *
 * Safe because the pairing is exact, not approximate: of the 1,989 cancelled income
 * documents in the warehouse, every one has at least one credit note pointing at it, and in
 * every case — including the 48 cancelled by more than one note — those notes sum to exactly
 * its negative. So removing both sides never moves a total by a cent. It also stops a
 * cancelled invoice sitting in the open-invoice list, where it could absorb a payment or
 * become the earliest unpaid due date behind an "overdue since" line.
 *
 * A credit note whose target is *not* cancelled stays: 114 of those exist, and each is a
 * real credit against a live invoice that the client is owed sight of.
 */
export function notCancelledSql(alias: string): string {
  return `${alias}.status != 'CANCELLED'
    AND NOT EXISTS (
      SELECT 1 FROM \`naboo-app-365515.raw_naboo_data.invoices\` cancelled_doc
      WHERE cancelled_doc.invoice_id = ${alias}.cancelledInvoiceId
        AND cancelled_doc.status = 'CANCELLED'
    )`;
}
