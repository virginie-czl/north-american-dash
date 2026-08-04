/**
 * Postgres connection for the annotation layer and other small server-side
 * state (server-only).
 *
 * The store is provisioned from the Vercel dashboard (Storage tab); Vercel injects
 * the connection string as an environment variable. Nothing has to be created by
 * hand: the schema is applied on first use, so a fresh database works immediately.
 */
import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

let client: Sql | null = null;

// The bootstrap memo lives on globalThis rather than in a module variable: the server
// bundle can hold more than one copy of this module (each server function chunk that
// imports it), and a per-copy memo replays the whole schema once per copy.
const SCHEMA_MEMO = Symbol.for("naboo.tracker.schemaBootstrap");
type SchemaHost = { [SCHEMA_MEMO]?: Promise<void> | null };

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
      // The schema bootstrap is all CREATE ... IF NOT EXISTS, so Postgres answers
      // every statement with `NOTICE: relation "…" already exists, skipping`. Those
      // are notices we provoke on purpose and they carry nothing; left on, they buried
      // the one line that mattered when the card mirror was failing to write.
      onnotice: () => {},
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
  // Cached BigQuery payloads. The trackers re-run heavy multi-CTE queries on every
  // page load; finance data moves slowly enough that a short TTL is invisible,
  // and the Refresh button forces a recompute when it matters.
  `CREATE TABLE IF NOT EXISTS query_cache (
     cache_key text PRIMARY KEY,
     payload text NOT NULL,
     computed_at timestamptz NOT NULL DEFAULT now()
   )`,
  // Credit-card approvals mirrored out of #finance-paiement-by-card, so a cold
  // serverless instance does not have to page through the Slack API before the
  // partner cards can render.
  //
  // One row per provider, deliberately: this answers "what do we know about this
  // provider", not "list every card ever issued". A provider has one approved card per
  // booking — 559 approvals across 287 providers today — so the channel's messages are
  // aggregated onto the owner code rather than stored one by one. Per-booking history,
  // if it is ever wanted, belongs in its own table keyed on the Pliant card id.
  `CREATE TABLE IF NOT EXISTS slack_card_approvals (
     owner_code text PRIMARY KEY,
     event_ref text,
     approved_by text,
     approved_at timestamptz,
     synced_at timestamptz NOT NULL DEFAULT now()
   )`,
  // The aggregate. "Card OK · 4 approvals, last 31 Jul 2026" is a far better basis for
  // deciding to pay by card than a bare "Card OK": it says whether the evidence is one
  // stale approval or a standing habit. Existing deployments predate both columns.
  `ALTER TABLE slack_card_approvals
     ADD COLUMN IF NOT EXISTS approval_count integer NOT NULL DEFAULT 1,
     ADD COLUMN IF NOT EXISTS first_approved_at timestamptz`,
  // What each provider will accept, and what Naboo has decided to do about it —
  // two separate questions, kept in two separate columns on purpose. accepts_card
  // is an override of the derived status (null falls back to the evidence);
  // naboo_pays_card is always a human decision, and naboo_reason is mandatory in
  // the one case that needs explaining: they take card and we still say no.
  `CREATE TABLE IF NOT EXISTS provider_card_terms (
     owner_code       text PRIMARY KEY,
     accepts_card     text,
     fee_percent      numeric(6,3),
     fee_fixed        numeric(12,2),
     fee_currency     text,
     refusal_reason   text,
     naboo_pays_card  text,
     naboo_reason     text,
     updated_by       text NOT NULL,
     updated_at       timestamptz NOT NULL DEFAULT now()
   )`,
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
  // The task board joined the list of things access is given to, and it is everybody's
  // until an admin says otherwise — so it is in the default for anyone approved from here
  // on.
  `ALTER TABLE app_users ALTER COLUMN trackers
     SET DEFAULT ARRAY['loreal', 'veolia', 'na', 'tasks']::text[]`,
  // A ledger of the one-shot data changes, as opposed to the schema statements around it
  // which are written to be safe to re-run. A backfill is not: repeating the one below
  // would hand Tasks back to every person an admin had taken it from, silently, on the
  // next deploy.
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     id text PRIMARY KEY,
     applied_at timestamptz NOT NULL DEFAULT now()
   )`,
  // Nobody loses the board because it became grantable. Existing people keep it, and the
  // UPDATE only touches anything on the run that actually claimed the marker — so an
  // admin's later "take it away" stands.
  `WITH claimed AS (
     INSERT INTO schema_migrations (id) VALUES ('app_users.trackers += tasks')
     ON CONFLICT (id) DO NOTHING
     RETURNING id
   )
   UPDATE app_users SET trackers = array_append(trackers, 'tasks')
   WHERE EXISTS (SELECT 1 FROM claimed) AND NOT ('tasks' = ANY(trackers))`,
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
  // AI-written financial summary of a partner's email thread (Marketplace NA).
  // A step beyond the rest of the annotation layer: partner_email_facts only
  // ever stores derived yes/no verdicts, never content — this table stores an
  // LLM's paraphrase of the thread, shared with the whole team on purpose so
  // a colleague without Gmail access still sees why a booking is flagged.
  // Recovery emails already sent, so two people never chase the same
  // counterparty for the same booking twice.
  //
  // The primary key *is* the rule: one recovery email per booking per recipient
  // per side of the marketplace. A sender claims the row before Gmail is called
  // and the claim is released only if the send itself fails, so two people
  // clicking at the same moment cannot both get through — a check the UI could
  // only ever make optimistically.
  //
  // Scope, not mode, is the lock: a provider's commission, a refund and the
  // combined ask are one conversation with that provider, so any of them closes
  // the door on the others. Mode stays recorded for the audit trail.
  `CREATE TABLE IF NOT EXISTS recovery_emails (
     event_ref text NOT NULL,
     recipient text NOT NULL,
     scope text NOT NULL,
     mode text NOT NULL,
     recipient_name text,
     subject text,
     sent_at timestamptz NOT NULL DEFAULT now(),
     sent_by text NOT NULL,
     sent_by_name text,
     PRIMARY KEY (event_ref, recipient, scope)
   )`,
  `CREATE INDEX IF NOT EXISTS recovery_emails_event_ref_idx ON recovery_emails (event_ref)`,
  `CREATE TABLE IF NOT EXISTS na_financial_summary (
     event_ref text NOT NULL,
     partner_key text NOT NULL,
     partner_name text,
     summary text NOT NULL,
     message_count integer NOT NULL DEFAULT 0,
     generated_at timestamptz NOT NULL DEFAULT now(),
     generated_by text,
     PRIMARY KEY (event_ref, partner_key)
   )`,

  // The task board.
  //
  // Only what the board knows that the trackers do not: where a card sits, who has it,
  // and anything typed on it. A derived task with nobody's hand on it has no row here at
  // all — the tracker is still the authority on whether the work is open, and a table of
  // copies would be a second answer to that question waiting to disagree.
  //
  // `manual` is the one bit that changes the meaning of the row: a manual task's title
  // is the task, while a derived one's title is a snapshot kept only so the card can
  // still be named after the tracker stops reporting it.
  `CREATE TABLE IF NOT EXISTS tracker_tasks (
     key text PRIMARY KEY,
     manual boolean NOT NULL DEFAULT false,
     column_key text NOT NULL DEFAULT 'todo',
     assignee text,
     note text,
     due date,
     title text,
     tracker text,
     ref text,
     created_by text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_by text,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS tracker_tasks_column_idx ON tracker_tasks (column_key)`,
  // Urgency is the one thing on a card that no tracker can know: the ledger says what is
  // owed, a colleague says what jumps the queue. Existing deployments predate the column.
  `ALTER TABLE tracker_tasks
     ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal'`,

  // A personal Slack grant, one row per person. Not the workspace bot — this token can
  // read that person's own reminders and saved items and nothing else. Encrypted with
  // the same key as the Gmail grant.
  `CREATE TABLE IF NOT EXISTS slack_credentials (
     user_email text PRIMARY KEY,
     user_token text NOT NULL,
     scopes text NOT NULL,
     slack_user_id text NOT NULL,
     team_name text,
     connected_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     synced_at timestamptz
   )`,

  // What the last pull found, per person.
  //
  // `owner_email` is the privacy rule and it is part of the primary key: a row belongs to
  // one person, only ever written by their own sync, and only ever read back with their
  // own session email. Two people who saved the same Slack message get a row each.
  `CREATE TABLE IF NOT EXISTS slack_tasks (
     owner_email text NOT NULL,
     slack_id text NOT NULL,
     kind text NOT NULL,
     title text NOT NULL,
     due date,
     permalink text,
     synced_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (owner_email, slack_id)
   )`,
  // Mentions are events, not state. A reminder still exists in Slack on the next pull, so
  // it can be replaced wholesale; a mention was said once, fifteen minutes ago, and will
  // never be in another answer. first_seen_at is what lets the row survive later syncs and
  // still be pruned eventually, and subject holds where it was said.
  `ALTER TABLE slack_tasks
     ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now(),
     ADD COLUMN IF NOT EXISTS subject text`,
];

/** Applies the schema once per instance. Every statement is idempotent. */
async function ensureSchema(sql: Sql): Promise<void> {
  const host = globalThis as SchemaHost;
  if (!host[SCHEMA_MEMO]) {
    host[SCHEMA_MEMO] = (async () => {
      for (const statement of SCHEMA_STATEMENTS) {
        await sql.unsafe(statement);
      }
    })().catch((error) => {
      // Let the next call retry rather than caching the failure forever.
      host[SCHEMA_MEMO] = null;
      throw error;
    });
  }
  return host[SCHEMA_MEMO];
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

/**
 * An ISO day from a `date` column.
 *
 * The driver hands a `date` back as a JS Date, and `String(date).slice(0, 10)` on one of
 * those is "Sun Aug 02" — a plausible-looking string that is not a date at all and
 * sorts alphabetically. Anything that reads a day goes through here.
 */
export function dayOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}
