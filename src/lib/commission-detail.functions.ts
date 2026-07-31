/**
 * Per-provider commission detail: what we paid out, and which services carry a
 * commission. Fetched on demand, one booking at a time.
 *
 * This used to live in the main Marketplace NA query as two extra CTEs, embedding
 * an array per partner of every booking. Neither is needed to render the list or
 * the detail pane — they exist for the recovery emails and the commission
 * statement, both of which act on one booking and one provider — and
 * `client_pricing_items` alone is a ~109 MB scan, by a wide margin the heaviest
 * table in that query. Every page load paid for all 269 bookings' worth of it.
 *
 * So it is asked for when a partner card is opened or an email is composed. The
 * same scan costs the same once, instead of on every visit to the page.
 */
import { createServerFn } from "@tanstack/react-start";

export type NaDisbursement = {
  amount: number | null;
  currency: string | null;
  /** dd/mm/yy, as recorded in the bank feed. */
  paid_on: string | null;
  /** Derived from the label — see the disbursements CTE. */
  method: "card" | "wire" | null;
  reference: string | null;
};

/**
 * One commissionable service line.
 *
 * `base_ht` is quantity × unit price, which the CTE this replaces did not do: it
 * summed the *unit* prices, so Hyatt's 297 nights at 169.00 came out as a
 * commissionable base of 338.00 against a real 50,193.00 — a figure the recovery
 * email printed next to a commission of 3,513.51 it could not possibly imply.
 */
export type NaCommissionableItem = {
  label: string | null;
  /** Quantity × unit price, excluding tax. */
  base_ht: number | null;
  qty: number | null;
  unit: string | null;
  unit_excl_tax: number | null;
  /** Percentage, e.g. 7 for 7%. */
  rate_pct: number | null;
};

/** One provider on one booking. */
export type NaCommissionDetail = {
  event_ref: string;
  house_code: string;
  disbursements: NaDisbursement[];
  commissionable: NaCommissionableItem[];
  /** Sum of every candidate line — before the reconciliation picks a subset. */
  commissionable_base_ht: number;
  /** The commission finance holds for this provider, as recorded. */
  commission_ht: number | null;
  commission_ttc: number | null;
};

/** Key an index of details by the pair that identifies a provider line. */
export function commissionDetailKey(eventRef: string, houseCode: string | null): string {
  return `${eventRef}::${houseCode ?? ""}`;
}

export function indexCommissionDetail(rows: NaCommissionDetail[]): Map<string, NaCommissionDetail> {
  const map = new Map<string, NaCommissionDetail>();
  for (const r of rows) map.set(commissionDetailKey(r.event_ref, r.house_code), r);
  return map;
}

/** More than a chase round would ever cover, and it bounds the query. */
export const MAX_DETAIL_BOOKINGS = 60;

