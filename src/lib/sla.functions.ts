import { createServerFn } from "@tanstack/react-start";
import { mergePartners } from "./partner-merge";

export interface PartnerLine {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** Owner code (O-XXXX) — used to match Slack credit-card approvals exactly. */
  owner_code: string | null;
  /** Free-text tax registration as held on the owner record — needs parsing. */
  vat_raw: string | null;
  /** Structured tax identifier, used for non-venue service owners. */
  tax_identifier: string | null;
  country: string | null;
  currency: string | null;
  amount_due: number | null;
  amount_paid: number | null;
  net_payable_ttc: number | null;
  is_outstanding: boolean | null;
  is_cancelled: boolean | null;
  payout_fx_date: string | null;
}

export interface InvoiceLine {
  invoice_ref: string | null;
  direction: string | null;
  status: string | null;
  /** The invoice this one cancels, in part or in full. */
  cancels: string | null;
  cancellation_reason: string | null;
  currency: string | null;
  amount_ht: number | null;
  amount_ttc: number | null;
  emission_date: string | null;
  due_date: string | null;
  first_sent_at: string | null;
  sent_to: string | null;
  send_method: string | null;
  is_sent: boolean | null;
  days_overdue: number | null;
}

export interface SlaRow {
  readable_id: string | null;
  booking_url: string | null;
  transaction_kind: string | null;
  client_request_id: string | null;
  company_name: string | null;
  event_type: string | null;
  booking_date: string | null;
  booking_created_at: string | null;
  booking_status: string | null;
  country_iso_code: string | null;
  billing_entity: string | null;
  days_since_booking: number | null;
  invoicing_sla_status: string | null;
  payout_sla_status: string | null;
  receivable_status: string | null;
  first_income_invoice_emission_date: string | null;
  n_income_invoices_issued: number | null;
  days_booking_to_first_emission: number | null;
  currency: string | null;
  client_invoiced_ttc: number | null;
  /** What the client agreed to pay, from the confirmed proposal (TTC). */
  client_proposal_total_ttc: number | null;
  client_collected_total: number | null;
  client_reste_a_encaisser_ttc: number | null;
  partner_net_a_payer_ttc: number | null;
  partner_reste_a_decaisser_ttc: number | null;
  start_date: string | null;
  end_date: string | null;
  purchase_order_number: string | null;
  purchase_order_date: string | null;
  partners_json: string | null;
  invoices_json: string | null;
}

