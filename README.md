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
The same file sets `maxDuration: 60` on the function, because the trackers wait on
BigQuery — see below.

### The trackers' type

L'Oréal CA and Marketplace NA set their headings in **fiona**, from the Adobe
kit loaded in `__root.tsx` (`use.typekit.net/pxx3gpc.css`). It is a display face
and it is used like one: page titles, section heads, the portfolio figure and the
wordmark, nothing below 17px. Body text, table rows and columns of figures stay
on Geist and Geist Mono — the kit ships both of its faces at a single weight, so
anything asking for bold would be synthesised, and neither has tabular figures.

Two things to know. **A new domain has to be authorised in Adobe Fonts**, or the
kit will not serve; the rest of the stack in `--font-paper-display` (Bricolage
Grotesque, then Aeonik) takes over on its own, so a page renders correctly either
way — it just is not the brand. And the kit's other face, **cesso**, is one word
away in that token if it is ever wanted: it was the first choice and lost because
its 3 reads as a 5 at a glance, which on headings that carry a booking reference
(`C-V304`) and a hero made of money is a mistake waiting to happen.

Veolia is still on the old tokens (`--font-sans`, `--font-display`) and is
untouched by this.

### Waiting on BigQuery

`jobs.query` answers after a fixed wait whether or not the query has finished; a
slow one comes back `jobComplete: false` while the job carries on running. That
is not a failure, it is a job to pick up by id — `runBigQuery` polls
`getQueryResults` until it completes or a 50-second budget runs out. It also
follows `pageToken`: a large result arrives a page at a time, and reading only
the first page returns a short table that looks perfectly healthy.

Marketplace NA is the heaviest query and the only cached one. When it does fail,
the server falls back to the last good answer rather than the error page — the
header already dates the figures ("il y a 12 min"), and *Rafraîchir* forces a
recompute.


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

**Tax registration: presence, not validity.** `owners.vat_number` is free text and
holds everything from `121107726RT0001` to `//` to `0000000000000000000`. The rule
is deliberately operational: if the field contains at least one non-zero digit, we
hold a number and stop chasing — whether or not the format is one we recognise.
Strings of zeros and punctuation-only values are treated as not filled in, since
`0000` is the same gesture as `//`. Recognised formats are still parsed so the
tooltip can show them, and `missingQstForCanada` surfaces a Canadian partner with a
GST but no QST as information rather than as a chase.


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

### The headline figures on L'Oréal CA

Six clickable figures above the list: client outstanding on events with a PO,
what the client has paid, what is still owed to partners on events with a PO,
then the invoicing state — invoices issued and emailed, events with a PO and
nothing emailed yet, and events still waiting for a PO.

Two rules keep them honest:

- **One predicate per figure decides both the total and the list it opens**, so a
  number can never describe a different set of events than the one you get when
  you click it. Each figure's `test` in `STATS` is the single definition.
- **They are computed over whatever the filters have left**, not over the whole
  table — so they always describe the population on screen, and they change as
  you filter. Turnkey is out by default, so the figures are too. Clicking one
  sets the scope to *All*, since the move groups would otherwise hide most of
  what the figure just counted.

*Issued and sent* means `status = ISSUED` with an `EMAIL` send event — `MANUAL`
sends and cancelled invoices are not the client having received an invoice.
It counts invoices, not events; the other five count events.

**Where the "to invoice" amounts come from.** An event with no invoice has no
invoice amount to add up, so the figure is what the client agreed to pay, from
the confirmed proposal, less whatever has already been issued. That total is TTC
and has matched the issued invoice to the cent on every event checked (F-B796:
5 802,79). 96 of 98 events carry one; the two without contribute nothing.

**A caveat on "paid by the client".** It reads `collectedTotal`, the same field
the rest of the page uses for client outstanding — and that field knows about
4 events totalling 61 690,86 $ while the payments ledger has client inflows on
11 events totalling 86 218,98 $. Client outstanding is overstated by the same
gap. Switching the source would move figures across the whole page, so it is
flagged here rather than changed.

### Where the PO comes from, and when we got it

