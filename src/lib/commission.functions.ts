/**
 * North America commission tracker.
 *
 * Source: vw_reconciliation_master (one row per partner per booking).
 * The view already carries booking-level totals (bk_*) repeated on each partner
 * row, and partner-level commission at p_live_* with rates p_rate_*.
 * We deduplicate booking-level figures by taking ANY_VALUE on bk_* and summing
 * p_live_* per booking.
 */
import { createServerFn } from "@tanstack/react-start";

export interface CommissionPartnerLine {
  partner_name: string | null;
  venue_name: string | null;
  partner_currency: string | null;
  /** Partner GMV HT in partner currency */
  gmv_ht: number | null;
  /** Commission HT in partner currency (p_live_commission_ht_pcurrency) */
  commission_ht: number | null;
  /** Effective commission rate = commission / gmv, derived */
  commission_rate: number | null;
  /** Category rates as stored (may all be the same, or differ) */
  rate_house: number | null;
  rate_food: number | null;
  rate_activity: number | null;
  /** Whether the amounts match the expected rate (flag from RM) */
  mismatch: boolean;
  /** Individual outflow payments made to this partner, date + amount in partner currency */
  disbursements: Array<{ amount: number; date: string }>;
  /** Amounts for refund detection */
  /** Gross GMV TTC in partner currency — used as "amount due per invoice" */
  /** Gross TTC = net_gmv_ttc + commission_ttc — the invoice amount before commission deduction */
  gmv_ttc: number | null;
  commission_ttc: number | null;
  disbursed_total: number | null;
  /** Negative = overpaid */
  outstanding_payable: number | null;
  deposit_net_payable: number | null;
  deposit_payment_date: string | null;
  /** Primary contact for this partner line */
  owner_email: string | null;
  owner_full_name: string | null;
  /** Fallback contact used when owner_email is missing */
  service_owner_email: string | null;
}

export interface CommissionRow {
  readable_id: string | null;
  company_name: string | null;
  event_name: string | null;
  event_type: string | null;
  start_date: string | null;
  end_date: string | null;
  billing_entity: string | null;
  /** Client currency (what the client paid in) */
  currency_client: string | null;
  /** Total booking GMV HT in client currency */
  gross_gmv_ht: number | null;
  /** Total booking commission HT in client currency */
  total_commission_ht: number | null;
  /** Commission as % of GMV (derived) */
  effective_rate: number | null;
  /** Booking URL in admin */
  booking_url: string | null;
  em_referent: string | null;
  sales_referent: string | null;
  partners: CommissionPartnerLine[];
}

