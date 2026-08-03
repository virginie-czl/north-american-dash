/**
 * The provider list behind Card tracking NA: every service provider we have an
 * accepted North American booking with.
 *
 * The query returns one row per provider **quote**, not per provider and not per
 * booking, and the aggregation to one row per provider happens in TypeScript. Two
 * reasons, both measured:
 *
 *  - The reconciliation master repeats a quote (847 raw rows for 609 owner/quote
 *    pairs), so summing rows double-counts. The quote is the grain that holds: no
 *    quote in this data carries two different amounts, two currencies or two
 *    bookings.
 *  - The amounts are multi-currency — USD, CAD, EUR and IDR, with 281,000,000 IDR on
 *    a single BizAway booking — so a SQL `SUM` across them would produce a figure
 *    that means nothing. Each provider keeps a map of currency to amount instead.
 */
import { createServerFn } from "@tanstack/react-start";
import type { CardProvider, CardQuoteRow } from "./card-tracking";

const QUERY = `
-- One row per provider quote on an accepted North American booking.
--
-- GROUP BY rather than SELECT DISTINCT: the view emits the same quote several times
-- over, and DISTINCT only collapses rows that match on every selected column — two
-- genuinely different quotes with the same amount would survive it while two copies
-- of one quote differing in an unselected column would not.
SELECT
  o.readable_id AS owner_code,
  rm.quote_id   AS quote_id,
  ANY_VALUE(rm.client_request_readable_id) AS event_ref,
  ANY_VALUE(COALESCE(
    NULLIF(o.company_name, ''),
    NULLIF(rm.venue_name, ''),
    NULLIF(rm.partner_name, '')
  )) AS provider_name,
  ANY_VALUE(NULLIF(rm.venue_name, ''))   AS venue_name,
  ANY_VALUE(NULLIF(rm.partner_name, '')) AS partner_name,
  ANY_VALUE(o.country_iso_code) AS country,
  ANY_VALUE(NULLIF(o.email, '')) AS email,
  ANY_VALUE(rm.currency_partner) AS currency,
  ANY_VALUE(CAST(rm.p_outstanding_payable_pcurrency AS FLOAT64)) AS outstanding,
  -- The most recent SCD1 row wins; the date only feeds "most recent booking".
  MAX(CAST(e.start_date AS STRING)) AS start_date,
  -- Carried for display only. 435 of the 447 providers here are CREDIT_CARD, which
  -- is the method we intend to use — never evidence that the provider accepts one.
  ANY_VALUE(rm.partner_payment_method) AS payment_method,
  -- HOTEL, ACTIVITY, TRANSPORT… The one classification this data carries, and half of
  -- what identifies an airline: see isAirline in card-tracking.ts. Aggregated per
  -- provider in TypeScript, because a provider can be booked under several.
  ANY_VALUE(rm.venue_type) AS venue_type
FROM \`naboo-app-365515.finance_gld_vw_prd.vw_reconciliation_master\` rm
JOIN \`naboo-app-365515.finance_gld_fct_prd.fct_export_events_scd1\` e
  ON e.client_request_readable_id = rm.client_request_readable_id
LEFT JOIN \`naboo-app-365515.raw_naboo_data.owners\` o ON o.owner_id = rm.house_owner_id
WHERE e.bk_market = 'North America'
  AND e.booking_status = 'ACCEPTED'
  AND rm.is_current_proposal_phase_quote = TRUE
  AND o.readable_id IS NOT NULL
GROUP BY owner_code, quote_id
`;

const CACHE_KEY = "na-card-providers";

export const getCardProviders = createServerFn({ method: "GET" })
  .validator((input?: { force?: boolean }) => ({ force: input?.force === true }))
  .handler(
    async ({ data }): Promise<{ providers: CardProvider[]; cachedAgeSeconds: number | null }> => {
      // Financial data: same gate as every other query in this repo.
      const { requireTracker } = await import("./session.server");
      await requireTracker("na-cards");

      const { readCache, writeCache, cacheAge } = await import("./query-cache.server");
      if (!data.force) {
        const hit = await readCache<CardProvider[]>(CACHE_KEY);
        if (hit) return { providers: hit, cachedAgeSeconds: await cacheAge(CACHE_KEY) };
      }

      const { runBigQuery } = await import("./bigquery.server");
      const { aggregateProviders } = await import("./card-tracking");
      const rows = (await runBigQuery(QUERY)) as unknown as CardQuoteRow[];
      const providers = aggregateProviders(rows);
      await writeCache(CACHE_KEY, providers);
      return { providers, cachedAgeSeconds: 0 };
    },
  );
