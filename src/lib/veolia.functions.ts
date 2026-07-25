import { createServerFn } from "@tanstack/react-start";

export interface PartnerLine {
  name: string | null;
  email: string | null;
  phone: string | null;
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
  client_request_id: string | null;
  company_name: string | null;
  event_type: string | null;
  booking_date: string | null;
  booking_created_at: string | null;
  booking_status: string | null;
  country_iso_code: string | null;
  billing_entity: string | null;
  days_since_booking: number | null;
  sales_name: string | null;
  invoicing_sla_status: string | null;
  payout_sla_status: string | null;
  receivable_status: string | null;
  first_income_invoice_emission_date: string | null;
  n_income_invoices_issued: number | null;
  days_booking_to_first_emission: number | null;
  currency: string | null;
  client_invoiced_ttc: number | null;
  client_collected_total: number | null;
  client_reste_a_encaisser_ttc: number | null;
  partner_net_a_payer_ttc: number | null;
  partner_reste_a_decaisser_ttc: number | null;
  live_service_fees_ht: number | null;
  end_date: string | null;
  purchase_order_number: string | null;
  purchase_order_updated_at: string | null;
  partners_json: string | null;
  invoices_json: string | null;
}

const VEOLIA_TRACKER_SQL = `
WITH free_invoicing_veolia AS (
  SELECT
    cr.request_id            AS client_request_id,
    cr.readable_id           AS readable_id,
    cr.company_name,
    cr.contact_snapshot_firstname || ' ' || cr.contact_snapshot_lastname AS contact_fullname,
    cr.contact_snapshot_email AS contact_email,
    cr.type                  AS event_type,
    cr.status                AS booking_status,
    cr.deposit_status,
    cr.balance_status,
    cr.country_iso_code,
    cr.billing_entity,
    DATE(cr.confirmation_data_confirmed_by_user) AS booking_date,
    cr.created_at            AS booking_created_at,
    cr.admin_csm_snapshot_firstname  || ' ' || cr.admin_csm_snapshot_lastname  AS csm_name,
    cr.admin_sales_snapshot_firstname|| ' ' || cr.admin_sales_snapshot_lastname AS sales_name
  FROM \`naboo-app-365515.raw_naboo_data.client_requests\` cr
  WHERE 'FREE_INVOICING' IN UNNEST(cr.feature_flags)
    AND cr.deleted = false
    AND LOWER(cr.company_name) LIKE '%veolia%'
    AND (
      EXISTS (
        SELECT 1
        FROM \`naboo-app-365515.finance_gld_fct_prd.fct_export_events_scd1\` e
        WHERE e.client_request_readable_id = cr.readable_id
          AND e.bk_market = 'North America'
      )
      OR cr.admin_sales_snapshot_firstname|| ' ' || cr.admin_sales_snapshot_lastname
         IN ('Malika Karasek-Berenza', 'Mathieu Gonzalez', 'Mara Gianola')
    )
),
partner_detail AS (
  SELECT
    fi.clientRequestId AS client_request_id,
    prt.quoteid        AS quote_id,
    prt.houseownerid   AS house_owner_id,
    COALESCE(o.company_name, so.company_name) AS service_provider_name,
    COALESCE(o.email, so.email)                AS service_provider_email,
    COALESCE(o.phone, so.phone)                AS service_provider_phone,
    NULLIF(TRIM(COALESCE(o.vat_number, so.vat_number, '')), '') AS provider_vat_raw,
    NULLIF(TRIM(COALESCE(so.tax_identifier, '')), '')           AS provider_tax_identifier,
    COALESCE(o.country_iso_code, so.country_iso_code)           AS provider_country,
    prt.currency       AS provider_currency,
    ROUND(prt.outstandingpayable / 10000, 2) AS amount_due_provider,
    ROUND(prt.netdisbursed       / 10000, 2) AS amount_paid_provider,
    ROUND(prt.disbursedtotal     / 10000, 2) AS amount_disbursed_total,
    ROUND(prt.liveconfirmed.netpayable.withtaxes / 10000, 2) AS net_payable_ttc,
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
      provider_vat_raw, provider_tax_identifier, provider_country,
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
    ROUND((fi.liveConfirmed.grossGmv.price.withoutTaxes - fi.liveConfirmed.netGmv.price.withoutTaxes) / 10000, 2) AS live_service_fees_ht,
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
      inv.currency           AS invoice_currency,
      ROUND(inv.totals.totalamountexcludingtaxes.amount / 100, 2) AS amount_ht,
      ROUND(inv.totals.totalamountincludingtaxes.amount / 100, 2) AS amount_ttc,
      inv.issueDate      AS emission_date,
      inv.createdAt      AS created_at,
      inv.dueDate        AS due_date,
      inv.updatedAt      AS updated_at,
      inv.cancelledAt    AS cancelled_at,
      inv.eventStartDate AS event_start_date,
      inv.eventEndDate   AS event_end_date,
      inv.buyer.legalname  AS buyer_name,
      inv.seller.legalname AS seller_name,
      (SELECT MIN(TIMESTAMP(JSON_VALUE(e,'$.sentAt')))
         FROM UNNEST(JSON_EXTRACT_ARRAY(inv.send_events)) e) AS first_sent_at,
      (SELECT MAX(TIMESTAMP(JSON_VALUE(e,'$.sentAt')))
         FROM UNNEST(JSON_EXTRACT_ARRAY(inv.send_events)) e) AS last_sent_at,
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
  GROUP BY inv.clientRequestId
),
income_invoice_dates AS (
  SELECT
    clientRequestId AS client_request_id,
    DATE(MIN(IF(invoiceDirection='INCOME', issueDate, NULL))) AS first_income_invoice_emission_date,
    COUNTIF(invoiceDirection='INCOME' AND status = 'ISSUED') AS n_income_invoices_issued,
    ROUND(SUM(IF(invoiceDirection='INCOME'  AND status='ISSUED' AND amt_ttc > 0, amt_ttc, 0)), 2) AS net_income_invoiced_ttc
  FROM (
    SELECT
      clientRequestId, status, issueDate, invoiceDirection,
      ROUND(totals.totalamountincludingtaxes.amount / 100, 2) AS amt_ttc
    FROM \`naboo-app-365515.raw_naboo_data.invoices\`
  )
  GROUP BY clientRequestId
),
veolia_tracker AS (
  SELECT
    l.client_request_id,
    l.readable_id,
    l.company_name,
    l.sales_name,
    STRUCT(
      l.event_type,
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
      ROUND(COALESCE(pa.partner_net_a_payer_ttc,0) + COALESCE(pd.partner_decaisse_ttc,0), 2) AS partner_reste_a_decaisser_ttc,
      f.live_service_fees_ht      AS live_service_fees_ht
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
  FROM free_invoicing_veolia l
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
  t.sales_name,
  t.event.event_type AS event_type,
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
  t.gmv.client_collected_total AS client_collected_total,
  t.gmv.client_reste_a_encaisser_ttc AS client_reste_a_encaisser_ttc,
  t.gmv.partner_net_a_payer_ttc AS partner_net_a_payer_ttc,
  t.gmv.partner_reste_a_decaisser_ttc AS partner_reste_a_decaisser_ttc,
  t.gmv.live_service_fees_ht AS live_service_fees_ht,
  CAST(ev.end_date AS STRING) AS end_date,
  ev.purchase_order_number AS purchase_order_number,
  CAST(ev.updated_at AS STRING) AS purchase_order_updated_at,
  TO_JSON_STRING(ARRAY(
    SELECT AS STRUCT
      COALESCE(sp.service_provider_name, (SELECT e.house_name FROM UNNEST(ea.items) e WHERE e.quote_id = sp.quote_id LIMIT 1)) AS name,
      COALESCE(sp.service_provider_email, (SELECT e.email FROM UNNEST(ea.items) e WHERE e.quote_id = sp.quote_id LIMIT 1)) AS email,
      COALESCE(sp.service_provider_phone, (SELECT e.phone FROM UNNEST(ea.items) e WHERE e.quote_id = sp.quote_id LIMIT 1)) AS phone,
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
                        LIMIT 1), 0),
                IFNULL(sp.amount_paid_provider, 0)
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
                  LIMIT 1), 0),
          IFNULL(sp.amount_paid_provider, 0)
        )
      END AS amount_paid,
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

FROM veolia_tracker t
LEFT JOIN \`naboo-app-365515.finance_gld_fct_prd.fct_export_events_scd1\` ev
  ON ev.client_request_readable_id = t.readable_id
LEFT JOIN fin_agg fa ON fa.rid = t.readable_id
LEFT JOIN email_agg ea ON ea.rid = t.readable_id
LEFT JOIN pay_agg pa ON pa.crid = t.client_request_id

WHERE t.event.booking_status = 'ACCEPTED'
ORDER BY t.event.booking_created_at DESC
LIMIT 2000
`;