const QUERY = `
WITH base AS (
  SELECT
    rm.client_request_readable_id            AS readable_id,
    ANY_VALUE(rm.company_name)               AS company_name,
    ANY_VALUE(rm.event_name)                 AS event_name,
    ANY_VALUE(rm.event_type)                 AS event_type,
    ANY_VALUE(CAST(rm.start_date AS STRING)) AS start_date,
    ANY_VALUE(CAST(rm.end_date   AS STRING)) AS end_date,
    ANY_VALUE(rm.billing_entity)             AS billing_entity,
    ANY_VALUE(rm.currency_client)            AS currency_client,
    ANY_VALUE(rm.bk_live_gross_gmv_ht_clcurrency)       AS gross_gmv_ht,
    ANY_VALUE(rm.bk_live_total_commissions_ht_clcurrency) AS total_commission_ht,
    ANY_VALUE(rm.booking_url)                AS booking_url,
    ANY_VALUE(rm.em_referent)                AS em_referent,
    ANY_VALUE(rm.sales_referent)             AS sales_referent,
    ARRAY_AGG(STRUCT(
      rm.partner_name               AS partner_name,
      rm.venue_name                 AS venue_name,
      rm.currency_partner           AS partner_currency,
      rm.p_live_net_gmv_ht_pcurrency    AS gmv_ht,
      rm.p_live_commission_ht_pcurrency AS commission_ht,
      SAFE_DIVIDE(rm.p_live_commission_ht_pcurrency, rm.p_live_net_gmv_ht_pcurrency) AS commission_rate,
      SAFE_CAST(rm.p_rate_house       AS FLOAT64) AS rate_house,
      SAFE_CAST(rm.p_rate_restauration AS FLOAT64) AS rate_food,
      SAFE_CAST(rm.p_rate_activity    AS FLOAT64) AS rate_activity,
      rm.p_commission_mismatch          AS mismatch,
      CAST(rm.p_live_net_gmv_ttc_pcurrency AS FLOAT64)       AS gmv_ttc,
      CAST(rm.p_live_commission_ttc_pcurrency AS FLOAT64)    AS commission_ttc,
      CAST(rm.p_disbursed_total_pcurrency AS FLOAT64)       AS disbursed_total,
      CAST(rm.p_outstanding_payable_pcurrency AS FLOAT64)   AS outstanding_payable,
      CAST(rm.partner_deposit_net_payable_pcurrency AS FLOAT64) AS deposit_net_payable,
      CAST(rm.deposit_payment_date AS STRING)               AS deposit_payment_date,
      rm.owner_email                    AS owner_email,
      rm.owner_full_name                AS owner_full_name,
      rm.service_owner_email            AS service_owner_email,
      IFNULL(pymts.disbursements, [])   AS disbursements
    ) ORDER BY rm.p_live_commission_ht_pcurrency DESC) AS partners
  FROM \`naboo-app-365515.finance_gld_vw_prd.vw_reconciliation_master\` rm
  LEFT JOIN (
    SELECT
      p.client_request_id,
      p.host_id,
      ARRAY_AGG(STRUCT(
        ROUND(p.amount / 10000, 2) AS amount,
        FORMAT_DATETIME('%Y-%m-%d', p.date) AS date
      ) ORDER BY p.date) AS disbursements
    FROM \`naboo-app-365515.raw_naboo_data.payments\` p
    WHERE p.kind = 'HOST_PAYMENT'
      AND p.flow = 'OUTFLOW_PAYMENT'
      AND p.deleted = FALSE
    GROUP BY p.client_request_id, p.host_id
  ) pymts
    ON pymts.client_request_id = rm.client_request_id
   AND pymts.host_id = rm.house_mongo_id
  WHERE rm.bk_market = 'North America'
    AND rm.is_current_proposal_phase_quote = TRUE
    AND rm.booking_status = 'ACCEPTED'
  GROUP BY rm.client_request_readable_id
)
SELECT
  readable_id,
  company_name,
  event_name,
  event_type,
  start_date,
  end_date,
  billing_entity,
  currency_client,
  gross_gmv_ht,
  total_commission_ht,
  ROUND(SAFE_DIVIDE(total_commission_ht, gross_gmv_ht) * 100, 2) AS effective_rate,
  booking_url,
  em_referent,
  sales_referent,
  partners
FROM base
ORDER BY start_date DESC NULLS LAST, readable_id DESC
`;

export const getCommissionRows = createServerFn({ method: "GET" }).handler(
  async (): Promise<CommissionRow[]> => {
    const { requireTracker } = await import("./session.server");
    await requireTracker("na");
    const { runBigQuery } = await import("./bigquery.server");
    const rows = await runBigQuery(QUERY);
    return (rows as unknown as CommissionRow[]).map((r) => ({
      ...r,
      gross_gmv_ht: r.gross_gmv_ht != null ? Number(r.gross_gmv_ht) : null,
      total_commission_ht: r.total_commission_ht != null ? Number(r.total_commission_ht) : null,
      effective_rate: r.effective_rate != null ? Number(r.effective_rate) : null,
      partners: Array.isArray(r.partners)
        ? r.partners.map((p) => ({
            ...p,
            gmv_ht: p.gmv_ht != null ? Number(p.gmv_ht) : null,
            commission_ht: p.commission_ht != null ? Number(p.commission_ht) : null,
            commission_rate: p.commission_rate != null ? Number(p.commission_rate) : null,
          }))
        : [],
    }));
  },
);
