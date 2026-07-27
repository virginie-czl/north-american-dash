/**
 * Postgres connection for the annotation layer (server-only).
 *
 * The store is provisioned from the Vercel dashboard (Storage tab); Vercel injects
 * the connection string as an environment variable. Nothing has to be created by
 * hand: the schema is applied on first use, so a fresh database works immediately.
 */
import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

let client: Sql | null = null;
let schemaPromise: Promise<void> | null = null;

function connectionString(): string {
  // Vercel names this differently depending on which provider was chosen.
  const url =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.DATABASE_POSTGRES_URL;
  if (!url) {
    throw new Error(
      "No Postgres connection string found. Create a Postgres store in the Vercel " +
        "dashboard (Storage tab) and redeploy, or set DATABASE_URL locally.",
    );
  }
  return url;
}

function getClient(): Sql {
  if (!client) {
    client = postgres(connectionString(), {
      // One connection per serverless instance; the provider's pooler does the rest.
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      // Prepared statements are not supported through transaction-mode poolers.
      prepare: false,
    });
  }
  return client;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sla_event_comments (
     id text PRIMARY KEY,
     event_ref text NOT NULL,
     user_id text NOT NULL,
     user_email text NOT NULL,
     user_name text,
     user_avatar_url text,
     body text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS sla_event_comments_event_ref_idx
     ON sla_event_comments (event_ref)`,
  `CREATE TABLE IF NOT EXISTS sla_partner_status (
     event_ref text NOT NULL,
     partner_key text NOT NULL,
     partner_name text,
     status text NOT NULL,
     updated_by text,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (event_ref, partner_key)
   )`,
  // Access registry. A verified @naboo.app Google account is necessary but not
  // sufficient: the first sign-in creates a pending row that an admin must approve.
  // Approval is recorded once and never asked again.
  `CREATE TABLE IF NOT EXISTS app_users (
     email text PRIMARY KEY,
     name text,
     picture text,
     status text NOT NULL DEFAULT 'pending',
     role text NOT NULL DEFAULT 'member',
     requested_at timestamptz NOT NULL DEFAULT now(),
     decided_at timestamptz,
     decided_by text,
     last_seen_at timestamptz,
     -- Which trackers this person may open. Approval and visibility are separate
     -- questions: not everyone who needs Veolia needs to see L'Oréal.
     trackers text[] NOT NULL DEFAULT ARRAY['loreal', 'veolia', 'na']::text[]
   )`,
  // Existing deployments predate the column.
  `ALTER TABLE app_users ADD COLUMN IF NOT EXISTS trackers text[]
     NOT NULL DEFAULT ARRAY['loreal', 'veolia', 'na']::text[]`,
  `CREATE INDEX IF NOT EXISTS app_users_status_idx ON app_users (status)`,
  // Derived facts only — never subjects, bodies, thread ids or any message
  // content. Every user of the tracker may read these stickers, so anything added
  // here becomes visible to the whole team: a stored thread id would hand a
  // colleague a link into a mailbox that is not theirs. Thread links are resolved
  // live from the caller's own session instead (see components/partner-emails.tsx).
  `CREATE TABLE IF NOT EXISTS partner_email_facts (
     event_ref text NOT NULL,
     partner_key text NOT NULL,
     partner_name text,
     matched_by text NOT NULL DEFAULT 'email',
     contacted_at timestamptz,
     contacted_by text,
     replied_at timestamptz,
     bank_details text NOT NULL DEFAULT 'not_asked',
     bank_asked_at timestamptz,
     bank_asked_by text,
     bank_received_at timestamptz,
     tax_info text NOT NULL DEFAULT 'not_asked',
     tax_asked_at timestamptz,
     tax_asked_by text,
     tax_received_at timestamptz,
     card_payment text NOT NULL DEFAULT 'unknown',
     card_decided_at timestamptz,
     message_count integer NOT NULL DEFAULT 0,
     scanned_at timestamptz NOT NULL DEFAULT now(),
     scanned_by text,
     PRIMARY KEY (event_ref, partner_key)
   )`,
  `CREATE TABLE IF NOT EXISTS google_credentials (
     user_email text PRIMARY KEY,
     refresh_token text NOT NULL,
     scopes text NOT NULL,
     connected_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS sla_po_emission (
     event_ref text PRIMARY KEY,
     purchase_order_number text NOT NULL,
     emitted_at timestamptz NOT NULL DEFAULT now(),
     updated_by text,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
];

/** Applies the schema once per instance. Every statement is idempotent. */
async function ensureSchema(sql: Sql): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      for (const statement of SCHEMA_STATEMENTS) {
        await sql.unsafe(statement);
      }
    })().catch((error) => {
      // Let the next call retry rather than caching the failure forever.
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

/** Returns a ready-to-use client with the schema guaranteed to exist. */
export async function db(): Promise<Sql> {
  const sql = getClient();
  await ensureSchema(sql);
  return sql;
}

/** ISO-8601 for the client, or null. Postgres returns Date objects. */
export function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
