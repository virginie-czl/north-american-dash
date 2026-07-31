import { createServerFn } from "@tanstack/react-start";

export interface NaPartnerLine {
  /** Owner code (O-XXXX) — matches credit-card approvals in #finance-paiement-by-card. */
  owner_code: string | null;
  name: string | null;
  email: string | null;
  /** The contact's own first name (owners.firstname) — distinct from the venue/company name. */
  contact_first_name: string | null;
  currency: string | null;
  gmv_ttc: number | null;
  paid: number | null;
  outstanding: number | null;
  raw_outstanding: number | null;
  payable: number | null;
  /** Owed right now: invoiced to the client for this partner, less commission. */
  payable_to_date: number | null;
  commission: number | null;
  locked: boolean | null;
  locked_by_admin: boolean | null;
  locked_by_client: boolean | null;
  locked_by_owner: boolean | null;
  is_provision: boolean | null;
  payment_method: string | null;
}

export interface NaInvoiceLine {
  invoice_ref: string | null;
  status: string | null;
  currency: string | null;
  amount_ttc: number | null;
  emission_date: string | null;
  due_date: string | null;
  is_sent: boolean | null;
}

export interface NaRow {
  readable_id: string | null;
  client_request_id: string | null;
  company_name: string | null;
  sales_referent: string | null;
  em_referent: string | null;
  days_before_start: number | null;
  currency_client: string | null;
  event_name: string | null;
  start_date: string | null;
  end_date: string | null;
  event_type: string | null;
  /** Deal shape: TURNKEY_EM, TURNKEY_AGENCY, INVOICE_CARRYING, VENUE_FINDING. */
  transaction_kind: string | null;
  participants: number | null;
  billing_entity: string | null;
  booking_url: string | null;
  gmv_client_ccy: number | null;
  gmv_client_eur: number | null;
  invoiced_ccy: number | null;
  paid_ccy: number | null;
  balance_ccy: number | null;
  partners_json: string | null;
  invoices_json: string | null;
}

