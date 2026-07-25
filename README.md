# Naboo Tracker — North America SLA dashboards

Internal finance tracker (L'Oréal CA · Veolia US · Marketplace NA): client invoicing SLAs,
receivables, partner payouts, outreach statuses and comments. TanStack Start + React 19,
data from BigQuery (`naboo-app-365515`). No Supabase — auth is direct Google OAuth
(restricted to @naboo.app), and the annotation layer (comments, partner outreach
statuses, PO first-emission dates) lives in a small Postgres store attached in Vercel.

## Setup

1. **Annotation store** — Vercel → your project → *Storage* → create a Postgres
   database and attach it. Vercel injects the connection string; the app creates
   its own tables (comments, partner statuses, PO dates) on first run.
2. **Google OAuth** — Google Cloud console → APIs & Services → Credentials →
   OAuth client ID (Web application). Consent screen: *Internal*.
   Authorized redirect URIs: `https://<domain>/api/auth/callback` and
   `http://localhost:5173/api/auth/callback`.
3. **Env vars** — see `.env.example`: `BIG_QUERY_JSON` (read-only warehouse
   access), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`
   (`openssl rand -base64 32`). `DATABASE_URL` comes from step 1.
4. **Optional** — `sql/restore_annotations_2026-07-25.sql` re-imports the
   annotations exported from the previous version.

## Develop / deploy

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # must pass before committing
```

Deploys on Vercel out of the box: `vite.config.ts` forces the nitro `vercel` preset when
`VERCEL=1` (Vercel sets it automatically). Add the four env vars in the Vercel project.
