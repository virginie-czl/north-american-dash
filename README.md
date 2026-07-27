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
5. **Optional — Gmail** — add `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`),
   then add these scopes to the OAuth client's consent screen:
   `gmail.readonly` and `gmail.compose`. Add
   `https://<domain>/api/gmail/callback` to the authorized redirect URIs.
   With an *Internal* consent screen no Google security assessment is required.
   Each user connects their own mailbox from the account menu; sign-in never
   asks for mailbox access.

## Gmail integration

Connecting Gmail is per user, explicit and revocable — refresh tokens are stored
encrypted (AES-256-GCM) and a user can only ever reach their own mailbox. In the
event drawer, *Email history* shows whether each partner was contacted and whether
they replied, and *Reminder* drafts or sends a message. Reads only happen when the
user clicks, searches are narrowed to the partner addresses on that event, and
sending is one recipient at a time behind a confirmation step.

## Develop / deploy

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # must pass before committing
```

Deploys on Vercel out of the box: `vite.config.ts` forces the nitro `vercel` preset when
`VERCEL=1` (Vercel sets it automatically). Add the four env vars in the Vercel project.


### Partner fact scanning

*Rechercher dans mes emails* (table toolbar, visible once Gmail is connected) scans
the user's own mailbox for each partner: first by email address, and when that finds
nothing, by the deal code — Gmail matches it in the subject *and* the body. It never
runs on a table refresh; only on that button.

From the matched messages it derives six things per partner — contacted (when, by
whom), replied, whether bank details were asked or received, same for tax numbers,
and whether the partner accepts card payment. Detection rules live in
`src/lib/email-facts.ts` (pure, no I/O); run `npx tsx src/lib/email-facts.test.mjs`
after changing them.

Only these verdicts are stored, in `partner_email_facts` — no subject, body, snippet
or sender beyond the acting colleague's address. So every tracker user sees the
stickers and their hover attribution ("Demandé par Shayma le 10 avril") while the
correspondence itself stays private to the mailbox owner. Scans merge rather than
overwrite: one person's results never erase another's.

The rules are heuristics over the vocabulary the team actually uses, in French and
English, plus high-confidence identifier formats (IBAN, GST/BN `123456789 RT0001`,
QST `1234567890 TQ0001`, EU VAT). Expect to tune them against real mail.


### What gets scanned, and what does not

Scanning is targeted. For each partner the tracker combines three sources — the
warehouse (amount outstanding, tax registration), the email scan (what was asked
and answered) and cross-event memory (has this partner ever accepted a card?) —
and decides who owes the next move. The rules live in `src/lib/partner-actions.ts`
(`npx tsx src/lib/partner-actions.test.mjs`).

Events are skipped when no email could change the answer:

| Situation | Verdict | Scanned |
| --- | --- | --- |
| Paid, tax numbers on file | Rien à faire | no |
| Paid, tax already requested (or recorded but unreadable) | Enregistrer les taxes — ours | no |
| Owed, bank details in hand | À payer (virement) — ours | no |
| Owed, partner accepted card before | À payer (carte) — ours | no |
| No PO yet | Bloqué — nothing to ask | no |
| Owed, nothing asked yet | Demander bancaire + taxes | yes |
| Asked, no reply yet | En attente de réponse | yes |
| Asked, partner replied | Réponse à traiter | yes |

The button label shows how many events actually qualify, so a run costs only what
it needs to.

**Card before bank.** A partner who has accepted a card payment on *any* event is
never asked for an IBAN again — the tracker proposes the card instead. That memory
is keyed on the partner, not the booking.

### Tax registration comes from BigQuery, not from email

`owners.vat_number` (venues) and `service_owners.vat_number` / `tax_identifier`
(ad-hoc providers) are joined on `partners.houseownerid`. The field is free text,
so `parseTaxRegistration` reads out Canadian GST (`123456789RT0001`), Quebec QST
(`1234567890TQ0001`) and EU VAT, and flags anything unreadable rather than treating
it as valid. Canadian partners need both GST and QST to count as complete.

Coverage is thin today — of 100 L'Oréal Canada partner lines only 5 have anything
recorded, 2 a readable GST and 1 a QST — which is exactly why the scan targets the
gaps. Note that `owners.stripe_status` is empty across all 2,856 partner lines, so
card acceptance cannot be read from the warehouse; it comes from the email scan.


### The privacy line

Two things sit side by side in the event drawer, and they are not the same:

- **Shared stickers** — derived verdicts only (contacted / replied / bank / tax /
  card, with dates and the acting colleague's name). Stored in
  `partner_email_facts`, readable by every tracker user.
- **"Ma boîte Gmail" panel** — subjects, dates and thread links for the *signed-in
  user's own mailbox only*. Resolved live from the caller's session on each
  request; never stored, so it cannot reach anyone else. A colleague without Gmail
  connected sees the stickers but no panel; a colleague with Gmail connected sees
  their own threads, not yours.

If you extend `partner_email_facts`, keep the new column on the verdict side of
that line. A stored thread id or subject would turn a shared table into a window
into someone else's mailbox.

So when Shayma emails a partner and gets back an IBAN and a GST number, Virginie
sees *Bancaire reçu* and the tax sticker change without ever seeing the message or
its thread — the verdicts are team-wide, the correspondence is not.

**Received is not the same as recorded.** The tax sticker separates the two, because
they have different owners:

| Sticker | Meaning | Whose move |
| --- | --- | --- |
| *Taxes en base* (green) | Readable registration in `owners` / `service_owners` | nobody |
| *Taxes à saisir* (amber) | Partner sent it by email; not keyed into Naboo | ours |
| *Taxes demandé* (amber) | Asked, nothing back yet | partner's |
| *Taxes —* (grey) | Never asked | partner's |

Bank details have no equivalent warehouse field, so there the email scan is the only
source and *Bancaire reçu* means exactly that.


## Access control

A verified `@naboo.app` Google account establishes *who* someone is; it does not
grant access. Access lives in `app_users` and is decided once:

1. First sign-in records a `pending` row and shows a "waiting for validation" screen.
   No session cookie is issued.
2. An admin approves from **Accès à l'outil** (account menu → visible to admins,
   with a badge on the avatar when something is waiting).
3. From then on that person signs straight in. Approval is never asked again.

`shayma.ndiaye@naboo.app` (`OWNER_EMAIL` in `src/lib/access.server.ts`) is approved
on sight and always owner — otherwise the first sign-in could never be approved by
anyone. The owner's own access cannot be revoked, by anyone, including themselves.

Admins can approve, refuse and revoke. Only the owner can grant or remove admin
rights — that keeps a second pair of hands available without letting anyone
promote themselves.

### Per-tracker access

Approval opens the account; it does not open every page. Each user carries a list
of trackers (`app_users.trackers`) that admins tick in **Accès à l'outil** — so a
colleague who only handles Veolia never sees the L'Oréal numbers. The owner always
has all three.

Enforcement is server-side. `getSlaRows`, `getVeoliaSlaRows` and `getNaRows` each
call `requireTracker(...)`, so an endpoint refuses even if someone bypasses the UI —
hiding a tab in the nav is presentation, not access control. The route guards and
the filtered nav exist only so people are not shown doors that will not open, and
a user is redirected to a tracker they *can* read rather than to a dead end.

New rows default to all three trackers, matching what existing users already had.
Tighten it per person from the admin page.

**Revocation actually revokes.** Session cookies last a week, so approval is
re-checked on every authenticated call, not just at sign-in. The check is cached
for 45 seconds per instance, which is the upper bound on how long a revoked
account keeps working.


### Asking providers for what is missing

Two entry points, both sending from the signed-in user's own Gmail:

- **Per provider** — in the event drawer, under the stickers: *Demander coordonnées
  bancaires + numéros de taxes*, worded from what that provider actually lacks.
- **In bulk** — *Demander les infos manquantes (N)* in the table toolbar, covering
  every provider on the visible rows missing at least one item.

Both open the same review dialog. Nothing is sent from the click: the dialog lists
each recipient, what they will be asked for and which bookings it covers, every
message can be read and edited, recipients can be unticked, and sending needs a
second confirmation. *Créer N brouillons* is offered alongside so a round can be
reviewed in Gmail first.

Two design rules, in `src/lib/partner-requests.ts` (pure,
`npx tsx src/lib/partner-requests.test.mjs`):

1. **One email per address, not per booking.** A provider on three events gets a
   single message listing all three and the summed outstanding amount. Three
   near-identical chases to the same inbox is how a reminder becomes spam.
2. **Ask only for gaps, and never for something we do not need.** A provider who
   accepted a card before is asked to confirm the card, not for an IBAN. A Canadian
   partner with a GST but no QST is asked only for the QST. Language follows the
   provider's country.

Sending is sequential with a per-recipient result, so a partial failure is visible:
"11 sent, 3 failed" plus the reason for each, rather than an all-or-nothing outcome.
Duplicate addresses are collapsed server-side too, and a run is capped at 60.


### Partner invoice PDFs

In each event drawer, the *Factures partenaires* panel fetches the PDFs that
partners submitted via the Naboo RFI flow (e.g. Patrice Blais's invoice for
L'Oréal / Humankind). These live in MongoDB and are exposed via the Naboo
GraphQL API (`reInvoicingRequests.userProvidedData.pdfUrl`) — they are not in
BigQuery. Signed S3 URLs expire after ~15 min so they are fetched on demand,
never stored.

Set `NABOO_ADMIN_TOKEN` in Vercel environment variables (admin JWT from the
Naboo BO or from the tech team). Without it the panel shows an error but
everything else keeps working.
