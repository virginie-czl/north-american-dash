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

export type NaCommissionableItem = {
  label: string | null;
  base_ht: number | null;
  /** Percentage, e.g. 7 for 7%. */
  rate_pct: number | null;
};

export interface NaPartnerLine {
  /** Owner code (O-XXXX) — matches credit-card approvals in #finance-paiement-by-card. */
  owner_code: string | null;
  /** Every payment we made to this provider on this booking. */
  disbursements: NaDisbursement[] | null;
  /** The lines a commission is applied to, and its rate. */
  commissionable: NaCommissionableItem[] | null;
  /** Sum of the commissionable lines, before tax. */
  commissionable_base_ht: number | null;
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
  invoice_id: string | null;
  invoice_ref: string | null;
  /** CLIENT for documents billed to the client, PARTNER for our commission notes. */
  party: string | null;
  /** INVOICE or CREDIT_NOTE. */
  doc_kind: string | null;
  status: string | null;
  currency: string | null;
  amount_ttc: number | null;
  emission_date: string | null;
  due_date: string | null;
  is_sent: boolean | null;
  /** The invoice this credit note reverses, when it reverses one. */
  cancels_invoice_id: string | null;
  pdf_url: string | null;
  /** The Naboo entity that issued it, e.g. "NABOO US Inc." */
  seller_name: string | null;
  /** The address the invoice was addressed to, when recorded. */
  buyer_email: string | null;
  /** BANK_TRANSFER, CARD… — how this invoice asks to be settled. */
  payment_means: string | null;
  /** The receiving account as printed on this very invoice. */
  bank_details: string | null;
}

/** One receipt of client cash on a booking, for the recovery email's ledger. */
export type NaClientReceipt = {
  amount: number | null;
  currency: string | null;
  /** ISO date. */
  paid_on: string | null;
  /** Derived from the provider — see the client_receipts CTE. */
  method: string | null;
  reference: string | null;
};

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
  /** Our service charge billed to the client, TTC. */
  client_service_fees_ttc: number | null;
  paid_ccy: number | null;
  balance_ccy: number | null;
  partners_json: string | null;
  invoices_json: string | null;
  /** Every euro/dollar of client cash received on the booking, itemised. */
  client_receipts_json: string | null;
  /** Who to write to about the money: the booking's client contact. */
  client_contact_email: string | null;
  client_contact_name: string | null;
}