const QUERY = `
WITH keys AS (
  SELECT ref FROM UNNEST(JSON_VALUE_ARRAY(@refs)) AS ref
),
-- The provider lines of the requested bookings, and the quote each one hangs off.
prov AS (
  SELECT
    rm.client_request_readable_id AS rid,
    h.readable_id                 AS house_code,
    ANY_VALUE(rm.quote_id)          AS quote_id,
    ANY_VALUE(rm.client_request_id) AS crid,
    ANY_VALUE(rm.house_mongo_id)    AS house_id,
    ANY_VALUE(ROUND(CAST(rm.p_live_commission_ht_pcurrency AS FLOAT64), 2))  AS commission_ht,
    ANY_VALUE(ROUND(CAST(rm.p_live_commission_ttc_pcurrency AS FLOAT64), 2)) AS commission_ttc
  FROM \`naboo-app-365515.finance_gld_vw_prd.vw_reconciliation_master\` rm
  JOIN keys k ON k.ref = rm.client_request_readable_id
  JOIN \`naboo-app-365515.raw_naboo_data.houses\` h ON h.house_id = rm.house_mongo_id
  WHERE rm.is_current_proposal_phase_quote = TRUE
    AND rm.booking_status = 'ACCEPTED'
  GROUP BY rid, house_code
),
-- Every payment we made to a provider, for the recovery emails.
--
-- Card vs wire is not stored: provider_payload_kind is PENNYLANE on both, because
-- it says where the bank feed came from, not how we paid. The signature is in the
-- label — an MCC between pipes, or two bare codes joined by a slash — a rule that
-- classifies all North American host payments with nothing left over. It parses a
-- bank feed format, so it will degrade silently if that format changes: see
-- paymentMethodFromLabel and its tests.
disbursements AS (
  SELECT
    p.client_request_id AS crid,
    p.house_id AS house_id,
    ARRAY_AGG(STRUCT(
      CAST(ROUND(p.amount / 10000, 2) AS FLOAT64) AS amount,
      p.currency AS currency,
      FORMAT_DATETIME('%d/%m/%y', p.date) AS paid_on,
      IF(
        REGEXP_CONTAINS(IFNULL(p.provider_payload_label, ''), r'\\|\\s*\\d{4}\\s*\\|')
          OR REGEXP_CONTAINS(
               IFNULL(p.provider_payload_label, ''),
               r'\\b[HCO]-[A-Za-z0-9]+\\s*/\\s*[HCO]-[A-Za-z0-9]+\\b'),
        'card', 'wire'
      ) AS method,
      COALESCE(
        REGEXP_EXTRACT(p.provider_payload_label, r'reference:\\s*([^|]+?)\\s*\\|\\s*id:'),
        REGEXP_EXTRACT(p.provider_payload_label, r'reference:\\s*(.+)$'),
        p.provider_payload_label
      ) AS reference
    ) ORDER BY p.date) AS items
  FROM \`naboo-app-365515.raw_naboo_data.payments\` p
  WHERE p.deleted = FALSE
    AND p.kind = 'HOST_PAYMENT'
    AND p.flow = 'OUTFLOW_PAYMENT'
    AND p.client_request_id IN (SELECT crid FROM prov)
  GROUP BY crid, p.house_id
),
-- Commissionable lines and their rate, one line per pricing option.
--
-- The dedup key is the option's own id, not its values. There are no duplicate
-- *rows* in this table at all (3,418 commissionable rows on North American
-- bookings, 3,418 distinct pricing_item_id) — what repeats is the option: one
-- option_price_id carries a row per night and, per night, a row per revision. So
-- SELECT DISTINCT on (label, quantity, price, rate) merged whatever happened to
-- look alike: on C-P222's Hyatt quote it turned five separate nights of "ROH
-- Default - Single room" into two, purely because their figures matched.
--
-- Measured against the reconciliation invariant across the 203 North American
-- provider lines that carry a commission, this key takes the number whose services
-- reproduce the recorded commission from 87 to 111, and loses none.
--
-- Two details that are load-bearing:
--   * option_price_id is NULL on 248 rows, and grouping those together would merge
--     genuinely separate lines — hence the fallback to the row's own id.
--   * the values come off ONE row (the latest revision) rather than from a column's
--     worth of ANY_VALUE each: 149 option groups hold rows that disagree, and
--     independent ANY_VALUEs can pair a quantity from one revision with a price
--     from another, producing a base that never existed.
--
-- The rate leaves here raw and is converted in TypeScript by ratePctFromStored,
-- so the scale lives in exactly one tested place: it is a percentage scaled by
-- 10,000, and dividing by 1,000 instead once printed "70%" for a 7% commission in
-- an email to the provider being billed.
commissionable AS (
  SELECT
    quote_id,
    ARRAY_AGG(STRUCT(label, base_ht, qty, unit, unit_excl_tax, rate_raw)
              ORDER BY base_ht DESC, label) AS items,
    ROUND(SUM(base_ht), 2) AS base_total_ht
  FROM (
    SELECT
      quote_id,
      pick.label AS label,
      pick.qty   AS qty,
      pick.unit  AS unit,
      ROUND(pick.unit_ht / 10000, 2) AS unit_excl_tax,
      -- Quantity × unit price: the line total the commission is charged on.
      ROUND(pick.qty * pick.unit_ht / 10000, 2) AS base_ht,
      pick.rate_raw AS rate_raw
    FROM (
      SELECT
        cpi.quote_id AS quote_id,
        ARRAY_AGG(STRUCT(
          cpi.object_data_label AS label,
          SAFE_CAST(cpi.price_option_quantity AS FLOAT64) AS qty,
          cpi.object_data_prices_unit AS unit,
          cpi.object_data_prices_price_base_price_price_without_vat AS unit_ht,
          CAST(cpi.price_option_fees_owner_fees_rate AS FLOAT64) AS rate_raw
        ) ORDER BY cpi.updated_at DESC, cpi.pricing_item_id DESC LIMIT 1)[OFFSET(0)] AS pick
      FROM \`naboo-app-365515.raw_naboo_data.client_pricing_items\` cpi
      WHERE cpi.quote_id IN (SELECT quote_id FROM prov)
        AND cpi.type != 'OWNER_FEES'
        AND IFNULL(cpi.price_option_fees_owner_fees_rate, 0) > 0
        AND cpi.object_data_label IS NOT NULL
        -- A line with no unit price or no quantity has no base: it cannot carry a
        -- commission, and left in it lands in the reconciled subset contributing
        -- nothing but a second copy of its own name (C-P222 carries an unpriced
        -- "Game Show" beside the priced one).
        AND IFNULL(cpi.object_data_prices_price_base_price_price_without_vat, 0) > 0
        AND IFNULL(SAFE_CAST(cpi.price_option_quantity AS FLOAT64), 0) > 0
      GROUP BY quote_id, COALESCE(cpi.option_price_id, cpi.pricing_item_id)
    )
  )
  GROUP BY quote_id
)
SELECT
  prov.rid AS event_ref,
  prov.house_code,
  prov.commission_ht,
  prov.commission_ttc,
  IFNULL(cm.base_total_ht, 0) AS commissionable_base_ht,
  TO_JSON_STRING(IFNULL(d.items, CAST([] AS ARRAY<STRUCT<
    amount FLOAT64, currency STRING, paid_on STRING, method STRING, reference STRING
  >>))) AS disbursements_json,
  TO_JSON_STRING(IFNULL(cm.items, CAST([] AS ARRAY<STRUCT<
    label STRING, base_ht FLOAT64, qty FLOAT64, unit STRING,
    unit_excl_tax FLOAT64, rate_raw FLOAT64
  >>))) AS commissionable_json
FROM prov
LEFT JOIN disbursements d ON d.crid = prov.crid AND d.house_id = prov.house_id
LEFT JOIN commissionable cm ON cm.quote_id = prov.quote_id
`;

