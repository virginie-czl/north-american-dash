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
