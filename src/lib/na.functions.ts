import { createServerFn } from "@tanstack/react-start";

export interface NaPartnerLine {
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
  commission: number | null;
  locked: boolean | null;
  locked_by_admin: boolean | null;
  locked_by_client: boolean | null;
  locked_by_owner: boolean | null;
  is_provision: boolean | null;
  payment_method: string | null;
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
  participants: number | null;
  billing_entity: string | null;
  booking_url: string | null;
  gmv_client_ccy: number | null;
  gmv_client_eur: number | null;
  invoiced_ccy: number | null;
  paid_ccy: number | null;
  balance_ccy: number | null;
  partners_json: string | null;
}

const QUERY = `
WITH
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
    rm.currency_partner AS currency,
    CAST(rm.p_live_net_gmv_ttc_pcurrency AS FLOAT64) AS gmv_ttc,
    CAST(rm.p_disbursed_total_pcurrency AS FLOAT64) AS paid,
    -- 'BALANCE' proposals can have a null deposit-payable figure even when a
    -- real live-payable figure exists (seen in practice) — fall back to it
    -- rather than losing the number.
    CAST(
      COALESCE(
        CASE
          WHEN rm.proposal_payment_type = 'BALANCE_POST_FINAL' THEN rm.p_live_net_payable_pcurrency
          WHEN rm.proposal_payment_type = 'BALANCE'            THEN COALESCE(rm.partner_deposit_net_payable_pcurrency, rm.p_live_net_payable_pcurrency)
          ELSE rm.p_live_net_payable_pcurrency
        END, 0
      ) - COALESCE(rm.p_disbursed_total_pcurrency, 0)
    AS FLOAT64) AS outstanding,
    CAST(rm.p_outstanding_payable_pcurrency AS FLOAT64) AS raw_outstanding,
    CAST(
      CASE
        WHEN rm.proposal_payment_type = 'BALANCE_POST_FINAL' THEN rm.p_live_net_payable_pcurrency
        WHEN rm.proposal_payment_type = 'BALANCE'            THEN COALESCE(rm.partner_deposit_net_payable_pcurrency, rm.p_live_net_payable_pcurrency)
        ELSE rm.p_live_net_payable_pcurrency
      END AS FLOAT64
    ) AS payable,
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
  WHERE rm.is_current_proposal_phase_quote = TRUE
    AND rm.booking_status = 'ACCEPTED'
),
partners_rm AS (
  SELECT
    rid,
    ARRAY_AGG(STRUCT(
      name, email, contact_first_name, currency, gmv_ttc, paid, outstanding, raw_outstanding,
      payable, commission, locked, locked_by_admin, locked_by_client, locked_by_owner,
      is_provision, payment_method,
      CAST(NULL AS STRING) AS vat_raw,
      CAST(NULL AS STRING) AS tax_identifier,
      CAST(NULL AS STRING) AS country
    )) AS items
  FROM partners_rm_dedup
  GROUP BY rid
)
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
  e.participants,
  e.billing_entity,
  e.booking_url,
  COALESCE(CAST(e.live_gross_gmv_ttc_clcurrency AS FLOAT64), fi.gmv) AS gmv_client_ccy,
  CAST(e.live_gross_gmv_ttc_eur AS FLOAT64) AS gmv_client_eur,
  CAST(ar.total_invoiced_ccy AS FLOAT64) AS invoiced_ccy,
  COALESCE(CAST(ar.total_paid_client_ccy AS FLOAT64), fi.paid) AS paid_ccy,
  COALESCE(
    CAST(ar.balance_client_ccy AS FLOAT64),
    CASE WHEN fi.gmv IS NOT NULL THEN ROUND(COALESCE(fi.gmv, 0) - COALESCE(fi.paid, 0), 2) END
  ) AS balance_ccy,
  TO_JSON_STRING(
    IFNULL(p.items, CAST([] AS ARRAY<STRUCT<
      name STRING, email STRING, contact_first_name STRING, currency STRING, gmv_ttc FLOAT64, paid FLOAT64,
      outstanding FLOAT64, raw_outstanding FLOAT64, payable FLOAT64, commission FLOAT64,
      locked BOOL, locked_by_admin BOOL, locked_by_client BOOL, locked_by_owner BOOL,
      is_provision BOOL, payment_method STRING, vat_raw STRING, tax_identifier STRING, country STRING
    >>))
  ) AS partners_json
FROM \`naboo-app-365515.finance_gld_fct_prd.fct_export_events_scd1\` e
LEFT JOIN \`naboo-app-365515.finance_gld_vw_prd.vw_balance_agee_ar\` ar
  ON ar.readable_id = e.client_request_readable_id
LEFT JOIN fi_base fi ON fi.crid = e.clientRequestId
LEFT JOIN partners_rm p ON p.rid = e.client_request_readable_id
WHERE e.bk_market = 'North America'
  AND e.booking_status = 'ACCEPTED'
ORDER BY e.start_date DESC NULLS LAST
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
  const byCcy = new Map<string, { gmv: number; paid: number; outstanding: number; payable: number; commission: number }>();
  for (const p of partners) {
    if (p.is_provision) continue;
    const c = p.currency ?? "—";
    const cur = byCcy.get(c) ?? { gmv: 0, paid: 0, outstanding: 0, payable: 0, commission: 0 };
    cur.gmv += p.gmv_ttc ?? 0;
    cur.paid += p.paid ?? 0;
    cur.outstanding += p.outstanding ?? 0;
    cur.payable += p.payable ?? 0;
    cur.commission += p.commission ?? 0;
    byCcy.set(c, cur);
  }
  return byCcy;
}