function parseJsonArray<T>(json: unknown): T[] {
  if (typeof json !== "string" || !json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export const getCommissionDetail = createServerFn({ method: "POST" })
  .validator((input: { event_refs: string[] }) => {
    const refs = [...new Set((input?.event_refs ?? []).map((r) => String(r).trim().toUpperCase()))]
      .filter((r) => /^[A-Z]-[A-Z0-9]{2,12}$/.test(r))
      .slice(0, MAX_DETAIL_BOOKINGS);
    if (refs.length === 0) throw new Error("No booking reference to look up");
    return { event_refs: refs };
  })
  .handler(async ({ data }): Promise<NaCommissionDetail[]> => {
    // Financial data: same gate as every other query on this tracker.
    const { requireTracker } = await import("./session.server");
    await requireTracker("na");

    const { runBigQuery } = await import("./bigquery.server");
    const { ratePctFromStored } = await import("./commission-statement.ts");

    const rows = (await runBigQuery(QUERY, {
      refs: JSON.stringify(data.event_refs),
    })) as unknown as Array<Record<string, string | number | null>>;

    return rows
      .filter((r) => r.event_ref && r.house_code)
      .map((r) => ({
        event_ref: String(r.event_ref),
        house_code: String(r.house_code),
        disbursements: parseJsonArray<NaDisbursement>(r.disbursements_json),
        commissionable: parseJsonArray<{
          label: string | null;
          base_ht: number | null;
          qty: number | null;
          unit: string | null;
          unit_excl_tax: number | null;
          rate_raw: number | null;
        }>(r.commissionable_json).map((c) => ({
          label: c.label ?? null,
          base_ht: c.base_ht == null ? null : Number(c.base_ht),
          qty: c.qty == null ? null : Number(c.qty),
          unit: c.unit ?? null,
          unit_excl_tax: c.unit_excl_tax == null ? null : Number(c.unit_excl_tax),
          rate_pct: ratePctFromStored(c.rate_raw),
        })),
        commissionable_base_ht: Number(r.commissionable_base_ht ?? 0),
        commission_ht: r.commission_ht == null ? null : Number(r.commission_ht),
        commission_ttc: r.commission_ttc == null ? null : Number(r.commission_ttc),
      }));
  });
