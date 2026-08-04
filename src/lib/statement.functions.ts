/**
 * The client statement of account for one booking, built at the moment of
 * download.
 *
 * Never served from the query cache. Every other tracker query can afford a
 * five-minute-old figure because it is read by someone who knows the data moves;
 * this one leaves the building addressed to a client, so it is computed fresh from
 * BigQuery on every request and dated with the day it was generated.
 *
 * The two filters below are the ones that decide whether the balance is right:
 *
 *  - `NABI-%` only. `NABCO-*` are commission notes addressed to the providers,
 *    carrying the FEE_OWNER lines. They would add documents the client never
 *    received and inflate the total invoiced.
 *  - A cancelled invoice and the note reversing it, both or neither. Filtering on
 *    `status = 'ISSUED'` keeps the credit note and drops the invoice it reversed,
 *    subtracting an amount that was never added — that read −113,215.94 on C-V176
 *    against a back office 49,830.47. On C-P222 it would read 8,131.71 instead of
 *    23,332.39. Dropping the pair together has neither effect and spares the reader
 *    two lines that only undo each other: see notCancelledSql.
 *  - `COMPANY_PAYMENT` inflows only. `HOST_PAYMENT` inflows are refunds coming
 *    back from providers — on C-P222, three lines worth 213,472 USD. Counting them
 *    as client money turns a 23,332.39 receivable into a six-figure credit.
 */
import { clientInvoiceSql, notCancelledSql } from "./invoice-series";

/**
 * Markup and stylesheet, which the endpoint hands to Chromium and returns as a PDF.
 *
 * Still HTML at this level on purpose: the design was authored for a browser, and
 * keeping the document as markup is what lets the renderer be the same engine it was
 * drawn in. See pdf.server.ts for the two engines this replaced.
 */
export type NaStatementDocument = {
  readable_id: string;
  /** The document's own name, which the endpoint puts in Content-Disposition. */
  filename: string;
  /** The `<title>`, so the PDF carries one too. */
  title: string;
  /** The document's markup — a `.naboo-doc` element, ready to inject. */
  body_html: string;
  /** Its stylesheet, served with it so the page and the print match. */
  css: string;
  /** ISO day the document was generated, for the caller's own display. */
  generated_on: string;
};

