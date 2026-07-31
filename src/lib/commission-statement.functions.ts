/**
 * The commission statement for one provider on one booking, built at the moment
 * of download.
 *
 * Never from the query cache: the document goes to the provider, so it is read
 * fresh from BigQuery on every request and dated with the day it was generated.
 *
 * The joins below are what attach a commission document to a provider. Two of them
 * are easy to get wrong:
 *
 *  - `invoices.billedCompanyName` holds the *client* name on these documents even
 *    though they are addressed to the provider. The addressee comes from
 *    houses/owners, never from that column.
 *  - A commission document reaches a provider only through its FEE_OWNER line
 *    items, which carry the quote, which carries the house. There is no direct
 *    provider column on the invoice.
 *
 * Every status is kept, cancelled included: each cancelled document has a credit
 * note reversing it, and dropping either half moves the total.
 */
import { createServerFn } from "@tanstack/react-start";

export type NaCommissionStatementFile = {
  readable_id: string;
  house_code: string;
  filename: string;
  /** The PDF itself, base64. */
  pdf_base64: string;
  generated_on: string;
};

const QUERY = `
WITH ev AS (
  SELECT
    e.client_request_readable_id AS rid,
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
-- The provider line: which quote, and the commission finance holds for it.
-- Both figures are taken as recorded rather than recomputed — on a US provider
-- they are equal, on a European one they differ by the tax on the commission.
prov AS (
  SELECT
    ANY_VALUE(rm.quote_id) AS quote_id,
    ANY_VALUE(COALESCE(NULLIF(o.company_name, ''), NULLIF(h.title, ''),
                       NULLIF(rm.venue_name, ''), NULLIF(rm.partner_name, ''))) AS provider_name,
    ANY_VALUE(o.readable_id) AS owner_code,
    ANY_VALUE(rm.currency_partner) AS currency,
    -- Rounded to the cent: the view keeps these unrounded (3513.505342 against a
    -- 3513.51 incl. tax on Hyatt), and an unrounded ratio would put a one-cent
    -- wobble in the per-line incl.-tax column.
    ANY_VALUE(ROUND(CAST(rm.p_live_commission_ht_pcurrency AS FLOAT64), 2)) AS commission_ht,
    ANY_VALUE(ROUND(CAST(rm.p_live_commission_ttc_pcurrency AS FLOAT64), 2)) AS commission_ttc,
    h.readable_id AS house_code
  FROM \`naboo-app-365515.finance_gld_vw_prd.vw_reconciliation_master\` rm
  JOIN \`naboo-app-365515.raw_naboo_data.houses\` h ON h.house_id = rm.house_mongo_id
  LEFT JOIN \`naboo-app-365515.raw_naboo_data.owners\` o ON o.owner_id = rm.house_owner_id
  WHERE rm.client_request_readable_id = @ref
    AND h.readable_id = @house
    AND rm.is_current_proposal_phase_quote = TRUE
  GROUP BY house_code
),
-- Commission documents for this provider on this booking. NABCO-% only, every
-- status, attached through the FEE_OWNER line items.
docs AS (
  SELECT ARRAY_AGG(d ORDER BY d.issued, d.ref) AS items
  FROM (
    SELECT DISTINCT
      i.invoiceNumber AS ref,
      i.invoiceKind   AS kind,
      i.status        AS status,
      i.currency      AS currency,
      CAST(ROUND(i.totals.totalamountincludingtaxes.amount / 100, 2) AS FLOAT64) AS amount,
      CAST(DATE(i.issueDate) AS STRING) AS issued,
      CAST(DATE(i.dueDate)   AS STRING) AS due,
      i.buyer.legalName AS addressed_to
    FROM \`naboo-app-365515.raw_naboo_data.invoices\` i
    JOIN \`naboo-app-365515.raw_naboo_data.invoice_line_items\` li
      ON li.invoice_id = i.invoice_id AND li.deleted = false
    JOIN \`naboo-app-365515.raw_naboo_data.quotes\` q ON q.quote_id = li.quote_id
    JOIN \`naboo-app-365515.raw_naboo_data.houses\` h ON h.house_id = q.house_id
    WHERE i.clientRequestReadableId = @ref
      AND i.invoiceNumber LIKE 'NABCO-%'
      AND li.line_type = 'FEE_OWNER'
      AND h.readable_id = @house
  ) d
),
-- The services a commission was computed on. DISTINCT is mandatory: this table
-- holds duplicate rows per item and the base doubles without it.
svc AS (
  SELECT ARRAY_AGG(s ORDER BY s.line_base DESC, s.service) AS items
  FROM (
    SELECT DISTINCT
      cpi.object_data_label AS service,
      SAFE_CAST(cpi.price_option_quantity AS FLOAT64) AS qty,
      cpi.object_data_prices_unit AS unit,
      ROUND(cpi.object_data_prices_price_base_price_price_without_vat / 10000, 2) AS unit_excl_tax,
      -- Raw, converted in TypeScript so the scale lives in one tested place.
      CAST(cpi.price_option_fees_owner_fees_rate AS FLOAT64) AS rate_raw,
      ROUND(SAFE_CAST(cpi.price_option_quantity AS FLOAT64)
            * cpi.object_data_prices_price_base_price_price_without_vat / 10000, 2) AS line_base
    FROM \`naboo-app-365515.raw_naboo_data.client_pricing_items\` cpi
    WHERE cpi.quote_id = (SELECT quote_id FROM prov)
      AND cpi.type != 'OWNER_FEES'
      AND IFNULL(cpi.price_option_fees_owner_fees_rate, 0) > 0
      AND cpi.object_data_label IS NOT NULL
      -- A line with no unit price or no quantity has no base: it cannot carry a
      -- commission, and left in it lands in the reconciled subset contributing
      -- nothing but a second copy of its own name (C-P222 carries an unpriced
      -- "Game Show" beside the priced one).
      AND IFNULL(cpi.object_data_prices_price_base_price_price_without_vat, 0) > 0
      AND IFNULL(SAFE_CAST(cpi.price_option_quantity AS FLOAT64), 0) > 0
  ) s
)
SELECT
  ev.company_name, ev.event_name, ev.start_date, ev.end_date, ev.billing_entity, ev.em_referent,
  prov.house_code, prov.owner_code, prov.provider_name, prov.currency,
  prov.commission_ht, prov.commission_ttc,
  TO_JSON_STRING(IFNULL(docs.items, CAST([] AS ARRAY<STRUCT<
    ref STRING, kind STRING, status STRING, currency STRING, amount FLOAT64,
    issued STRING, due STRING, addressed_to STRING
  >>))) AS documents_json,
  TO_JSON_STRING(IFNULL(svc.items, CAST([] AS ARRAY<STRUCT<
    service STRING, qty FLOAT64, unit STRING, unit_excl_tax FLOAT64,
    rate_raw FLOAT64, line_base FLOAT64
  >>))) AS services_json
FROM ev CROSS JOIN prov CROSS JOIN docs CROSS JOIN svc
`;