const QUERY = VEOLIA_TRACKER_SQL;


export const getVeoliaSlaRows = createServerFn({ method: "GET" }).handler(async (): Promise<SlaRow[]> => {
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

function mergePartners(list: PartnerLine[]): PartnerLine[] {
  // Pass 1: bucket entries by name key.
  const byName = new Map<string, PartnerLine>();
  const noName: PartnerLine[] = [];
  for (const p of list) {
    const nameKey = (p.name ?? "").trim().toLowerCase();
    if (!nameKey) {
      noName.push({ ...p });
      continue;
    }
    const existing = byName.get(nameKey);
    if (!existing) {
      byName.set(nameKey, { ...p });
    } else {
      mergeInto(existing, p);
    }
  }

  // Pass 2: collapse entries that share an email (different name variants
  // — e.g. legal entity vs trade name — sourced from quotes + service_providers).
  const byEmail = new Map<string, PartnerLine>();
  const result: PartnerLine[] = [];
  for (const p of byName.values()) {
    const emailKey = (p.email ?? "").trim().toLowerCase();
    if (!emailKey) {
      result.push(p);
      continue;
    }
    const existing = byEmail.get(emailKey);
    if (!existing) {
      byEmail.set(emailKey, p);
      result.push(p);
    } else {
      mergeInto(existing, p);
    }
  }
  for (const p of noName) {
    const emailKey = (p.email ?? "").trim().toLowerCase();
    const existing = emailKey ? byEmail.get(emailKey) : undefined;
    if (existing) mergeInto(existing, p);
    else result.push(p);
  }
  // Drop "ghost" rows that came from quotes but carry no contact and no
  // amounts — they're duplicate trade-name shells of a service_providers row
  // we already kept under the legal name.
  return result.filter((p) => {
    const noAmounts =
      (p.amount_due ?? 0) === 0 &&
      (p.amount_paid ?? 0) === 0 &&
      (p.net_payable_ttc ?? 0) === 0;
    const noContact = !p.email && !p.phone;
    return !(noAmounts && noContact);
  });
}


function mergeInto(existing: PartnerLine, p: PartnerLine) {
  // Prefer the variant that actually carries amounts (service_providers row)
  // for the display name.
  const existingHasAmounts =
    (existing.amount_due ?? 0) !== 0 ||
    (existing.amount_paid ?? 0) !== 0 ||
    (existing.net_payable_ttc ?? 0) !== 0;
  const incomingHasAmounts =
    (p.amount_due ?? 0) !== 0 ||
    (p.amount_paid ?? 0) !== 0 ||
    (p.net_payable_ttc ?? 0) !== 0;
  if (!existingHasAmounts && incomingHasAmounts && p.name) existing.name = p.name;

  // p_outstanding_payable_pcurrency only means money due when positive; negative
  // values are credits/overpayments. Both due and paid in financials are
  // partner-level totals that repeat on every quote row. When multiple quote
  // rows collapse into one partner line, keep the single total with the
  // largest magnitude instead of summing repeated totals.
  const existingDue = existing.amount_due ?? 0;
  const incomingDue = Math.max(p.amount_due ?? 0, 0);
  existing.amount_due = Math.abs(incomingDue) > Math.abs(existingDue) ? incomingDue : existingDue;

  const existingPaid = existing.amount_paid ?? 0;
  const incomingPaid = p.amount_paid ?? 0;
  existing.amount_paid = Math.abs(incomingPaid) > Math.abs(existingPaid) ? incomingPaid : existingPaid;

  existing.net_payable_ttc = (existing.net_payable_ttc ?? 0) + (p.net_payable_ttc ?? 0);
  existing.is_outstanding = Boolean(existing.is_outstanding) || Boolean(p.is_outstanding);
  existing.is_cancelled = Boolean(existing.is_cancelled) && Boolean(p.is_cancelled);
  if (!existing.email && p.email) existing.email = p.email;
  if (!existing.phone && p.phone) existing.phone = p.phone;
  if (!existing.vat_raw && p.vat_raw) existing.vat_raw = p.vat_raw;
  if (!existing.tax_identifier && p.tax_identifier) existing.tax_identifier = p.tax_identifier;
  if (!existing.country && p.country) existing.country = p.country;
  if (!existing.currency && p.currency) existing.currency = p.currency;
  if (!existing.payout_fx_date || (p.payout_fx_date && p.payout_fx_date > existing.payout_fx_date)) {
    existing.payout_fx_date = p.payout_fx_date;
  }
}



export function parseInvoices(json: string | null): InvoiceLine[] {
  if (!json) return [];
  try {
    const all = JSON.parse(json) as InvoiceLine[];
    return all.filter(
      (inv) =>
        !(inv.status ?? "").toUpperCase().includes("CANCEL") &&
        (inv.amount_ttc ?? 0) >= 0,
    );
  } catch {
    return [];
  }
}