const QUERY = `
WITH
client_invoices AS (
  SELECT
    inv.clientRequestId AS crid,
    ARRAY_AGG(STRUCT(
      inv.invoiceNumber AS invoice_ref,
      inv.status        AS status,
      inv.currency      AS currency,
      CAST(ROUND(inv.totals.totalamountincludingtaxes.amount / 100, 2) AS FLOAT64) AS amount_ttc,
      CAST(inv.issueDate AS STRING) AS emission_date,
      CAST(inv.dueDate   AS STRING) AS due_date,
      (COALESCE(ARRAY_LENGTH(JSON_EXTRACT_ARRAY(inv.send_events)), 0) > 0) AS is_sent
    ) ORDER BY inv.issueDate) AS items
  FROM \`naboo-app-365515.raw_naboo_data.invoices\` inv
  WHERE inv.invoiceDirection = 'INCOME'
  GROUP BY crid
),
fi_base AS (
  SELECT
    fi.clientRequestId AS crid,
    ANY_VALUE(fi.currency) AS currency,
    -- grossGmv gained a price/discountPrice level upstream; the other two trackers
    -- already read .price.withoutTaxes, so this matches them.
    ANY_VALUE(ROUND(fi.liveConfirmed.grossGmv.price.withoutTaxes / 10000, 2)) AS gmv,
    ANY_VALUE(ROUND(fi.collectedTotal / 10000, 2)) AS paid
  FROM \`naboo-app-365515.raw_naboo_data.client_request_free_invoicing\` fi
  WHERE fi.deleted = false
  GROUP BY crid
),
-- Client-side total/invoiced source: the confirmed proposal's own priced
-- totals, cross-checked against real client invoices. vw_balance_agee_ar has
-- no row at all for some bookings, and the "live" GMV estimates
-- (fct_export_events_scd1, and this same view's bk_live_* fields) have both
-- been seen to disagree with the real invoiced amount — this is the one
-- source that has matched a real invoice byte-for-byte so far.
--
-- Filters on booking_status only, NOT is_current_proposal_phase_quote: that
-- flag lives at the per-quote level and has been seen to go transiently NULL
-- (along with partner_name/quote_id/gmv) while this view recomputes live.
-- source_client_proposal_id is a proposal-level field that survives that
-- window, so this CTE stays correct even when partners_rm_dedup below is
-- temporarily starved of data for the same booking.
client_proposal_totals AS (
  SELECT DISTINCT
    rm.client_request_readable_id AS rid,
    CAST(cp.price_totals_total_client_with_fees_at_date AS FLOAT64) / 10000 AS gmv_client_ccy,
    CAST(cp.price_totals_total_client_with_fees_billed AS FLOAT64) / 10000 AS invoiced_ccy
  FROM \`naboo-app-365515.finance_gld_vw_prd.vw_reconciliation_master\` rm
  JOIN \`naboo-app-365515.raw_naboo_data.client_proposals\` cp ON cp.client_proposal_id = rm.source_client_proposal_id
  WHERE rm.booking_status = 'ACCEPTED'
    AND rm.source_client_proposal_id IS NOT NULL
),
-- Partner data source: one row per partner, already reconciled server-side.
-- Same view Commissions NA already uses.
--
-- The view itself can return exact duplicate rows for the same partner/quote
-- (seen in practice for real bookings) — dedup via SELECT DISTINCT on the
-- computed columns before aggregating, so the UI never shows a partner twice.
--
-- No bk_market filter here: this view's own market classification can
-- disagree with fct_export_events_scd1's for the same booking (seen in
-- practice — a booking fct_export_events_scd1 calls North America, this
-- view called "RoW"). The outer query already scopes everything to NA via
-- the driving table.
-- Invoiced to the client, per partner quote.
--
-- For free-invoicing bookings the amount owed to a provider *right now* is not
-- the whole-event total: it is what has actually been invoiced to the client for
-- that provider, less our commission. On C-U775 the back office shows
-- €14,112.00 of third-party services invoiced and an Amount payable of
-- €11,033.02 — that is 14,112.00 - 3,078.98 of commission.
--
-- Line types in invoice_line_items: SERVICE is the provider's own work,
-- FEE_OWNER our commission on it, FEE_CLIENT the service charge billed to the
-- client (no quote_id, so it never attaches to a provider). Amounts are in
-- cents, hence the /100.
-- Invoiced to the client, per booking.
--
-- Summed from the invoice lines rather than taken from the proposal's
-- price_totals_total_client_with_fees_billed, which can lag behind reality: on
-- C-V176 it still held 210 098,91 USD from an invoice that had since been
-- cancelled and credited, where the back office showed 71 882,97 USD.
--
-- SERVICE + FEE_CLIENT only. FEE_OWNER lines are our commission invoiced to the
-- partner, not to the client, and would otherwise inflate the client total.
-- All statuses, so a cancelled invoice and its credit note cancel each other.
-- Client invoices for the detail pane's invoicing tab. Income direction only:
-- partner invoices and commission notes belong elsewhere.
invoiced_client AS (
  SELECT
    i.clientRequestReadableId AS rid,
    ROUND(SUM(IF(li.line_type IN ('SERVICE', 'FEE_CLIENT'), li.total_incl_taxes, 0)) / 100, 2)
      AS invoiced_ttc
  FROM \`naboo-app-365515.raw_naboo_data.invoices\` i
  JOIN \`naboo-app-365515.raw_naboo_data.invoice_line_items\` li
    ON li.invoice_id = i.invoice_id
  WHERE i.invoiceDirection = 'INCOME'
    AND li.deleted = false
    AND i.clientRequestReadableId IS NOT NULL
  GROUP BY rid
),
invoiced_by_quote AS (
  SELECT
    li.quote_id,
    -- Guard against ever subtracting across currencies: invoice lines are in the
    -- client's currency and the partner figures in the partner's. They match on
    -- every North American booking today, but a mismatch would silently produce a
    -- nonsense number rather than an error.
    ANY_VALUE(li.currency) AS line_ccy,
    ROUND(SUM(IF(li.line_type = 'SERVICE',    li.total_incl_taxes, 0)) / 100, 2) AS invoiced_service_ttc,
    ROUND(SUM(IF(li.line_type = 'FEE_OWNER',  li.total_incl_taxes, 0)) / 100, 2) AS invoiced_commission_ttc
  FROM \`naboo-app-365515.raw_naboo_data.invoices\` i
  JOIN \`naboo-app-365515.raw_naboo_data.invoice_line_items\` li
    ON li.invoice_id = i.invoice_id
  -- Every status, deliberately. A cancelled invoice always comes with a credit
  -- note that reverses it, so including both lets the pair net to zero. Filtering
  -- on status = 'ISSUED' kept the credit note but dropped the invoice it cancelled,
  -- subtracting an amount that had never been added: C-V176 read -113 215,94 USD
  -- against a back office 49 830,47 USD.
  -- Only ISSUED and CANCELLED exist on client invoices, so nothing unissued
  -- slips in this way.
  WHERE i.invoiceDirection = 'INCOME'
    AND li.deleted = false
    AND li.quote_id IS NOT NULL
  GROUP BY li.quote_id
),
partners_rm_dedup AS (
  SELECT DISTINCT
    rm.client_request_readable_id AS rid,
    COALESCE(
      NULLIF(o.company_name, ''),
      NULLIF(rm.venue_name, ''),
      NULLIF(rm.partner_name, ''),
      'Prestataire inconnu'
    ) AS name,
    NULLIF(COALESCE(rm.owner_email, rm.service_owner_email, rm.partner_email), '') AS email,
    NULLIF(o.firstname, '') AS contact_first_name,
    o.readable_id AS owner_code,
    rm.currency_partner AS currency,
    CAST(rm.p_live_net_gmv_ttc_pcurrency AS FLOAT64) AS gmv_ttc,
    -- p_disbursed_total_pcurrency's sign is inconsistent across bookings (the
    -- same "amount already paid" shows up positive on some, negative on
    -- others — seen in practice) so it can't be trusted directly. Derive paid
    -- from payable/outstanding instead, which hold up consistently everywhere
    -- checked: payable = gmv - commission, paid = payable - outstanding.
    CAST(rm.p_live_net_gmv_ttc_pcurrency AS FLOAT64)
      - CAST(rm.p_live_commission_ttc_pcurrency AS FLOAT64)
      - CAST(rm.p_outstanding_payable_pcurrency AS FLOAT64) AS paid,
    -- Outstanding is what is owed *now*: payable to date less what has gone out.
    -- Using the view's own whole-event remainder counted amounts not yet invoiced
    -- to the client as money we already owe the partner.
    ROUND(
      COALESCE(
        IF(ibq.line_ccy = rm.currency_partner,
           ibq.invoiced_service_ttc - ibq.invoiced_commission_ttc, NULL),
        CAST(rm.p_live_net_gmv_ttc_pcurrency AS FLOAT64)
          - CAST(rm.p_live_commission_ttc_pcurrency AS FLOAT64)
      )
      - (
        CAST(rm.p_live_net_gmv_ttc_pcurrency AS FLOAT64)
          - CAST(rm.p_live_commission_ttc_pcurrency AS FLOAT64)
          - CAST(rm.p_outstanding_payable_pcurrency AS FLOAT64)
      ), 2) AS outstanding,
    -- The view's own figure, kept for reference: remainder over the whole event.
    CAST(rm.p_outstanding_payable_pcurrency AS FLOAT64) AS raw_outstanding,
    CAST(rm.p_live_net_gmv_ttc_pcurrency AS FLOAT64)
      - CAST(rm.p_live_commission_ttc_pcurrency AS FLOAT64) AS payable,
    -- Payable to date: invoiced to the client for this provider, less commission.
    -- Falls back to the whole-event figure when nothing has been invoiced yet.
    COALESCE(
      IF(ibq.line_ccy = rm.currency_partner,
         ibq.invoiced_service_ttc - ibq.invoiced_commission_ttc, NULL),
      CAST(rm.p_live_net_gmv_ttc_pcurrency AS FLOAT64)
        - CAST(rm.p_live_commission_ttc_pcurrency AS FLOAT64)
    ) AS payable_to_date,
    CAST(rm.p_live_commission_ttc_pcurrency AS FLOAT64) AS commission,
    q.quote_lock_locked_at IS NOT NULL AS locked,
    q.quote_lock_locked_by_admin_id IS NOT NULL AS locked_by_admin,
    q.quote_lock_locked_by_client_id IS NOT NULL AS locked_by_client,
    q.quote_lock_locked_by_owner_id IS NOT NULL AS locked_by_owner,
    q.provision_name IS NOT NULL AS is_provision,
    rm.partner_payment_method AS payment_method
  FROM \`naboo-app-365515.finance_gld_vw_prd.vw_reconciliation_master\` rm
  LEFT JOIN \`naboo-app-365515.raw_naboo_data.owners\` o ON o.owner_id = rm.house_owner_id
  LEFT JOIN \`naboo-app-365515.raw_naboo_data.quotes\` q ON q.quote_id = rm.quote_id
  LEFT JOIN invoiced_by_quote ibq ON ibq.quote_id = rm.quote_id
  WHERE rm.is_current_proposal_phase_quote = TRUE
    AND rm.booking_status = 'ACCEPTED'
),
partners_rm AS (
  SELECT
    rid,
    ARRAY_AGG(STRUCT(
      name, email, contact_first_name, owner_code, currency, gmv_ttc, paid, outstanding, raw_outstanding,
      payable, payable_to_date, commission, locked, locked_by_admin, locked_by_client, locked_by_owner,
      is_provision, payment_method,
      CAST(NULL AS STRING) AS vat_raw,
      CAST(NULL AS STRING) AS tax_identifier,
      CAST(NULL AS STRING) AS country
    )) AS items
  FROM partners_rm_dedup
  GROUP BY rid
),
-- Fallback partner source: the nested free-invoicing table.
--
-- vw_reconciliation_master can hold a row for a booking while every financial
-- field on it is NULL, with is_current_proposal_phase_quote NULL too (seen on
-- C-U775: the partner is named but nothing else is populated). Those bookings
-- are filtered out of partners_rm_dedup entirely and used to render as
-- "PARTNERS (0)" even though the back office shows the provider and its amounts.
--
-- This CTE reconstructs the same figures from the source the back office reads,
-- and is only consulted when partners_rm has nothing for the booking:
--   gross = netPayable + commission, paid = |disbursedTotal|
-- disbursedTotal's sign is inconsistent across bookings, hence the ABS.
partners_fi_fallback AS (
  SELECT
    e.client_request_readable_id AS rid,
    ARRAY_AGG(STRUCT(
      COALESCE(
        NULLIF(o.company_name, ''),
        NULLIF(h.title, ''),
        NULLIF(q.provision_name, ''),
        'Prestataire inconnu'
      ) AS name,
      NULLIF(o.email, '') AS email,
      NULLIF(o.firstname, '') AS contact_first_name,
      o.readable_id AS owner_code,
      part.currency AS currency,
      CAST(ROUND((part.liveConfirmed.netPayable.withTaxes
                  + part.liveConfirmed.commission.withTaxes) / 10000, 2) AS FLOAT64) AS gmv_ttc,
      CAST(ROUND(ABS(part.disbursedTotal) / 10000, 2) AS FLOAT64) AS paid,
      ROUND(
        COALESCE(
          IF(ibq.line_ccy = part.currency,
             ibq.invoiced_service_ttc - ibq.invoiced_commission_ttc, NULL),
          CAST(ROUND(part.liveConfirmed.netPayable.withTaxes / 10000, 2) AS FLOAT64)
        )
        - CAST(ROUND(ABS(part.disbursedTotal) / 10000, 2) AS FLOAT64)
      , 2) AS outstanding,
      CAST(ROUND(part.outstandingPayable / 10000, 2) AS FLOAT64) AS raw_outstanding,
      CAST(ROUND(part.liveConfirmed.netPayable.withTaxes / 10000, 2) AS FLOAT64) AS payable,
      COALESCE(
        IF(ibq.line_ccy = part.currency,
           ibq.invoiced_service_ttc - ibq.invoiced_commission_ttc, NULL),
        CAST(ROUND(part.liveConfirmed.netPayable.withTaxes / 10000, 2) AS FLOAT64)
      ) AS payable_to_date,
      CAST(ROUND(part.liveConfirmed.commission.withTaxes / 10000, 2) AS FLOAT64) AS commission,
      q.quote_lock_locked_at IS NOT NULL AS locked,
      q.quote_lock_locked_by_admin_id IS NOT NULL AS locked_by_admin,
      q.quote_lock_locked_by_client_id IS NOT NULL AS locked_by_client,
      q.quote_lock_locked_by_owner_id IS NOT NULL AS locked_by_owner,
      q.provision_name IS NOT NULL AS is_provision,
      CAST(NULL AS STRING) AS payment_method,
      CAST(NULL AS STRING) AS vat_raw,
      CAST(NULL AS STRING) AS tax_identifier,
      CAST(NULL AS STRING) AS country
    )) AS items
  FROM \`naboo-app-365515.finance_gld_fct_prd.fct_export_events_scd1\` e
  JOIN \`naboo-app-365515.raw_naboo_data.client_request_free_invoicing\` fi
    ON fi.clientRequestId = e.clientRequestId AND fi.deleted = false
  CROSS JOIN UNNEST(fi.partners) AS part
  LEFT JOIN \`naboo-app-365515.raw_naboo_data.quotes\` q ON q.quote_id = part.quoteId
  LEFT JOIN \`naboo-app-365515.raw_naboo_data.houses\` h ON h.house_id = q.house_id
  LEFT JOIN \`naboo-app-365515.raw_naboo_data.owners\` o ON o.owner_id = part.houseOwnerId
  LEFT JOIN invoiced_by_quote ibq ON ibq.quote_id = part.quoteId
  WHERE e.bk_market = 'North America'
    AND e.booking_status = 'ACCEPTED'
    AND part.quoteCancelledAt IS NULL
  GROUP BY rid
),
base AS (
  SELECT
    e.client_request_readable_id AS readable_id,
    e.clientRequestId AS client_request_id,
    e.company_name,
    e.sales_referent,
    e.em_referent,
    e.days_before_start,
    COALESCE(e.currency_client, fi.currency) AS currency_client,
    e.event_name,
    CAST(e.start_date AS STRING) AS start_date,
    CAST(e.end_date AS STRING) AS end_date,
    e.event_type,
    e.transaction_kind,
    e.participants,
    e.billing_entity,
    e.booking_url,
    COALESCE(cpt.gmv_client_ccy, CAST(e.live_gross_gmv_ttc_clcurrency AS FLOAT64), fi.gmv) AS gmv_client_ccy,
    CAST(e.live_gross_gmv_ttc_eur AS FLOAT64) AS gmv_client_eur,
    COALESCE(ic.invoiced_ttc, cpt.invoiced_ccy, CAST(ar.total_invoiced_ccy AS FLOAT64)) AS invoiced_ccy,
    COALESCE(CAST(ar.total_paid_client_ccy AS FLOAT64), fi.paid) AS paid_ccy,
    CAST(ar.balance_client_ccy AS FLOAT64) AS ar_balance_ccy,
    TO_JSON_STRING(
      IFNULL(p.items, IFNULL(pfb.items, CAST([] AS ARRAY<STRUCT<
        name STRING, email STRING, contact_first_name STRING, owner_code STRING, currency STRING, gmv_ttc FLOAT64, paid FLOAT64,
        outstanding FLOAT64, raw_outstanding FLOAT64, payable FLOAT64, payable_to_date FLOAT64,
        commission FLOAT64,
        locked BOOL, locked_by_admin BOOL, locked_by_client BOOL, locked_by_owner BOOL,
        is_provision BOOL, payment_method STRING, vat_raw STRING, tax_identifier STRING, country STRING
      >>)))
    ) AS partners_json,
    TO_JSON_STRING(
      IFNULL(civ.items, CAST([] AS ARRAY<STRUCT<
        invoice_ref STRING, status STRING, currency STRING, amount_ttc FLOAT64,
        emission_date STRING, due_date STRING, is_sent BOOL
      >>))
    ) AS invoices_json
  FROM \`naboo-app-365515.finance_gld_fct_prd.fct_export_events_scd1\` e
  LEFT JOIN \`naboo-app-365515.finance_gld_vw_prd.vw_balance_agee_ar\` ar
    ON ar.readable_id = e.client_request_readable_id
  LEFT JOIN fi_base fi ON fi.crid = e.clientRequestId
  LEFT JOIN client_proposal_totals cpt ON cpt.rid = e.client_request_readable_id
  LEFT JOIN invoiced_client ic ON ic.rid = e.client_request_readable_id
  LEFT JOIN client_invoices civ ON civ.crid = e.clientRequestId
  LEFT JOIN partners_rm p ON p.rid = e.client_request_readable_id
  LEFT JOIN partners_fi_fallback pfb ON pfb.rid = e.client_request_readable_id
  WHERE e.bk_market = 'North America'
    AND e.booking_status = 'ACCEPTED'
)
SELECT
  readable_id, client_request_id, company_name, sales_referent, em_referent, days_before_start,
  currency_client, event_name, start_date, end_date, event_type, transaction_kind, participants, billing_entity, booking_url,
  gmv_client_ccy, gmv_client_eur, invoiced_ccy, paid_ccy, invoices_json,
  -- What is still to be collected from the client: invoiced less received.
  -- Not gmv - paid: the whole-event total includes amounts not yet invoiced, so
  -- that read as outstanding money the client does not owe us yet (C-U775 showed
  -- 9 408 EUR against a back office 0,00 EUR). NULL when nothing is invoiced yet,
  -- so the cell shows nothing rather than a misleading zero.
  CASE
    WHEN invoiced_ccy IS NOT NULL
      THEN ROUND(invoiced_ccy - COALESCE(paid_ccy, 0), 2)
    ELSE ar_balance_ccy
  END AS balance_ccy,
  partners_json
FROM base
ORDER BY start_date DESC NULLS LAST
LIMIT 3000
`;