const QUERY = `
WITH loreal_free_invoicing AS (
  SELECT
    cr.request_id            AS client_request_id,
    cr.readable_id           AS readable_id,
    cr.transaction_kind      AS transaction_kind,
    cr.company_name,
    cr.type                  AS event_type,
    cr.status                AS booking_status,
    cr.country_iso_code,
    cr.billing_entity,
    DATE(cr.confirmation_data_confirmed_by_user) AS booking_date,
    cr.created_at            AS booking_created_at
  FROM \`naboo-app-365515.raw_naboo_data.client_requests\` cr
  WHERE 'FREE_INVOICING' IN UNNEST(cr.feature_flags)
    AND cr.deleted = false
    AND cr.company_name = 'L’Oréal Canada Inc'
    -- Turnkey is filtered client-side so it can be brought back when needed.
),
partner_detail AS (
  SELECT
    fi.clientRequestId AS client_request_id,
    prt.quoteid        AS quote_id,
    prt.houseownerid   AS house_owner_id,
    COALESCE(o.company_name, so.company_name) AS service_provider_name,
    COALESCE(o.email, so.email)                AS service_provider_email,
    COALESCE(o.phone, so.phone)                AS service_provider_phone,
    COALESCE(o.readable_id, so.readable_id) AS provider_owner_code,
    NULLIF(TRIM(COALESCE(o.vat_number, so.vat_number, '')), '') AS provider_vat_raw,
    NULLIF(TRIM(COALESCE(so.tax_identifier, '')), '')           AS provider_tax_identifier,
    COALESCE(o.country_iso_code, so.country_iso_code)           AS provider_country,
    prt.currency       AS provider_currency,
    ROUND(prt.outstandingpayable / 10000, 2) AS amount_due_provider,
    ROUND(prt.netdisbursed       / 10000, 2) AS amount_paid_provider,
    ROUND(prt.disbursedtotal     / 10000, 2) AS amount_disbursed_total,
    -- What the provider is actually owed: the price less any discount granted
    -- on it. discountPrice is a reduction, not an alternative figure — checked
    -- against every discounted L'Oreal line, where
    -- price - discountPrice - disbursed = outstandingPayable to the cent
    -- (Hotel X Toronto on C-W875: 14 204,10 - 6 603,89 = 7 600,21 owed).
    -- Reading price alone overstated seven providers' balances.
    ROUND((prt.liveconfirmed.netpayable.price.withtaxes
           - IFNULL(prt.liveconfirmed.netpayable.discountprice.withtaxes, 0)) / 10000, 2) AS net_payable_ttc,
    prt.disbursementfxdate AS payout_fx_date,
    prt.quotecancelledat   AS quote_cancelled_at,
    (prt.quotecancelledat IS NOT NULL) AS is_cancelled_quote,
    (q.provision_name IS NOT NULL)     AS is_provision_quote,
    q.provision_name AS provision_name,
    (COALESCE(prt.outstandingpayable,0) > 0 AND prt.quotecancelledat IS NULL
       AND q.provision_name IS NULL) AS is_outstanding
  FROM \`naboo-app-365515.raw_naboo_data.client_request_free_invoicing\` fi,
       UNNEST(fi.partners) prt
  LEFT JOIN \`naboo-app-365515.raw_naboo_data.owners\` o
    ON prt.houseownerid = o.owner_id
  -- Non-venue providers (ad-hoc services) hang off service_owners instead.
  LEFT JOIN \`naboo-app-365515.raw_naboo_data.service_owners\` so
    ON prt.houseownerid = so.owner_id
  LEFT JOIN \`naboo-app-365515.raw_naboo_data.quotes\` q
    ON prt.quoteid = q.quote_id
  WHERE fi.deleted = false
),
partners_agg AS (
  SELECT
    client_request_id,
    ARRAY_AGG(STRUCT(
      quote_id, house_owner_id, service_provider_name,
      service_provider_email, service_provider_phone, provider_currency,
      provider_owner_code, provider_vat_raw, provider_tax_identifier, provider_country,
      amount_due_provider, amount_paid_provider, amount_disbursed_total,
      net_payable_ttc, payout_fx_date, quote_cancelled_at,
      is_cancelled_quote, is_provision_quote, provision_name, is_outstanding
    ) ORDER BY is_cancelled_quote, quote_id) AS service_providers,
    ROUND(SUM(IF(NOT is_cancelled_quote AND NOT is_provision_quote, net_payable_ttc, 0)), 2) AS partner_net_a_payer_ttc
  FROM partner_detail
  GROUP BY client_request_id
),
payout_disbursed AS (
  SELECT client_request_id, ROUND(SUM(d_total), 2) AS partner_decaisse_ttc
  FROM (
    SELECT DISTINCT client_request_id, house_owner_id, payout_fx_date, amount_disbursed_total AS d_total
    FROM partner_detail
    WHERE COALESCE(amount_disbursed_total, 0) != 0
      AND NOT is_provision_quote
  )
  GROUP BY client_request_id
),
financials AS (
  SELECT
    fi.clientRequestId AS client_request_id,
    fi.currency        AS currency,
    ROUND(fi.liveConfirmed.grossGmv.price.withoutTaxes / 10000, 2) AS gross_gmv_ht,
    ROUND(fi.liveConfirmed.netGmv.price.withoutTaxes   / 10000, 2) AS net_gmv_ht,
    ROUND(fi.collectedTotal / 10000, 2) AS client_collected_total
  FROM \`naboo-app-365515.raw_naboo_data.client_request_free_invoicing\` fi
  WHERE fi.deleted = false
),
invoices AS (
  SELECT
    inv.clientRequestId AS client_request_id,
    ARRAY_AGG(STRUCT(
      inv.invoiceNumber      AS invoice_ref,
      inv.invoiceDirection   AS invoice_direction,
      inv.status             AS invoice_status,
      -- Parent/child, as the back office shows it: a credit note names the
      -- invoice it cancels.
      inv.cancelledInvoiceNumber AS cancels,
      inv.cancellationReason     AS cancellation_reason,
      inv.currency           AS invoice_currency,
      ROUND(inv.totals.totalamountexcludingtaxes.amount / 100, 2) AS amount_ht,
      ROUND(inv.totals.totalamountincludingtaxes.amount / 100, 2) AS amount_ttc,
      inv.issueDate      AS emission_date,
      inv.dueDate        AS due_date,
      (SELECT MIN(TIMESTAMP(JSON_VALUE(e,'$.sentAt')))
         FROM UNNEST(JSON_EXTRACT_ARRAY(inv.send_events)) e) AS first_sent_at,
      (SELECT STRING_AGG(DISTINCT JSON_VALUE(e,'$.sentTo'))
         FROM UNNEST(JSON_EXTRACT_ARRAY(inv.send_events)) e
         WHERE JSON_VALUE(e,'$.sentTo') != '') AS sent_to,
      (SELECT STRING_AGG(DISTINCT JSON_VALUE(e,'$.method'))
         FROM UNNEST(JSON_EXTRACT_ARRAY(inv.send_events)) e) AS send_method,
      (COALESCE(ARRAY_LENGTH(JSON_EXTRACT_ARRAY(inv.send_events)),0) > 0) AS is_sent,
      CASE
        WHEN inv.invoiceDirection = 'INCOME'
         AND inv.status = 'ISSUED'
         AND inv.totals.totalamountincludingtaxes.amount > 0
        THEN DATE_DIFF(CURRENT_DATE(), DATE(inv.dueDate), DAY)
        ELSE NULL
      END AS days_overdue
    ) ORDER BY inv.issueDate) AS invoices
  FROM \`naboo-app-365515.raw_naboo_data.invoices\` inv
  -- Only invoices actually billed to the client. INCOME direction is not enough:
  -- our commission notes to the *partner* are income to us too, carry only
  -- FEE_OWNER lines, and were being listed and counted as the client's own
  -- invoices — 158 of them on one Capgemini entity alone.
  JOIN (
    SELECT li.invoice_id
    FROM \`naboo-app-365515.raw_naboo_data.invoice_line_items\` li
    WHERE li.deleted = false
    GROUP BY li.invoice_id
    HAVING SUM(IF(li.line_type IN ('SERVICE', 'FEE_CLIENT'), 1, 0)) > 0
  ) cl ON cl.invoice_id = inv.invoice_id
  GROUP BY inv.clientRequestId
),
-- What the client agreed to pay, from the confirmed proposal.
--
-- Stands in for the amount still to be invoiced on a booking whose invoice has
-- not gone out yet, where there is no invoice to read an amount from. It is TTC
-- and has matched the issued invoice to the cent on every booking checked
-- (F-B796: 5 802,79). MAX + GROUP BY rather than DISTINCT so a booking can
-- never multiply rows in the driving table.
client_proposal_total AS (
  SELECT
    rm.client_request_readable_id AS rid,
    MAX(CAST(cp.price_totals_total_client_with_fees_at_date AS FLOAT64)) / 10000 AS total_ttc
  FROM \`naboo-app-365515.finance_gld_vw_prd.vw_reconciliation_master\` rm
  JOIN \`naboo-app-365515.raw_naboo_data.client_proposals\` cp
    ON cp.client_proposal_id = rm.source_client_proposal_id
  WHERE rm.booking_status = 'ACCEPTED'
    AND rm.source_client_proposal_id IS NOT NULL
  GROUP BY rid
),
invoice_po AS (
  SELECT
    inv.clientRequestId AS client_request_id,
    ARRAY_AGG(TRIM(inv.purchaseOrderNumber) ORDER BY inv.issueDate LIMIT 1)[SAFE_OFFSET(0)] AS purchase_order_number,
    -- We demonstrably held the PO by the time we billed against it.
    DATE(MIN(inv.issueDate)) AS known_by
  FROM \`naboo-app-365515.raw_naboo_data.invoices\` inv
  WHERE inv.invoiceDirection = 'INCOME'
    -- A free-text field: "pas de PO" and "" are not purchase orders.
    AND REGEXP_CONTAINS(IFNULL(inv.purchaseOrderNumber, ''), r'[0-9]')
  GROUP BY inv.clientRequestId
),
income_invoice_dates AS (
  SELECT
    clientRequestId AS client_request_id,
    DATE(MIN(IF(invoiceDirection='INCOME', issueDate, NULL))) AS first_income_invoice_emission_date,
    COUNTIF(invoiceDirection='INCOME' AND status = 'ISSUED') AS n_income_invoices_issued,
    -- What the client has been billed: every document we sent them, at the
    -- total printed on it.
    --
    -- Not "positives only": ignoring credit notes bills the client for amounts
    -- that were voided. Not every INCOME invoice either: a commission note to
    -- the partner is income to us but was never billed to the client, so it is
    -- excluded by requiring a client-facing line (SERVICE or FEE_CLIENT).
    ROUND(SUM(IF(invoiceDirection='INCOME' AND is_client_facing, amt_ttc, 0)), 2)
      AS net_income_invoiced_ttc
  FROM (
    SELECT
      inv.clientRequestId, inv.status, inv.issueDate, inv.invoiceDirection,
      ROUND(inv.totals.totalamountincludingtaxes.amount / 100, 2) AS amt_ttc,
      cl.invoice_id IS NOT NULL AS is_client_facing
    FROM \`naboo-app-365515.raw_naboo_data.invoices\` inv
    LEFT JOIN (
      SELECT li.invoice_id
      FROM \`naboo-app-365515.raw_naboo_data.invoice_line_items\` li
      WHERE li.deleted = false
      GROUP BY li.invoice_id
      HAVING SUM(IF(li.line_type IN ('SERVICE', 'FEE_CLIENT'), 1, 0)) > 0
    ) cl ON cl.invoice_id = inv.invoice_id
  )
  GROUP BY clientRequestId
),
loreal_tracker AS (
  SELECT
    l.client_request_id,
    l.readable_id,
    l.company_name,
    STRUCT(
      l.event_type,
      l.transaction_kind,
      l.booking_date,
      l.booking_status,
      l.country_iso_code,
      l.billing_entity,
      l.booking_created_at
    ) AS event,
    STRUCT(
      f.currency,
      iid.net_income_invoiced_ttc AS client_invoiced_ttc,
      f.client_collected_total    AS client_collected_total,
      ROUND(COALESCE(iid.net_income_invoiced_ttc,0) - COALESCE(f.client_collected_total,0), 2) AS client_reste_a_encaisser_ttc,
      COALESCE(pa.partner_net_a_payer_ttc, 0) AS partner_net_a_payer_ttc,
      ROUND(COALESCE(pa.partner_net_a_payer_ttc,0) + COALESCE(pd.partner_decaisse_ttc,0), 2) AS partner_reste_a_decaisser_ttc
    ) AS gmv,
    pa.service_providers,
    STRUCT(
      DATE_DIFF(CURRENT_DATE(), l.booking_date, DAY) AS days_since_booking,
      iid.first_income_invoice_emission_date,
      COALESCE(iid.n_income_invoices_issued, 0) AS n_income_invoices_issued,
      DATE_DIFF(iid.first_income_invoice_emission_date, l.booking_date, DAY) AS days_booking_to_first_emission,
      CASE
        WHEN l.booking_date IS NULL THEN 'NA'
        WHEN iid.first_income_invoice_emission_date IS NULL THEN 'NO_INVOICE_YET'
        WHEN DATE_DIFF(iid.first_income_invoice_emission_date, l.booking_date, DAY) <= 1 THEN 'WITHIN_24H'
        ELSE 'BREACHED_24H'
      END AS invoicing_sla_status,
      CASE
        WHEN COALESCE(pa.partner_net_a_payer_ttc, 0) = 0 THEN 'NO_PARTNER_LIABILITY'
        WHEN ROUND(COALESCE(pa.partner_net_a_payer_ttc,0) + COALESCE(pd.partner_decaisse_ttc,0), 2) = 0 THEN 'FULLY_PAID'
        WHEN ROUND(COALESCE(pa.partner_net_a_payer_ttc,0) + COALESCE(pd.partner_decaisse_ttc,0), 2) > 0 THEN 'OUTSTANDING'
        ELSE 'OVERPAID'
      END AS payout_sla_status,
      CASE
        WHEN COALESCE(iid.net_income_invoiced_ttc, 0) = 0 THEN 'NOT_INVOICED'
        WHEN ROUND(COALESCE(iid.net_income_invoiced_ttc,0) - COALESCE(f.client_collected_total,0), 2) = 0 THEN 'COLLECTED'
        WHEN ROUND(COALESCE(iid.net_income_invoiced_ttc,0) - COALESCE(f.client_collected_total,0), 2) > 0 THEN 'TO_COLLECT'
        ELSE 'OVERCOLLECTED'
      END AS receivable_status
    ) AS sla,
    i.invoices
  FROM loreal_free_invoicing l
  LEFT JOIN financials           f   ON f.client_request_id   = l.client_request_id
  LEFT JOIN partners_agg         pa  ON pa.client_request_id  = l.client_request_id
  LEFT JOIN payout_disbursed     pd  ON pd.client_request_id  = l.client_request_id
  LEFT JOIN invoices             i   ON i.client_request_id   = l.client_request_id
  LEFT JOIN income_invoice_dates iid ON iid.client_request_id = l.client_request_id
),
email_agg AS (
  SELECT
    q.client_request_readable_id AS rid,
    ARRAY_AGG(STRUCT(
      q.quote_id AS quote_id,
      h.title AS house_name,
      o.email AS email,
      o.phone AS phone
    )) AS items
  FROM \`naboo-app-365515.raw_naboo_data.quotes\` q
  LEFT JOIN \`naboo-app-365515.raw_naboo_data.houses\` h ON h.house_id = q.house_id
  LEFT JOIN \`naboo-app-365515.raw_naboo_data.owners\` o ON o.owner_id = h.owner_id
  GROUP BY rid
),
fin_agg AS (
  SELECT
    client_request_readable_id AS rid,
    ARRAY_AGG(STRUCT(
      quoteId AS quote_id,
      houseOwnerId AS house_owner_id,
      GREATEST(CAST(p_outstanding_payable_pcurrency AS FLOAT64), 0) AS due,
      CAST(p_disbursed_total_pcurrency AS FLOAT64) AS paid
    )) AS items
  FROM \`naboo-app-365515.finance_gld_fct_prd.fct_reconciliation_partner_full_scd1\`
  GROUP BY rid
),
pay_agg AS (
  SELECT
    client_request_id AS crid,
    ARRAY_AGG(STRUCT(host_id AS host_id, paid AS paid)) AS items
  FROM (
    SELECT
      client_request_id,
      host_id,
      SUM(CAST(amount AS FLOAT64) / 10000) AS paid
    FROM \`naboo-app-365515.raw_naboo_data.payments\`
    WHERE kind = 'HOST_PAYMENT'
      AND flow = 'OUTFLOW_PAYMENT'
      AND NOT deleted
      AND client_request_id IS NOT NULL
      AND host_id IS NOT NULL
    GROUP BY client_request_id, host_id
  )
  GROUP BY crid
)


SELECT
  t.readable_id,
  t.client_request_id,
  t.company_name,
  t.event.event_type AS event_type,
  t.event.transaction_kind AS transaction_kind,
  CAST(t.event.booking_date AS STRING) AS booking_date,
  CAST(t.event.booking_created_at AS STRING) AS booking_created_at,
  t.event.booking_status AS booking_status,
  t.event.country_iso_code AS country_iso_code,
  t.event.billing_entity AS billing_entity,
  t.sla.days_since_booking AS days_since_booking,
  t.sla.invoicing_sla_status AS invoicing_sla_status,
  t.sla.payout_sla_status AS payout_sla_status,
  t.sla.receivable_status AS receivable_status,
  CAST(t.sla.first_income_invoice_emission_date AS STRING) AS first_income_invoice_emission_date,
  t.sla.n_income_invoices_issued AS n_income_invoices_issued,
  t.sla.days_booking_to_first_emission AS days_booking_to_first_emission,
  t.gmv.currency AS currency,
  t.gmv.client_invoiced_ttc AS client_invoiced_ttc,
  ROUND(cpt.total_ttc, 2) AS client_proposal_total_ttc,
  t.gmv.client_collected_total AS client_collected_total,
  t.gmv.client_reste_a_encaisser_ttc AS client_reste_a_encaisser_ttc,
  t.gmv.partner_net_a_payer_ttc AS partner_net_a_payer_ttc,
  t.gmv.partner_reste_a_decaisser_ttc AS partner_reste_a_decaisser_ttc,
  CAST(ev.start_date AS STRING) AS start_date,
  CAST(ev.end_date AS STRING) AS end_date,
  -- The booking record is the first source, but the number often only ever
  -- reaches the client invoice (18 of 85 L'Oreal events), where reading the
  -- booking alone showed "No PO" on a booking we had been given one for.
  COALESCE(ev.purchase_order_number, ipo.purchase_order_number) AS purchase_order_number,
  ev.booking_url AS booking_url,
  -- When the PO reached us. NOT ev.updated_at: that is the warehouse's own
  -- ingestion stamp, identical on all 27k rows and moving to today on every
  -- refresh, which left both SLAs anchored on "now" and unable to breach.
  CAST(COALESCE(
    CAST(ev.purchase_order_date AS TIMESTAMP),
    CAST(ipo.known_by AS TIMESTAMP)
  ) AS STRING) AS purchase_order_date,
  TO_JSON_STRING(ARRAY(
    SELECT AS STRUCT
      COALESCE(sp.service_provider_name, (SELECT e.house_name FROM UNNEST(ea.items) e WHERE e.quote_id = sp.quote_id LIMIT 1)) AS name,
      (SELECT e.email FROM UNNEST(ea.items) e WHERE e.quote_id = sp.quote_id LIMIT 1) AS email,
      (SELECT e.phone FROM UNNEST(ea.items) e WHERE e.quote_id = sp.quote_id LIMIT 1) AS phone,
      sp.provider_currency AS currency,
      CASE
        WHEN sp.is_outstanding = FALSE THEN 0
        ELSE GREATEST(
          CAST(sp.net_payable_ttc AS FLOAT64)
            - GREATEST(
                IFNULL((SELECT x.paid FROM UNNEST(fa.items) x
                        WHERE x.quote_id = sp.quote_id
                          AND (x.house_owner_id = sp.house_owner_id OR sp.house_owner_id IS NULL)
                        LIMIT 1), 0),
                IFNULL((SELECT y.paid FROM UNNEST(pa.items) y
                        WHERE y.host_id = sp.house_owner_id
                        LIMIT 1), 0)
              ),
          0
        )
      END AS amount_due,
      CASE
        WHEN sp.is_outstanding = FALSE THEN CAST(sp.net_payable_ttc AS FLOAT64)
        ELSE GREATEST(
          IFNULL((SELECT x.paid FROM UNNEST(fa.items) x
                  WHERE x.quote_id = sp.quote_id
                    AND (x.house_owner_id = sp.house_owner_id OR sp.house_owner_id IS NULL)
                  LIMIT 1), 0),
          IFNULL((SELECT y.paid FROM UNNEST(pa.items) y
                  WHERE y.host_id = sp.house_owner_id
                  LIMIT 1), 0)
        )
      END AS amount_paid,
      sp.provider_owner_code AS owner_code,
      sp.provider_vat_raw AS vat_raw,
      sp.provider_tax_identifier AS tax_identifier,
      sp.provider_country AS country,
      CAST(sp.net_payable_ttc AS FLOAT64) AS net_payable_ttc,
      sp.is_outstanding AS is_outstanding,
      sp.is_cancelled_quote AS is_cancelled,
      CAST(sp.payout_fx_date AS STRING) AS payout_fx_date
    FROM UNNEST(t.service_providers) sp
  )) AS partners_json,
  TO_JSON_STRING(ARRAY(
    SELECT AS STRUCT
      inv.invoice_ref AS invoice_ref,
      inv.invoice_direction AS direction,
      inv.invoice_status AS status,
      inv.cancels AS cancels,
      inv.cancellation_reason AS cancellation_reason,
      inv.invoice_currency AS currency,
      inv.amount_ht AS amount_ht,
      inv.amount_ttc AS amount_ttc,
      CAST(inv.emission_date AS STRING) AS emission_date,
      CAST(inv.due_date AS STRING) AS due_date,
      CAST(inv.first_sent_at AS STRING) AS first_sent_at,
      inv.sent_to AS sent_to,
      inv.send_method AS send_method,
      inv.is_sent AS is_sent,
      inv.days_overdue AS days_overdue
    FROM UNNEST(t.invoices) inv
    WHERE UPPER(inv.invoice_direction) = 'INCOME'
  )) AS invoices_json

FROM loreal_tracker t
LEFT JOIN \`naboo-app-365515.finance_gld_fct_prd.fct_export_events_scd1\` ev
  ON ev.client_request_readable_id = t.readable_id
LEFT JOIN fin_agg fa ON fa.rid = t.readable_id
LEFT JOIN email_agg ea ON ea.rid = t.readable_id
LEFT JOIN pay_agg pa ON pa.crid = t.client_request_id
LEFT JOIN invoice_po ipo ON ipo.client_request_id = t.client_request_id
LEFT JOIN client_proposal_total cpt ON cpt.rid = t.readable_id


WHERE t.event.booking_status = 'ACCEPTED'
ORDER BY t.event.booking_created_at DESC
LIMIT 2000
`;