const QUERY = `
WITH
-- Disbursements to each provider, for the recovery emails.
--
-- Card vs wire is not stored: provider_payload_kind is PENNYLANE on both, because
-- it says where the bank feed came from, not how we paid. The signature is in the
-- label — an MCC between pipes, or two bare codes joined by a slash — a rule that
-- classifies all 865 North American host payments with nothing left over.
-- It parses a bank feed format, so it will degrade silently if that format
-- changes: see paymentMethodFromLabel and its tests.
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
  GROUP BY crid, p.house_id
),
-- Commissionable lines and their rate. The table holds duplicate rows per item,
-- hence the DISTINCT before aggregating.
--
-- The rate is a percentage scaled by 10,000: 70000 is 7%, 120000 is 12%. Across
-- the whole table the values are 120000 (12%, by far the commonest), 100000,
-- 150000, 80000 and the like, down to 70500 for 7.05% — which is the commission
-- model, 12% by default and negotiable up to 15%. Dividing by 1,000 instead read
-- 120% and put that figure in an email to the provider it was billed to.
commissionable AS (
  SELECT
    quote_id,
    ARRAY_AGG(STRUCT(label, base_ht, rate_pct) ORDER BY base_ht DESC) AS items,
    ROUND(SUM(base_ht), 2) AS base_total_ht
  FROM (
    SELECT DISTINCT
      cpi.quote_id AS quote_id,
      cpi.object_data_label AS label,
      ROUND(cpi.object_data_prices_price_base_price_price_without_vat / 10000, 2) AS base_ht,
      ROUND(cpi.price_option_fees_owner_fees_rate / 10000, 2) AS rate_pct
    FROM \`naboo-app-365515.raw_naboo_data.client_pricing_items\` cpi
    WHERE cpi.type != 'OWNER_FEES'
      AND IFNULL(cpi.price_option_fees_owner_fees_rate, 0) > 0
      AND cpi.object_data_label IS NOT NULL
  )
  GROUP BY quote_id
),
client_invoices AS (
  SELECT
    inv.clientRequestId AS crid,
    ARRAY_AGG(STRUCT(
      inv.invoice_id    AS invoice_id,
      inv.invoiceNumber AS invoice_ref,
      -- CLIENT vs PARTNER: an INCOME document can also be our own commission note
      -- to a provider. The client recovery email must never list one of those, so
      -- the distinction travels with the row rather than being filtered away here.
      inv.kind          AS party,
      inv.invoiceKind   AS doc_kind,
      inv.status        AS status,
      inv.currency      AS currency,
      CAST(ROUND(inv.totals.totalamountincludingtaxes.amount / 100, 2) AS FLOAT64) AS amount_ttc,
      CAST(inv.issueDate AS STRING) AS emission_date,
      CAST(inv.dueDate   AS STRING) AS due_date,
      (COALESCE(ARRAY_LENGTH(JSON_EXTRACT_ARRAY(inv.send_events)), 0) > 0) AS is_sent,
      -- Credit notes point back at the invoice they reverse. That link is what
      -- lets a document and its reversal be recognised as a pair that nets to
      -- nothing, instead of being chased as two live figures.
      inv.cancelledInvoiceId AS cancels_invoice_id,
      inv.pdfUrl AS pdf_url,
      inv.seller.legalName AS seller_name,
      NULLIF(inv.buyer.email, '') AS buyer_email,
      inv.payment.means AS payment_means,
      -- The receiving account as printed on this very invoice: the one figure the
      -- client can check against the document in their own hands. Entities hold
      -- several accounts, so it is carried per invoice, never per entity.
      NULLIF(ARRAY_TO_STRING([
        NULLIF(TRIM(IFNULL(inv.payment.bankAccount.accountHolderName, '')), ''),
        IF(inv.payment.bankAccount.iban IS NOT NULL,
           CONCAT('IBAN ', inv.payment.bankAccount.iban), NULL),
        IF(inv.payment.bankAccount.iban IS NULL AND inv.payment.bankAccount.bankAccountNumber IS NOT NULL,
           CONCAT('account ', inv.payment.bankAccount.bankAccountNumber), NULL),
        IF(inv.payment.bankAccount.bic IS NOT NULL,
           CONCAT('BIC ', inv.payment.bankAccount.bic), NULL),
        IF(inv.payment.bankAccount.iban IS NULL AND inv.payment.bankAccount.sortCode IS NOT NULL,
           CONCAT('sort code ', inv.payment.bankAccount.sortCode), NULL)
      ], ' · '), '') AS bank_details
    ) ORDER BY inv.issueDate) AS items
  FROM \`naboo-app-365515.raw_naboo_data.invoices\` inv
  WHERE inv.invoiceDirection = 'INCOME'
  GROUP BY crid
),
-- Client cash received, itemised, for the recovery email's "Payments received".
--
-- COMPANY_PAYMENT and MANUAL_PAYMENT inflows together reproduce
-- client_request_free_invoicing.collectedTotal to the cent on every booking
-- checked (C-O621: 45 183,33 + 2 508,69 + 1 114,98 + 26 975,12 + 43 834,29 =
-- 119 616,41), which is the figure the tracker already shows as Received — so the
-- itemised list in the email always adds up to the total next to it.
--
-- Inflows only. Outflows on the same kinds are not client refunds netted out of
-- that total (bookings exist with a zero collected total and a non-zero outflow),
-- and counting them would make the listed payments disagree with the total.
client_receipts AS (
  SELECT
    p.client_request_id AS crid,
    ARRAY_AGG(STRUCT(
      CAST(ROUND(p.amount / 10000, 2) AS FLOAT64) AS amount,
      p.currency AS currency,
      CAST(DATE(p.date) AS STRING) AS paid_on,
      CASE p.provider_payload_kind
        WHEN 'STRIPE' THEN 'card'
        WHEN 'MANUAL' THEN 'recorded manually'
        ELSE 'bank transfer'
      END AS method,
      -- Bank feeds put the useful part after "reference:", Stripe after "email :".
      -- Labels carry embedded newlines, hence the whitespace squeeze.
      NULLIF(TRIM(REGEXP_REPLACE(COALESCE(
        REGEXP_EXTRACT(p.provider_payload_label, r'reference:\\s*([^|;]+)'),
        REGEXP_EXTRACT(p.provider_payload_label, r'email\\s*:\\s*(\\S+)'),
        p.provider_payload_label
      ), r'\\s+', ' ')), '') AS reference
    ) ORDER BY p.date) AS items
  FROM \`naboo-app-365515.raw_naboo_data.payments\` p
  WHERE p.deleted = FALSE
    AND p.kind IN ('COMPANY_PAYMENT', 'MANUAL_PAYMENT')
    AND p.flow = 'INFLOW_PAYMENT'
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
      AS invoiced_ttc,
    -- Our service charge to the client. It is revenue, not money held on behalf
    -- of the providers, so it is taken out of the cash available to pay them.
    ROUND(SUM(IF(li.line_type = 'FEE_CLIENT', li.total_incl_taxes, 0)) / 100, 2)
      AS client_service_fees_ttc
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
    IFNULL(d.items, CAST([] AS ARRAY<STRUCT<
      amount FLOAT64, currency STRING, paid_on STRING, method STRING, reference STRING
    >>)) AS disbursements,
    IFNULL(cm.items, CAST([] AS ARRAY<STRUCT<
      label STRING, base_ht FLOAT64, rate_pct FLOAT64
    >>)) AS commissionable,
    IFNULL(cm.base_total_ht, 0) AS commissionable_base_ht,
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
  LEFT JOIN disbursements d
    ON d.crid = rm.client_request_id AND d.house_id = rm.house_mongo_id
  LEFT JOIN commissionable cm ON cm.quote_id = rm.quote_id
  WHERE rm.is_current_proposal_phase_quote = TRUE
    AND rm.booking_status = 'ACCEPTED'
),
partners_rm AS (
  SELECT
    rid,
    ARRAY_AGG(STRUCT(
      name, email, contact_first_name, owner_code, disbursements, commissionable,
      commissionable_base_ht, currency, gmv_ttc, paid, outstanding, raw_outstanding,
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
      CAST([] AS ARRAY<STRUCT<
        amount FLOAT64, currency STRING, paid_on STRING, method STRING, reference STRING
      >>) AS disbursements,
      CAST([] AS ARRAY<STRUCT<
        label STRING, base_ht FLOAT64, rate_pct FLOAT64
      >>) AS commissionable,
      CAST(0 AS FLOAT64) AS commissionable_base_ht,
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
    IFNULL(ic.client_service_fees_ttc, 0) AS client_service_fees_ttc,
    COALESCE(CAST(ar.total_paid_client_ccy AS FLOAT64), fi.paid) AS paid_ccy,
    CAST(ar.balance_client_ccy AS FLOAT64) AS ar_balance_ccy,
    TO_JSON_STRING(
      IFNULL(p.items, IFNULL(pfb.items, CAST([] AS ARRAY<STRUCT<
        name STRING, email STRING, contact_first_name STRING, owner_code STRING,
        disbursements ARRAY<STRUCT<amount FLOAT64, currency STRING, paid_on STRING,
          method STRING, reference STRING>>,
        commissionable ARRAY<STRUCT<label STRING, base_ht FLOAT64, rate_pct FLOAT64>>,
        commissionable_base_ht FLOAT64, currency STRING, gmv_ttc FLOAT64, paid FLOAT64,
        outstanding FLOAT64, raw_outstanding FLOAT64, payable FLOAT64, payable_to_date FLOAT64,
        commission FLOAT64,
        locked BOOL, locked_by_admin BOOL, locked_by_client BOOL, locked_by_owner BOOL,
        is_provision BOOL, payment_method STRING, vat_raw STRING, tax_identifier STRING, country STRING
      >>)))
    ) AS partners_json,
    TO_JSON_STRING(
      IFNULL(civ.items, CAST([] AS ARRAY<STRUCT<
        invoice_id STRING, invoice_ref STRING, party STRING, doc_kind STRING,
        status STRING, currency STRING, amount_ttc FLOAT64,
        emission_date STRING, due_date STRING, is_sent BOOL,
        cancels_invoice_id STRING, pdf_url STRING, seller_name STRING,
        buyer_email STRING, payment_means STRING, bank_details STRING
      >>))
    ) AS invoices_json,
    TO_JSON_STRING(
      IFNULL(rcp.items, CAST([] AS ARRAY<STRUCT<
        amount FLOAT64, currency STRING, paid_on STRING, method STRING, reference STRING
      >>))
    ) AS client_receipts_json,
    NULLIF(cr.contact_snapshot_email, '') AS client_contact_email,
    NULLIF(TRIM(CONCAT(
      IFNULL(cr.contact_snapshot_firstname, ''), ' ', IFNULL(cr.contact_snapshot_lastname, '')
    )), '') AS client_contact_name
  FROM \`naboo-app-365515.finance_gld_fct_prd.fct_export_events_scd1\` e
  LEFT JOIN \`naboo-app-365515.finance_gld_vw_prd.vw_balance_agee_ar\` ar
    ON ar.readable_id = e.client_request_readable_id
  LEFT JOIN fi_base fi ON fi.crid = e.clientRequestId
  LEFT JOIN client_proposal_totals cpt ON cpt.rid = e.client_request_readable_id
  LEFT JOIN invoiced_client ic ON ic.rid = e.client_request_readable_id
  LEFT JOIN client_invoices civ ON civ.crid = e.clientRequestId
  LEFT JOIN client_receipts rcp ON rcp.crid = e.clientRequestId
  LEFT JOIN \`naboo-app-365515.raw_naboo_data.client_requests\` cr
    ON cr.request_id = e.clientRequestId AND cr.deleted = false
  LEFT JOIN partners_rm p ON p.rid = e.client_request_readable_id
  LEFT JOIN partners_fi_fallback pfb ON pfb.rid = e.client_request_readable_id
  WHERE e.bk_market = 'North America'
    AND e.booking_status = 'ACCEPTED'
)
SELECT
  readable_id, client_request_id, company_name, sales_referent, em_referent, days_before_start,
  currency_client, event_name, start_date, end_date, event_type, transaction_kind, participants, billing_entity, booking_url,
  client_service_fees_ttc,
  gmv_client_ccy, gmv_client_eur, invoiced_ccy, paid_ccy, invoices_json,
  client_receipts_json, client_contact_email, client_contact_name,
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

const CACHE_KEY = "na-rows";

export const getNaRows = createServerFn({ method: "GET" })
  .validator((input?: { force?: boolean }) => ({ force: input?.force === true }))
  .handler(async ({ data }): Promise<{ rows: NaRow[]; cachedAgeSeconds: number | null }> => {
    // Financial data: never served without an approved session that is
    // explicitly allowed to open this tracker.
    const { requireTracker } = await import("./session.server");
    await requireTracker("na");
    const { readCache, writeCache, cacheAge } = await import("./query-cache.server");

    if (!data.force) {
      const hit = await readCache<NaRow[]>(CACHE_KEY);
      if (hit) return { rows: hit, cachedAgeSeconds: await cacheAge(CACHE_KEY) };
    }

    const { runBigQuery } = await import("./bigquery.server");
    const rows = (await runBigQuery(QUERY)) as unknown as NaRow[];
    await writeCache(CACHE_KEY, rows);
    return { rows, cachedAgeSeconds: 0 };
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

export function parseNaClientReceipts(json: string | null): NaClientReceipt[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as NaClientReceipt[]) : [];
  } catch {
    return [];
  }
}