export const getNaRows = createServerFn({ method: "GET" }).handler(async (): Promise<NaRow[]> => {
  // Financial data: never served without an approved session that is
  // explicitly allowed to open this tracker.
  const { requireTracker } = await import("./session.server");
  await requireTracker("na");
  const { runBigQuery } = await import("./bigquery.server");
  const rows = await runBigQuery(QUERY);
  return rows as unknown as NaRow[];
});

export function parseNaPartners(json: string | null): NaPartnerLine[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as NaPartnerLine[];
  } catch {
    return [];
  }
}

export function sumPartners(partners: NaPartnerLine[]) {
  const byCcy = new Map<
    string,
    {
      gmv: number;
      paid: number;
      outstanding: number;
      payable: number;
      payableToDate: number;
      commission: number;
    }
  >();
  for (const p of partners) {
    if (p.is_provision) continue;
    const c = p.currency ?? "—";
    const cur = byCcy.get(c) ?? {
      gmv: 0,
      paid: 0,
      outstanding: 0,
      payable: 0,
      payableToDate: 0,
      commission: 0,
    };
    cur.gmv += p.gmv_ttc ?? 0;
    cur.paid += p.paid ?? 0;
    cur.outstanding += p.outstanding ?? 0;
    cur.payable += p.payable ?? 0;
    cur.payableToDate += p.payable_to_date ?? 0;
    cur.commission += p.commission ?? 0;
    byCcy.set(c, cur);
  }
  return byCcy;
}

export function parseNaInvoices(json: string | null): NaInvoiceLine[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as NaInvoiceLine[]) : [];
  } catch {
    return [];
  }
}