type DocRow = {
  ref: string | null;
  kind: string | null;
  status: string | null;
  currency: string | null;
  amount: number | null;
  issued: string | null;
  due: string | null;
  addressed_to: string | null;
};

type SvcRow = {
  service: string | null;
  qty: number | null;
  unit: string | null;
  unit_excl_tax: number | null;
  rate_raw: number | null;
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

export const generateNaCommissionStatement = createServerFn({ method: "POST" })
  .validator((input: { readable_id: string; house_code: string }) => {
    const ref = (input?.readable_id ?? "").trim().toUpperCase();
    const house = (input?.house_code ?? "").trim().toUpperCase();
    if (!/^[A-Z]-[A-Z0-9]{2,12}$/.test(ref)) throw new Error("Invalid booking reference");
    if (!/^[A-Z]-[A-Z0-9]{2,12}$/.test(house)) throw new Error("Invalid provider code");
    return { readable_id: ref, house_code: house };
  })
  .handler(async ({ data }): Promise<NaCommissionStatementFile> => {
    const { requireTracker } = await import("./session.server");
    await requireTracker("na");

    const { runBigQuery } = await import("./bigquery.server");
    const rows = (await runBigQuery(QUERY, {
      ref: data.readable_id,
      house: data.house_code,
    })) as unknown as Array<Record<string, string | number | null>>;
    const row = rows[0];
    if (!row) {
      throw new Error(`No provider ${data.house_code} found on booking ${data.readable_id}`);
    }

    const {
      ratePctFromStored,
      reconcile,
      buildCommissionStatementHtml,
      commissionStatementFilename,
    } = await import("./commission-statement.ts");
    const { generationDay, eventLabel } = await import("./statement");
    const { emContact } = await import("./em-email");

    const generatedOn = generationDay(new Date());
    const currency = String(row.currency ?? "USD");

    const documents = parseJsonArray<DocRow>(row.documents_json)
      .filter((d) => d.ref && d.amount != null)
      .map((d) => ({
        ref: String(d.ref),
        kind: d.kind === "CREDIT_NOTE" ? ("CREDIT_NOTE" as const) : ("INVOICE" as const),
        status: d.status ?? null,
        currency: String(d.currency ?? currency),
        amount: Number(d.amount),
        issued: d.issued ?? null,
        due: d.due ?? null,
      }));

    const services = parseJsonArray<SvcRow>(row.services_json)
      .filter((s) => s.service)
      .map((s) => ({
        service: String(s.service),
        qty: s.qty == null ? null : Number(s.qty),
        unit: s.unit ?? null,
        unit_excl_tax: s.unit_excl_tax == null ? null : Number(s.unit_excl_tax),
        rate_pct: ratePctFromStored(s.rate_raw),
      }));

    // The invariant, checked before anything is rendered: the services the base is
    // built from have to imply the commission the documents net to. A statement
    // whose base does not lead to its own total is worse than none — the provider
    // will check it line by line.
    const rec = reconcile(services, documents);
    if (!rec.ok) throw new Error(rec.reason ?? "The commission figures do not reconcile.");

    const contact = emContact(row.em_referent == null ? null : String(row.em_referent));
    const readableId = data.readable_id;

    const html = buildCommissionStatementHtml(
      {
        booking: {
          readable_id: readableId,
          client_name: String(row.company_name ?? "—"),
          event: eventLabel(
            readableId,
            row.event_name == null ? null : String(row.event_name),
            row.start_date == null ? null : String(row.start_date),
            row.end_date == null ? null : String(row.end_date),
          ),
          billing_entity: String(row.billing_entity ?? "Naboo Group").replaceAll("_", " "),
        },
        provider: {
          name: String(row.provider_name ?? data.house_code),
          house_code: String(row.house_code ?? data.house_code),
          owner_code: row.owner_code == null ? null : String(row.owner_code),
        },
        services,
        documents,
        currency,
        commission_ht: row.commission_ht == null ? null : Number(row.commission_ht),
        commission_ttc: row.commission_ttc == null ? null : Number(row.commission_ttc),
        generatedOn,
      },
      rec,
      { contact: { email: contact.email, name: contact.name } },
    );

    const { renderStatementPdf } = await import("./statement.server");
    const pdf = await renderStatementPdf(html);

    return {
      readable_id: readableId,
      house_code: String(row.house_code ?? data.house_code),
      filename: commissionStatementFilename(readableId, data.house_code, generatedOn),
      pdf_base64: pdf.toString("base64"),
      generated_on: generatedOn,
    };
  });
