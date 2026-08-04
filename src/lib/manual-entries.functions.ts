/**
 * Reading and writing the hand-typed statement lines.
 *
 * Every function here is gated by `requireTracker("na")` — these figures go onto a document
 * that is sent to a client, so the same check that guards the booking guards them. And
 * `created_by` is taken from the session on the server, never from what the browser sent:
 * the audit trail is the whole reason a stand-in is acceptable at all.
 */
import { createServerFn } from "@tanstack/react-start";
import {
  signedAmount,
  validateManualEntry,
  type ManualEntry,
  type ManualKind,
} from "./manual-entries";

type Row = {
  id: string | number;
  event_ref: string;
  kind: string;
  document_ref: string | null;
  issued_on: Date | string | null;
  due_on: Date | string | null;
  amount: string | number;
  currency: string;
  method: string | null;
  note: string | null;
  created_by: string;
  created_at: Date | null;
};

function toEntry(
  row: Row,
  isoOrNull: (v: unknown) => string | null,
  dayOrNull: (v: unknown) => string | null,
): ManualEntry {
  return {
    id: Number(row.id),
    event_ref: row.event_ref,
    kind: (row.kind === "credit_note" || row.kind === "payment"
      ? row.kind
      : "invoice") as ManualKind,
    document_ref: row.document_ref,
    issued_on: dayOrNull(row.issued_on),
    due_on: dayOrNull(row.due_on),
    amount: Number(row.amount),
    currency: row.currency,
    method: row.method,
    note: row.note,
    created_by: row.created_by,
    created_at: isoOrNull(row.created_at) ?? "",
  };
}

/** Every hand-typed line on one booking. Server-internal: the statement builder calls it too. */
export async function readManualEntries(eventRef: string): Promise<ManualEntry[]> {
  const { db, isoOrNull, dayOrNull } = await import("./db.server");
  const sql = await db();
  const rows = await sql<Row[]>`
    SELECT id, event_ref, kind, document_ref, issued_on, due_on, amount, currency,
           method, note, created_by, created_at
    FROM manual_statement_entries
    WHERE event_ref = ${eventRef}
    ORDER BY issued_on NULLS LAST, id
  `;
  return rows.map((r) => toEntry(r, isoOrNull, dayOrNull));
}

/**
 * Deletes the stand-ins the warehouse has caught up with.
 *
 * Called from the statement assembly with the ids `reconcile` named, so the cleanup is a
 * side effect of using the document rather than a job somebody has to remember to run.
 */
export async function deleteSuperseded(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { db } = await import("./db.server");
  const sql = await db();
  const rows = await sql<{ id: string }[]>`
    DELETE FROM manual_statement_entries WHERE id = ANY(${ids}) RETURNING id
  `;
  return rows.length;
}

const REF = /^[A-Z]-[A-Z0-9]{2,12}$/;

function cleanRef(value: unknown): string {
  const ref = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!REF.test(ref)) throw new Error("Invalid booking reference");
  return ref;
}

