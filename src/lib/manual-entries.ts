/**
 * Documents and payments entered by hand, and the rule that stops them being counted
 * twice — pure, because this is the one calculation here that can put a confidently wrong
 * number on a page a client reads.
 *
 * The warehouse lags the back office. Measured on 4 August 2026 the `USI-US26` series
 * stopped at 00058 while 00063 already existed, so a statement generated that day silently
 * under-billed by five documents while saying it was generated today. A manual entry is the
 * stand-in for one of those, and it lives exactly as long as the gap does.
 *
 * **The whole point is what happens when the warehouse catches up.** A manual entry is not
 * a record; it is a placeholder for a record that exists elsewhere. The moment BigQuery
 * reports the real document, the placeholder has to go — a union that keeps both counts the
 * invoice twice and overstates the balance, which is the same failure the feature exists to
 * prevent, pointed the other way. So `reconcile` returns the ids to delete, and the caller
 * deletes them in the same request that assembles the statement: the cleanup is a side
 * effect of use, needs no job, and is idempotent because the second run finds nothing left.
 *
 * BigQuery always wins. It is the system of record and the real document carries its own
 * audit trail; the hand-typed stand-in carries only somebody's good intentions.
 */

export type ManualKind = "invoice" | "credit_note" | "payment";

export type ManualEntry = {
  id: number;
  event_ref: string;
  kind: ManualKind;
  /** Invoice number, or a payment's own reference. Null is allowed on a payment. */
  document_ref: string | null;
  /** ISO day. For a payment this is the day the money arrived. */
  issued_on: string | null;
  /** ISO day. Invoices and credit notes only. */
  due_on: string | null;
  /** Signed: a credit note is negative. */
  amount: number;
  currency: string;
  /** Payments only. */
  method: string | null;
  note: string | null;
  created_by: string;
  /** ISO timestamp. */
  created_at: string;
};

/** The shapes the statement already speaks, kept structural so this module imports nothing. */
type DocLike = {
  ref: string;
  currency: string;
  amount: number;
  issued: string | null;
  due: string | null;
  kind: "INVOICE" | "CREDIT_NOTE";
  status: string | null;
};

type PaymentLike = {
  paid_on: string | null;
  amount: number;
  currency: string;
  method: string;
  reference: string | null;
};

/**
 * Two references are the same document when they differ only in case, spacing or
 * punctuation. `usi us26 00063`, `USI-US26-00063` and `usi-us26-00063` are one invoice, and
 * a stand-in typed in any of those shapes has to recognise the real one when it lands.
 */