const QUERY = `
-- Grouped on the booking ref, not aggregated bare: an aggregate with no GROUP BY
-- returns one all-NULL row for a booking that does not exist, and the statement
-- would render a page of em dashes instead of failing.
--
-- No bk_market filter. This view's own market classification disagrees with the
-- tracker's for real bookings — C-P222, the booking every figure here was verified
-- against, is recorded as 'UK' while it is managed out of North America. Access is
-- gated by requireTracker('na'), and the ref comes from the booking on screen.
WITH ev AS (
  SELECT
    e.client_request_readable_id                  AS rid,
    ANY_VALUE(e.clientRequestId)                  AS crid,
    ANY_VALUE(e.company_name)                     AS company_name,
    ANY_VALUE(e.event_name)                       AS event_name,
    ANY_VALUE(CAST(e.start_date AS STRING))       AS start_date,
    ANY_VALUE(CAST(e.end_date AS STRING))         AS end_date,
    ANY_VALUE(e.billing_entity)                   AS billing_entity,
    ANY_VALUE(e.em_referent)                      AS em_referent
  FROM \`naboo-app-365515.finance_gld_fct_prd.fct_export_events_scd1\` e
  WHERE e.client_request_readable_id = @ref
  GROUP BY rid
),
-- Client invoices and credit notes: every income document except the commission notes.
-- The exclusion is by series rather than by prefix whitelist — see invoice-series.ts.
-- Filtering on NABI-% was the French entity's series and nobody else's, so a booking
-- billed from NABOO US Inc. (C-U332, 148,056 USD invoiced) found nothing at all and
-- printed a statement saying zero invoices.
--
-- A cancelled invoice and the note cancelling it are dropped as a pair — notCancelledSql
-- for why that cannot move the balance. 533 bookings carry one, and on the statement they
-- were two lines whose only content was that they undid each other.
docs AS (
  SELECT
    ARRAY_AGG(STRUCT(
      i.invoiceNumber AS ref,
      i.invoiceKind   AS kind,
      i.status        AS status,
      i.currency      AS currency,
      CAST(ROUND(i.totals.totalamountincludingtaxes.amount / 100, 2) AS FLOAT64) AS amount,
      CAST(DATE(i.issueDate) AS STRING) AS issued,
      CAST(DATE(i.dueDate)   AS STRING) AS due
    ) ORDER BY i.issueDate, i.invoiceNumber) AS items,
    -- The entity the invoices were addressed to, from the most recent one: it is
    -- the name the client's own accounts payable will be looking for.
    ARRAY_AGG(NULLIF(i.buyer.legalName, '') IGNORE NULLS
              ORDER BY i.issueDate DESC LIMIT 1)[SAFE_OFFSET(0)] AS billed_to,
    ARRAY_AGG(NULLIF(i.seller.legalName, '') IGNORE NULLS
              ORDER BY i.issueDate DESC LIMIT 1)[SAFE_OFFSET(0)] AS seller_name
  FROM \`naboo-app-365515.raw_naboo_data.invoices\` i
  WHERE i.clientRequestReadableId = @ref
    AND i.invoiceDirection = 'INCOME'
    AND ${clientInvoiceSql("i")}
    AND ${notCancelledSql("i")}
),
-- How fresh the warehouse is for the series this booking is billed in.
--
-- The last issue date across the whole series, not this booking's own documents: the
-- question the statement's footnote answers is "how far has the sync got", and one booking
-- may have had nothing issued for weeks while the entity has. Derived from the data rather
-- than from the clock, because the clock always says today and that is exactly the claim
-- that was wrong.
sync AS (
  SELECT MAX(CAST(DATE(i.issueDate) AS STRING)) AS synced_up_to
  FROM \`naboo-app-365515.raw_naboo_data.invoices\` i
  WHERE i.invoiceDirection = 'INCOME'
    AND ${clientInvoiceSql("i")}
    AND REGEXP_EXTRACT(i.invoiceNumber, r'^([A-Za-z]+-[A-Za-z]{2}\\d{2})-') = (
      SELECT REGEXP_EXTRACT(ANY_VALUE(j.invoiceNumber), r'^([A-Za-z]+-[A-Za-z]{2}\\d{2})-')
      FROM \`naboo-app-365515.raw_naboo_data.invoices\` j
      WHERE j.clientRequestReadableId = @ref
        AND j.invoiceDirection = 'INCOME'
        AND ${clientInvoiceSql("j")}
    )
),
-- Client money in. COMPANY_PAYMENT inflows only.
pays AS (
  SELECT
    ARRAY_AGG(STRUCT(
      CAST(ROUND(p.amount / 10000, 2) AS FLOAT64) AS amount,
      p.currency AS currency,
      CAST(DATE(p.date) AS STRING) AS paid_on,
      p.provider_payload_label AS label
    ) ORDER BY p.date) AS items
  FROM \`naboo-app-365515.raw_naboo_data.payments\` p
  JOIN ev ON p.client_request_id = ev.crid
  WHERE p.deleted = FALSE
    AND p.flow = 'INFLOW_PAYMENT'
    AND p.kind = 'COMPANY_PAYMENT'
)
SELECT
  ev.company_name, ev.event_name, ev.start_date, ev.end_date, ev.billing_entity, ev.em_referent,
  docs.billed_to, docs.seller_name, sync.synced_up_to,
  TO_JSON_STRING(IFNULL(docs.items, CAST([] AS ARRAY<STRUCT<
    ref STRING, kind STRING, status STRING, currency STRING, amount FLOAT64,
    issued STRING, due STRING
  >>))) AS documents_json,
  TO_JSON_STRING(IFNULL(pays.items, CAST([] AS ARRAY<STRUCT<
    amount FLOAT64, currency STRING, paid_on STRING, label STRING
  >>))) AS payments_json
FROM ev CROSS JOIN docs CROSS JOIN pays CROSS JOIN sync
`;

type DocRow = {
  ref: string | null;
  kind: string | null;
  status: string | null;
  currency: string | null;
  amount: number | null;
  issued: string | null;
  due: string | null;
};

type PayRow = {
  amount: number | null;
  currency: string | null;
  paid_on: string | null;
  label: string | null;
};