export const getSlaRows = createServerFn({ method: "GET" }).handler(async (): Promise<SlaRow[]> => {
  // Financial data: never served without an approved session that is
  // explicitly allowed to open this tracker.
  const { requireTracker } = await import("./session.server");
  await requireTracker("loreal");
  const { runBigQuery } = await import("./bigquery.server");
  const rows = await runBigQuery(QUERY);
  return rows as unknown as SlaRow[];
});

export function parsePartners(json: string | null): PartnerLine[] {
  if (!json) return [];
  try {
    const raw = (JSON.parse(json) as PartnerLine[]).map((p) => ({
      ...p,
      amount_due: p.amount_due == null ? null : Math.max(p.amount_due, 0),
    }));
    return mergePartners(raw);
  } catch {
    return [];
  }
}

/**
 * Every client invoice on the booking, credit notes and cancellations included.
 *
 * The statement of account has to list and total the whole set — a cancelled
 * invoice always comes with the credit notes that void it, and dropping one side
 * of that pair moves the balance. `parseInvoices` below is the narrower view the
 * screens use.
 */
export function parseAllInvoices(json: string | null): InvoiceLine[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as InvoiceLine[];
  } catch {
    return [];
  }
}

export function parseInvoices(json: string | null): InvoiceLine[] {
  if (!json) return [];
  try {
    const all = JSON.parse(json) as InvoiceLine[];
    return all.filter(
      (inv) => !(inv.status ?? "").toUpperCase().includes("CANCEL") && (inv.amount_ttc ?? 0) >= 0,
    );
  } catch {
    return [];
  }
}