function cleanText(value: unknown, max: number): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function cleanDay(value: unknown): string | null {
  const day = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

type Input = {
  event_ref: string;
  kind: string;
  document_ref?: string | null;
  issued_on?: string | null;
  due_on?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  method?: string | null;
  note?: string | null;
};

function validated(input: Input) {
  const kind: ManualKind =
    input?.kind === "credit_note"
      ? "credit_note"
      : input?.kind === "payment"
        ? "payment"
        : "invoice";
  const amountRaw = input?.amount == null ? null : Number(input.amount);
  const clean = {
    event_ref: cleanRef(input?.event_ref),
    kind,
    document_ref: cleanText(input?.document_ref, 60),
    issued_on: cleanDay(input?.issued_on),
    // A payment has no due date, and letting one through would put a date on a line that
    // cannot be due.
    due_on: kind === "payment" ? null : cleanDay(input?.due_on),
    amount: amountRaw != null && Number.isFinite(amountRaw) ? amountRaw : null,
    currency: (cleanText(input?.currency, 8) ?? "").toUpperCase() || null,
    method: kind === "payment" ? cleanText(input?.method, 60) : null,
    note: cleanText(input?.note, 500),
  };
  // The same rule the form applies, applied again here: a stale tab must not be able to
  // store a zero, a reversed date pair or a document with no reference.
  const problem = validateManualEntry(clean);
  if (problem) throw new Error(problem);
  return {
    ...clean,
    currency: clean.currency!,
    // The sign belongs to the type, never to what was typed.
    amount: signedAmount(kind, clean.amount!),
  };
}

export const listManualEntries = createServerFn({ method: "GET" })
  .validator((input: { event_ref: string }) => ({ event_ref: cleanRef(input?.event_ref) }))
  .handler(async ({ data }): Promise<ManualEntry[]> => {
    const { requireTracker } = await import("./session.server");
    await requireTracker("na");
    return readManualEntries(data.event_ref);
  });

export const createManualEntry = createServerFn({ method: "POST" })
  .validator((input: Input) => validated(input))
  .handler(async ({ data }): Promise<ManualEntry> => {
    const { requireTracker } = await import("./session.server");
    const session = await requireTracker("na");
    const { db, isoOrNull, dayOrNull } = await import("./db.server");
    const sql = await db();
    const rows = await sql<Row[]>`
      INSERT INTO manual_statement_entries
        (event_ref, kind, document_ref, issued_on, due_on, amount, currency, method, note, created_by)
      VALUES (
        ${data.event_ref}, ${data.kind}, ${data.document_ref}, ${data.issued_on}, ${data.due_on},
        ${data.amount}, ${data.currency}, ${data.method}, ${data.note}, ${session.email}
      )
      RETURNING id, event_ref, kind, document_ref, issued_on, due_on, amount, currency,
                method, note, created_by, created_at
    `;
    return toEntry(rows[0], isoOrNull, dayOrNull);
  });

/**
 * Edits one line. Anyone with the tracker may edit anyone's: the audit trail is
 * `created_by` and the tooltip beside the row, not a lock — a wrong figure on a document
 * about to be sent has to be fixable by whoever is looking at it.
 */
export const updateManualEntry = createServerFn({ method: "POST" })
  .validator((input: Input & { id: number }) => ({ ...validated(input), id: Number(input?.id) }))
  .handler(async ({ data }): Promise<ManualEntry> => {
    const { requireTracker } = await import("./session.server");
    await requireTracker("na");
    const { db, isoOrNull, dayOrNull } = await import("./db.server");
    const sql = await db();
    const rows = await sql<Row[]>`
      UPDATE manual_statement_entries SET
        kind = ${data.kind}, document_ref = ${data.document_ref}, issued_on = ${data.issued_on},
        due_on = ${data.due_on}, amount = ${data.amount}, currency = ${data.currency},
        method = ${data.method}, note = ${data.note}
      WHERE id = ${data.id} AND event_ref = ${data.event_ref}
      RETURNING id, event_ref, kind, document_ref, issued_on, due_on, amount, currency,
                method, note, created_by, created_at
    `;
    if (rows.length === 0) throw new Error("That line no longer exists.");
    return toEntry(rows[0], isoOrNull, dayOrNull);
  });

export const deleteManualEntry = createServerFn({ method: "POST" })
  .validator((input: { id: number; event_ref: string }) => ({
    id: Number(input?.id),
    event_ref: cleanRef(input?.event_ref),
  }))
  .handler(async ({ data }): Promise<{ deleted: boolean }> => {
    const { requireTracker } = await import("./session.server");
    await requireTracker("na");
    const { db } = await import("./db.server");
    const sql = await db();
    const rows = await sql<{ id: string }[]>`
      DELETE FROM manual_statement_entries
      WHERE id = ${data.id} AND event_ref = ${data.event_ref}
      RETURNING id
    `;
    return { deleted: rows.length > 0 };
  });

/**
 * How far the warehouse has caught up on one invoice series.
 *
 * The series rather than the booking: the question a reader is asking is "how current is
 * this data", and one booking can be quiet for weeks while the entity keeps issuing. Cached
 * on the prefix, so every booking billed by the same entity shares one answer and opening a
 * drawer does not pay for a BigQuery run.
 */
export const getSeriesSync = createServerFn({ method: "GET" })
  .validator((input: { prefix: string }) => {
    const prefix = String(input?.prefix ?? "").trim();
    // "USI-US26-" and nothing else — this goes into a LIKE pattern.
    if (!/^[A-Za-z]+-[A-Za-z]{2}\d{2}-$/.test(prefix)) throw new Error("Invalid series prefix");
    return { prefix: prefix.toUpperCase() };
  })
  .handler(async ({ data }): Promise<{ prefix: string; syncedUpTo: string | null }> => {
    const { requireTracker } = await import("./session.server");
    await requireTracker("na");
    const { readCache, writeCache } = await import("./query-cache.server");
    const key = `statement-series-sync::${data.prefix}`;
    const hit = await readCache<{ prefix: string; syncedUpTo: string | null }>(key, 600);
    if (hit) return hit;

    const { runBigQuery } = await import("./bigquery.server");
    const rows = (await runBigQuery(
      `SELECT MAX(CAST(DATE(i.issueDate) AS STRING)) AS synced_up_to
       FROM \`naboo-app-365515.raw_naboo_data.invoices\` i
       WHERE i.invoiceDirection = 'INCOME'
         AND STARTS_WITH(UPPER(i.invoiceNumber), @prefix)`,
      { prefix: data.prefix },
    )) as unknown as Array<{ synced_up_to: string | null }>;
    const result = {
      prefix: data.prefix,
      syncedUpTo: rows[0]?.synced_up_to == null ? null : String(rows[0].synced_up_to).slice(0, 10),
    };
    await writeCache(key, result);
    return result;
  });