Both SLAs hang off the purchase order, so both readings have to be right.

**The number.** `fct_export_events_scd1.purchase_order_number` is the first
source, but on 18 of 85 L'Oréal events the client's number only ever reached the
client invoice (`invoices.purchaseOrderNumber`) — F-B755 is one, showing *No PO*
while carrying 4200043224 since its invoice of 30 July. The query falls back to
the invoice, requiring the value to hold a digit: the field is free text and
holds `pas de PO` and `""` on two events, which are not purchase orders.

**The date.** Not `fct_export_events_scd1.updated_at` — that is the warehouse's
own ingestion stamp, *identical on all 27 118 rows* and moving to today on every
refresh. Anchoring on it left every deadline in the future, so neither SLA could
ever breach. `purchase_order_date` is the real thing and is populated on every
booking that carries a PO; when the number came from an invoice instead, the
invoice's issue date stands in — we demonstrably held the PO by the time we
billed against it.

The `sla_po_emission` annotation store records when this app first *saw* a PO,
which is not when the PO arrived. It is now only consulted when the warehouse
offers no date at all.

### The money fields move under you

`client_request_free_invoicing` has now twice grown a `price` / `discountPrice`
level inside a money struct — first on `grossGmv` and `netGmv`, then on
`netPayable` and `commission`, which took L'Oréal CA down with *field withtaxes
does not exist*. Every read is `…price.withTaxes` (or `withoutTaxes`), which
reproduces the old flat figures exactly.

`discountPrice` is a **discount on** `price`, not an alternative to it, so what a
provider is owed is `price − discountPrice`. The warehouse confirms it exactly:
on every discounted L'Oréal line, `price − discountPrice − disbursed` equals
`outstandingPayable` to the cent (Hotel X Toronto on C-W875: 14 204,10 − 6 603,89
= 7 600,21 owed, nothing yet paid). Reading `price` alone overstated seven
providers' balances. The same holds for `commission`, which carries its own
discount and reconciles against the reconciliation view once it is subtracted.

Still outstanding: the row-level `grossGmv` and `netGmv` carry discounts too —
410 and 401 bookings respectively — and are still read at `price`. L'Oréal never
surfaces them, but Veolia's service-fee line is `gross − net`, and the two
discounts differ on 262 of those 410 bookings (largest gap 9 648,51), so that
figure is affected.

When a query breaks this way, `INFORMATION_SCHEMA.COLUMN_FIELD_PATHS` for the
table lists every nested path — worth checking all of them at once, since
BigQuery only ever reports the first bad one.

### One row per provider, and what it is owed

A booking carries one provider line per quote, plus trade-name shells from the
quotes table, so the same provider arrives several times over. Both free-invoicing
trackers collapse them in `src/lib/partner-merge.ts` (pure,
`npx tsx src/lib/partner-merge.test.mjs`), and the two amounts on a line do not
combine the same way:

- **Net payable belongs to its own quote, so the lines add up.** F-B658 holds
  three quotes for the same provider — 887,50 + 50 + 100 GBP — and owes 1 037,50.
  Keeping the largest line instead reported 887,50 and hid the rest.