function parseJsonArray<T>(json: unknown): T[] {
  if (typeof json !== "string" || !json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * Builds the statement for one booking.
 *
 * Called only by GET /api/statement/{ref}, which applies the tracker gate before any
 * of this runs — the access check belongs at the endpoint, in front of the work, and
 * this is deliberately not exported as a server function so there is one way in.
 */
export async function buildNaStatement(readableId: string): Promise<NaStatementDocument> {
  {
    const data = { readable_id: readableId.trim().toUpperCase() };
    // Interpolation-free anyway (the query is parameterised), but a booking ref has
    // one shape and anything else is a mistake worth naming.
    if (!/^[A-Z]-[A-Z0-9]{2,12}$/.test(data.readable_id)) {
      throw new Error("Invalid booking reference");
    }

    const { runBigQuery } = await import("./bigquery.server");
    const rows = (await runBigQuery(QUERY, { ref: data.readable_id })) as unknown as Array<
      Record<string, string | number | null>
    >;
    const row = rows[0];
    if (!row) throw new Error(`No North American booking found for ${data.readable_id}`);

    const {
      buildStatementHtml,
      statementFilename,
      paymentMethodFromLabel,
      paymentReferenceFromLabel,
      eventLabel,
      generationDay,
      printTitle,
      DOCUMENT_CSS,
    } = await import("./statement");
    const { emContact } = await import("./em-email");

    const generatedOn = generationDay(new Date());
    // How far the warehouse has caught up, from the data itself. Null when the booking has
    // no document to read a series off — the footnote then says only what it can.
    const syncedUpTo = row.synced_up_to == null ? null : String(row.synced_up_to).slice(0, 10);

    const documents = parseJsonArray<DocRow>(row.documents_json)
      .filter((d) => d.ref && d.currency && d.amount != null)
      .map((d) => ({
        ref: String(d.ref),
        kind: d.kind === "CREDIT_NOTE" ? ("CREDIT_NOTE" as const) : ("INVOICE" as const),
        status: d.status ?? null,
        currency: String(d.currency),
        amount: Number(d.amount),
        issued: d.issued ?? null,
        due: d.due ?? null,
      }));

    const payments = parseJsonArray<PayRow>(row.payments_json)
      .filter((p) => p.amount != null && p.currency)
      .map((p) => ({
        paid_on: p.paid_on ?? null,
        amount: Number(p.amount),
        currency: String(p.currency),
        method: paymentMethodFromLabel(p.label),
        reference: paymentReferenceFromLabel(p.label),
      }));

    const contact = emContact(row.em_referent == null ? null : String(row.em_referent));
    const ref = data.readable_id;

    // The hand-typed stand-ins, and the cleanup of the ones the warehouse has caught up
    // with. Deliberately here, in the request that assembles the statement: the delete is
    // a side effect of using the document, needs no scheduled job, and is idempotent
    // because a second generation finds nothing left to remove.
    const { readManualEntries, deleteSuperseded } = await import("./manual-entries.functions");
    const { reconcile } = await import("./manual-entries");
    const entries = await readManualEntries(ref);
    const merged = reconcile({ documents, payments, entries });
    if (merged.supersededIds.length > 0) await deleteSuperseded(merged.supersededIds);

    const html = buildStatementHtml(
      {
        booking: {
          readable_id: ref,
          billed_to: String(row.billed_to ?? row.company_name ?? "—"),
          event: eventLabel(
            ref,
            row.event_name == null ? null : String(row.event_name),
            row.start_date == null ? null : String(row.start_date),
            row.end_date == null ? null : String(row.end_date),
          ),
          billing_entity: String(row.seller_name ?? row.billing_entity ?? "Naboo Group"),
          em_referent: row.em_referent == null ? null : String(row.em_referent),
        },
        documents: merged.documents,
        payments: merged.payments,
        generatedOn,
        syncedUpTo,
      },
      { contact: { email: contact.email, name: contact.name } },
    );

    return {
      readable_id: ref,
      filename: statementFilename(ref, generatedOn),
      title: printTitle(statementFilename(ref, generatedOn)),
      body_html: html,
      css: DOCUMENT_CSS,
      generated_on: generatedOn,
    };
  }
}
