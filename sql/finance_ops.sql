-- Naboo Tracker annotation tables (replaces the former Supabase tables).
-- Run once in BigQuery (project naboo-app-365515, location EU).

CREATE SCHEMA IF NOT EXISTS `naboo-app-365515.finance_ops`
OPTIONS (location = 'EU');

CREATE TABLE IF NOT EXISTS `naboo-app-365515.finance_ops.sla_event_comments` (
  id STRING NOT NULL,
  event_ref STRING NOT NULL,
  user_id STRING NOT NULL,
  user_email STRING NOT NULL,
  user_name STRING,
  user_avatar_url STRING,
  body STRING NOT NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS `naboo-app-365515.finance_ops.sla_partner_status` (
  event_ref STRING NOT NULL,
  partner_key STRING NOT NULL,
  partner_name STRING,
  status STRING NOT NULL,  -- not_contacted | waiting_bank | partially_paid | fully_paid
  updated_by STRING,
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS `naboo-app-365515.finance_ops.sla_po_emission` (
  event_ref STRING NOT NULL,
  purchase_order_number STRING NOT NULL,
  emitted_at TIMESTAMP NOT NULL,
  updated_by STRING,
  updated_at TIMESTAMP NOT NULL
);