- **Paid is a booking-level running total repeated on every line of an
  outstanding provider** (verified: the disbursed total is identical across each
  of a provider's lines). It is counted once and subtracted once — subtracting it
  per quote would erase money still owed.

A line that is no longer outstanding was settled upstream: it owes nothing, and
its paid figure is its own quote's rather than a repeated total.

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

**Sending records the ask.** The stickers read `partner_email_facts`, and for a
long time only the mailbox scan ever wrote to it — so asking a provider for their
bank details from this app left the row reading *not asked*, and the drawer still
said *Demander le bancaire*, until somebody remembered to run a scan. A send now
writes `bank_details` / `tax_info` = `asked` with the date and the sender, using
the same merge rules as the scan: earliest contact and earliest ask are kept,
*received* is never downgraded to *asked*, and a field this send didn't ask about
is left untouched. Drafts are not recorded — a draft is not a request.

Bank details and tax numbers belong to the provider, not to one booking, so every
selected booking for an address that went out is marked asked, even though the
send collapses to one email per address.


### Asking for a commission or a refund back (Marketplace NA)

An overpaid provider splits in two: up to the commission is ours to recover, and
anything past that is a refund to ask for. That gives three emails — commission,
refund, or one covering both — composed in `src/lib/na-commission-requests.ts`
(pure, `npx tsx src/lib/na-commission-requests.test.mjs`).

**The event manager is copied.** `fct_export_events_scd1` carries the EM's
display name but no address, so the query resolves it against the admin
directory: all 17 North American EMs match, on 178 of 287 accepted bookings (the
rest have no EM recorded and simply go out with no copy line). The Cc shows in
the preview before anything is sent, and a name that stops resolving drops out of
the copy line rather than breaking the email. Note that `Support Naboo` is an EM
of record on 55 bookings and resolves to the shared `support@naboo.app` inbox.

**An ask that went out is remembered.** The tracker decides who to chase from
the amounts, and those do not move until the partner pays — so a commission
asked for in July was still being offered as *Ask for the commission* in August,
with nothing on screen to say it had ever been sent. `na_recovery_request` now
records the fact of each ask (event, partner, which email, when, how many times,
by whom — never a subject or body). The partner card shows *Asked 12 Aug*, the
button becomes *Ask again*, and the batch buttons count only partners nobody has
asked yet; a chase stays available per partner. Drafts are deliberately not
recorded — a draft in Gmail is not an ask. For a send that predates the log, or
one made straight from Gmail, *Already asked — note it* records it without
sending anything.

**The rate is a fraction scaled by a million**, so a percentage is
`price_option_fees_owner_fees_rate / 10000`: 120000 is the standard 12% and
150000 the negotiated 15% ceiling. Dividing by 1 000 instead put every rate out
by a factor of ten — providers were being told their commission rate was 100% on
a 10% deal. Printing the base, the rate and the amount together is what makes an
error like that visible: 80 000.00 at 10% has to come to the 8 000.00 charged.

Addresses are sanitised before they reach the MIME header
(`npx tsx src/lib/gmail-addresses.test.mjs`) — a copy line is a header, and a
value carrying a newline could otherwise add headers of its own.

Every one of them itemises: the commissionable lines, the base, the rate, and
each payment we made with its date, method and bank reference. A bare total
invites "where does that come from?" and a second round trip, so the breakdown
is the point of the email rather than a nicety — and the combined template was
sending the commission as a lone figure while the commission-only one spelled it
out, which is what the test now pins down. When a provider has no priced lines
to quote, the email names the invoice the commission is taken on instead of
sending the figure alone.

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


### Card acceptance: two sources, both explicit

A card verdict decides whether a partner is ever asked for an IBAN, so it has to be
earned. Two independent sources, in order of strength:

1. **An approved credit card request in #finance-paiement-by-card** (`C09GQEKBEAX`).
   The Finance Bot posts a structured message per request; only
   *Credit Card Request Approved* counts — pending, refused and amount-update
   refusals are ignored. Matching is on the **`O-` owner code**, so it is exact with
   no name fuzzing (`src/lib/slack-cards.server.ts`, 11 tests). This means a Pliant
   card was actually issued, which is stronger evidence than any email.
2. **An explicit yes in the partner's own reply.** Loose keyword matching produced
   false positives — "le paiement par carte serait possible mais je dois vérifier"
   and our own question echoed back both read as acceptance. Acceptance now needs a
   directed affirmative ("oui … carte", "nous acceptons la carte", "card works for
   us"); 15 tests cover the phrases that must and must not count.

Requires `SLACK_BOT_TOKEN` with `channels:history`. Without it the Slack source is
skipped and the email signal still works — the page does not break.

**Bank details are not a gap when the partner takes card.** Showing *Bancaire absent*
next to *Carte OK* reads as an outstanding item when there is nothing to chase, so
the bank sticker is hidden once a partner is payable by card — unless we actually
hold their details, which is worth seeing either way.

### Account statements

An amount is only credible if it carries its reasoning. Both trackers hand
someone that reasoning as a document — **one statement per supplier per event,
and one per client per event** — laid out to Naboo's brand: navy and the yellow
accent, Bricolage Grotesque for headings and every figure, Roboto for the body,
12px cards, hairline rules, no shadows.

A client statement states what was invoiced, what came in and what is
outstanding, then lists the invoices and credit notes and the payments received.
A supplier statement is the same document in the other voice: what is payable,
our commission shown as the deduction it is, every disbursement with its date,
method and reference, and a balance that reads "to pay" or "to recover"
depending on which way the money goes.

**Cancelling pairs are left off.** A credit note that voids an invoice in full
tells the reader nothing: the two lines net to zero and only make the statement
longer to tie to the balance. Both are dropped from the listing and the document
says how many pairs it netted off — removing them cannot move a total, which is
what makes it safe. A *partial* credit note is never netted away.

**It is a PDF, drawn by the app** (`src/lib/statement-pdf.ts`, pdf-lib), and
"Download statement" writes it straight to Downloads — one click, no tab, no
print dialog, no destination folder to pick. The five brand faces travel inside
the file (latin subsets, 250 KB, bundled at `src/assets/fonts/` and fetched once
per session), so a statement opened on someone else's machine months later still
reads in Bricolage Grotesque and Roboto. Letter, 44px margins, a running header
and footer redrawn on every page, both table heads repeated after a break, and
the closing bar kept on the same page as the note under it. 10 tests render real
documents and read them back: one page for a short statement, two for sixty
lines, US Letter, five embedded faces, and a glyph the subsets lack does not take
the document down with it.

The figures and every word the document says are decided in one place
(`statementVoice`, `src/lib/statement-of-account.ts`) and drawn in another, so
the wording is testable without a rasteriser: a settled statement must not ask to
be paid, a client who paid beyond what we invoiced reads as a *credit balance*
rather than arrears, and a supplier is *payable to* rather than *billed to*. 38
tests on the figures and the voice.

**Questions go to the event manager, by name.** The footnote reads "Questions on
any line: Emily Osei — emily.osei@naboo.app", and the footer carries the same
address, because the EM ran the event and can answer for each line — a finance
inbox would only forward it. The chain is EM, then whoever sold the booking, then
`finance@naboo.app`: on L'Oréal Canada only 19 of 185 bookings carry an EM and
the other 166 carry a seller, so pointing straight at finance would have defeated
the change (BigQuery audits `d319a251`, `fd0981c3`). Both queries resolve the
referent's name against `raw_naboo_data.admins`, which is the only place that
mapping exists.

`src/lib/account-statements.ts` is the adapter from a tracker row to that
document, and it is where the honesty about our own data lives — client receipts
are held as a total rather than line by line, so the payments table says exactly
that instead of implying nothing was paid. 41 tests.

Statements are taken one at a time from the event — next to each partner and
above the invoice table — or as a zip of the whole filtered set from *Account
statements* on the overview. The zip is written by `src/lib/zip.ts`: store-only,
no dependency, deterministic bytes, UTF-8 names. Colliding names are numbered
rather than dropped — two suppliers called *Le Balcon* on one booking would
otherwise silently become one file.

### Finding one booking: ⌘K

⌘K (or Ctrl-K) from any screen opens one search box over everything the tracker
knows: event or booking reference, PO number, company, event name, partner name
or email, invoice reference, sales and EM — partial codes included, because
`0847` is how anyone actually remembers a reference. Results are grouped
(event/booking, the partners on it, its invoices); ↑ ↓ move, ↵ opens, esc
closes. Picking a result opens that event's own screen. The panel says what it
searches over, so it does not have to be guessed at.

Two rules make the difference between a search and a filter, and both were
regressions worth naming (`src/lib/search-index.ts`, 13 tests):

1. **Search reaches every booking**, not the filtered list. A filter is a
   statement about a list — "the ones that need paying" — and must never decide
   what can be found. An event hidden by the default *hors turnkey* filter, or a
   booking older than the 100-day cut-off, is still one search away.
2. **Anything found can be opened.** The open event is resolved against the same
   full population the search uses. Resolving it out of the filtered list is what
   made a result land on nothing and look like a missing booking.

The panel lists 25 matches per group and says how many it left out, rather than
truncating silently — a list of 25 out of 43 that does not admit it is lying by
omission. Marketplace NA deliberately excludes L'Oréal and Veolia from its
search, as it does from every figure on the page; they are searchable on their
own trackers.

The list filters are a separate thing and stayed where they were — behind the
*Filters* control on the list screen, including a text field that narrows the
rows in place.

### Linkable screens

Which list is open, which figure was clicked and which event is showing are all
in the URL — `/?list=ask`, `/?list=pay&ref=CA-2411-0847`, `/?figure=invoices_to_do`,
`/tracking-north-america?list=commission&ref=NA-2411-4362`. A screen can be
bookmarked, pasted into Slack, and walked back through with the browser's own
back button; ← Previous / Next → walk the list you came from.

### Where to get an account statement

Three places, all the same generator:

- **On the event or booking** — "Account statement · this event" in the header
  bar takes every statement for that file as one zip of PDFs; the rail lists it
  too, and each partner and the client have their own single-PDF link.
- **On the overview** — the *Account statements* block takes the whole filtered
  set: all supplier statements, all client statements. Drawing a hundred PDFs
  takes a few seconds, so the button counts them off (`12 / 96`) and yields the
  frame between documents rather than freezing the tab.
- **On a list** — "Download this list" exports the rows as they read on screen,
  as CSV, because that one is for a spreadsheet (`src/lib/list-export.ts`).

The word is "account statement" throughout the UI, matching what the file itself
says — the design handoff called them "account summaries", and one vocabulary
beats two.

### What belongs on a client's statement, and what it adds up to

Four rules, each of them a bug found on a real statement (C-U332, Bland AI —
BigQuery audits `283a93df`, `1310e8eb`, `a35f0289`, `181fd69c`, `e69fef9d`):

1. **Commission notes are not the client's invoices.** `invoiceDirection =
   'INCOME'` does not mean "billed to the client": our commission notes to the
   *partner* are income to us too. They carry only `FEE_OWNER` lines and no
   `SERVICE` or `FEE_CLIENT` line, and both trackers were listing and counting
   them among the client's own invoices — five of them, 7 100,70 USD, on a
   document addressed to Bland AI, and 158 on one Capgemini entity. Both queries
   now require a client-facing line.
2. **Every document counts toward the total.** A cancelled invoice always comes
   with the credit notes that void it, so dropping the parent alone leaves the
   children subtracting an amount that was never added — that is the difference
   between 250 906,32 and the right figure, 266 494,01. The rule is: total over
   everything, hide only what nets to zero.
3. **The invoice total is the total printed on the invoice.** Summing an
   invoice's `SERVICE` + `FEE_CLIENT` *lines* reads high wherever its own header
   total is lower: two invoices on C-U332 put the figure 56 105,78 USD above the
   back office. Both trackers' invoiced figures are now header-based, matching
   the document we actually sent. On L'Oréal that also means credit notes stop
   being ignored — the old rule counted `status = 'ISSUED' AND amount > 0`.
4. **A client who paid more than we billed is not in arrears.** The document
   reads "Credit balance", drops the due-date pill and says who refunds it. A due
   date is shown only when something is due, and only if it is still ahead.

**Netting follows the back office's own hierarchy.** `cancelledInvoiceNumber`
links a credit note to the invoice it cancels, so a parent and its children form
a group. A group that sums to zero is left off the listing in one piece — on
C-U332 that is `USI-US26-00047` and the four documents against it — and the
footnote says how many documents went. A *partially* cancelled invoice keeps its
whole group on the page: the reduction is something the reader needs to see, and
the remaining figures then tie to the back office's own "Remaining" line. For
documents the data does not link, the older one-for-one amount match still
applies. 42 tests on the figures and the voice, 41 on the adapter and 10 on the
renderer, including C-U332 end to end.