export function normaliseRef(ref: string | null | undefined): string {
  return (ref ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Cents, so two floats that print the same compare the same. */
function cents(amount: number): number {
  return Math.round(amount * 100);
}

/** A payment has no reference of its own, so the same money on the same day is the same money. */
function paymentKey(day: string | null, amount: number, currency: string): string {
  return `${(day ?? "").slice(0, 10)}::${cents(amount)}::${currency.trim().toUpperCase()}`;
}

export type ManualConflict = {
  entryId: number;
  kind: ManualKind;
  reason: "duplicate-payment";
  /** Said in the words the person who typed it will recognise. */
  detail: string;
};

export type Reconciliation = {
  /** Manual entries the warehouse has caught up with. Delete these. */
  supersededIds: number[];
  /** Every document the statement should show — warehouse first, then what survives. */
  documents: DocLike[];
  payments: PaymentLike[];
  /** Manual entries that survived, in case the caller wants to mark them on screen. */
  keptIds: number[];
  /**
   * Manual payments that look like a warehouse payment already counted, and could not be
   * resolved by deleting one of them. Never silently dropped: two payments of the same
   * amount on the same day is a real thing a client can do, and guessing costs either a
   * double count or a lost payment.
   */
  conflicts: ManualConflict[];
};

/**
 * Steps 3 and 4 of assembling a statement: drop the stand-ins the warehouse now carries,
 * then union what is left.
 *
 * Documents match on their reference, which is the number printed on the document the
 * client holds — the only identifier both sides share.
 *
 * Payments have no such number, so they match on day, amount and currency together. Where
 * several manual payments collapse onto one warehouse payment, exactly as many are
 * superseded as there are warehouse rows to supersede them, and the surplus is kept and
 * flagged. That asymmetry is deliberate: deleting a surplus would quietly lose a second
 * genuine payment, and keeping it silently would overstate what has been received.
 */
export function reconcile(input: {
  documents: DocLike[];
  payments: PaymentLike[];
  entries: ManualEntry[];
}): Reconciliation {
  const supersededIds: number[] = [];
  const keptIds: number[] = [];
  const conflicts: ManualConflict[] = [];

  const warehouseRefs = new Set(
    input.documents.map((d) => normaliseRef(d.ref)).filter((r) => r.length > 0),
  );

  // How many warehouse payments each key still has to spare.
  const warehousePayments = new Map<string, number>();
  for (const p of input.payments) {
    const key = paymentKey(p.paid_on, p.amount, p.currency);
    warehousePayments.set(key, (warehousePayments.get(key) ?? 0) + 1);
  }

  const documents = [...input.documents];
  const payments = [...input.payments];

  // Oldest first, so when two identical manual payments meet one warehouse row it is the
  // earlier stand-in that is retired — the later one is the more likely genuine addition.
  const entries = [...input.entries].sort((a, b) => a.id - b.id);

  for (const entry of entries) {
    if (entry.kind === "payment") {
      const key = paymentKey(entry.issued_on, entry.amount, entry.currency);
      const spare = warehousePayments.get(key) ?? 0;
      if (spare > 0) {
        warehousePayments.set(key, spare - 1);
        supersededIds.push(entry.id);
        continue;
      }
      // No warehouse row left to be the twin of. If one existed at all, this is a second
      // payment for the same amount on the same day — real, or typed twice, and this
      // cannot tell which.
      if (input.payments.some((p) => paymentKey(p.paid_on, p.amount, p.currency) === key)) {
        conflicts.push({
          entryId: entry.id,
          kind: entry.kind,
          reason: "duplicate-payment",
          detail:
            "A payment of this amount on this day is already in the finance records. " +
            "Kept, in case the client really paid twice — remove it if it was entered twice.",
        });
      }
      keptIds.push(entry.id);
      payments.push({
        paid_on: entry.issued_on,
        amount: entry.amount,
        currency: entry.currency,
        method: entry.method?.trim() || "Recorded by hand",
        reference: entry.document_ref?.trim() || null,
      });
      continue;
    }

    const ref = normaliseRef(entry.document_ref);
    if (ref.length > 0 && warehouseRefs.has(ref)) {
      supersededIds.push(entry.id);
      continue;
    }
    keptIds.push(entry.id);
    documents.push({
      ref: entry.document_ref?.trim() || "—",
      kind: entry.kind === "credit_note" ? "CREDIT_NOTE" : "INVOICE",
      status: "ISSUED",
      currency: entry.currency,
      amount: entry.amount,
      issued: entry.issued_on,
      due: entry.due_on,
    });
  }

  return { supersededIds, documents, payments, keptIds, conflicts };
}

// ── What a person is allowed to type ────────────────────────────────────────

export type ManualInput = {
  kind: ManualKind;
  document_ref: string | null;
  issued_on: string | null;
  due_on: string | null;
  /** Always the magnitude as typed; the sign comes from `kind`. */
  amount: number | null;
  currency: string | null;
  method: string | null;
  note: string | null;
};

/**
 * The sign belongs to the type, never to what somebody typed.
 *
 * A credit note is negative on a statement. Accepting an unsigned figure and guessing is
 * how a credit ends up adding to the invoiced total, so the toggle decides and a positive
 * number typed under "credit note" becomes negative rather than being second-guessed.
 */
export function signedAmount(kind: ManualKind, amount: number): number {
  const magnitude = Math.abs(amount);
  return kind === "credit_note" ? -magnitude : magnitude;
}

/** What must hold before an entry can be saved. Checked in the form and again on the server. */
export function validateManualEntry(input: ManualInput): string | null {
  if (input.kind !== "invoice" && input.kind !== "credit_note" && input.kind !== "payment") {
    return "Choose an invoice, a credit note or a payment.";
  }
  const amount = input.amount;
  if (amount == null || !Number.isFinite(amount) || Math.abs(amount) < 0.005) {
    // A zero-amount line moves no total and means nothing on a statement.
    return "Give the amount. A zero has nothing to say on a statement.";
  }
  if (!(input.currency ?? "").trim()) return "Give the currency.";
  if (!isDay(input.issued_on)) {
    return input.kind === "payment" ? "Give the date it was paid." : "Give the issue date.";
  }
  if (input.kind !== "payment") {
    if (!(input.document_ref ?? "").trim()) return "Give the document's reference.";
    if (input.due_on != null && input.due_on !== "" && !isDay(input.due_on)) {
      return "The due date has to be a day, as YYYY-MM-DD.";
    }
    // A document due before it was issued is a typo, and it would drive the statement's
    // own "overdue since" line.
    if (isDay(input.due_on) && input.due_on! < input.issued_on!) {
      return "The due date cannot be before the issue date.";
    }
  }
  return null;
}

function isDay(value: string | null | undefined): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * The series this booking's documents are numbered in — "USI-US26-" and so on — taken from
 * the documents already on it rather than from a table of entities, so a seventh entity
 * needs no code change.
 */
export function seriesPrefix(
  documents: Array<{ ref: string; issued: string | null }>,
): string | null {
  const candidates = documents
    .filter((d) => /^[A-Za-z]+-[A-Za-z]{2}\d{2}-\d+$/.test(d.ref.trim()))
    .sort((a, b) => (b.issued ?? "").localeCompare(a.issued ?? ""));
  const latest = candidates[0];
  if (!latest) return null;
  const parts = latest.ref.trim().split("-");
  return `${parts[0]}-${parts[1]}-`;
}

/**
 * A reference that does not look like the series in use. Returns a sentence to show, not a
 * reason to refuse: the pattern is a convention rather than a rule, and blocking a document
 * that genuinely exists would be worse than a typo. A typo caught here is a wrong statement
 * avoided; a block here is a right statement prevented.
 */
export function refWarning(
  ref: string | null,
  documents: Array<{ ref: string; issued: string | null }>,
): string | null {
  const typed = (ref ?? "").trim();
  if (!typed) return null;
  const prefix = seriesPrefix(documents);
  if (!prefix) return null;
  if (typed.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  return `This booking's documents are numbered ${prefix}… — check the reference.`;
}
