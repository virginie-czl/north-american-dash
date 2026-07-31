/**
 * Annotation storage server functions — comments, partner outreach statuses and
 * PO first-emission dates. These are the things the warehouse cannot know: they
 * are created by the team inside the tracker, so they live in the app's own
 * Postgres store rather than in BigQuery.
 *
 * All mutations require an authenticated @naboo.app session; author attribution is
 * resolved server-side from the session cookie, never trusted from the client.
 * Every query is parameterised through the driver — no string interpolation.
 */
import { createServerFn } from "@tanstack/react-start";

export type PartnerStatusValue = "not_contacted" | "waiting_bank" | "partially_paid" | "fully_paid";

export type PartnerStatusRow = {
  event_ref: string;
  partner_key: string;
  partner_name: string | null;
  status: PartnerStatusValue;
  updated_at: string | null;
};

export type EventComment = {
  id: string;
  event_ref: string;
  user_id: string;
  user_email: string;
  user_name: string | null;
  user_avatar_url: string | null;
  body: string;
  created_at: string;
};

export type CommentSummaryRow = {
  event_ref: string;
  user_id: string;
  user_name: string | null;
  user_email: string;
  user_avatar_url: string | null;
  created_at: string;
};

export type PoEmissionRow = {
  event_ref: string;
  purchase_order_number: string;
  emitted_at: string;
};

export function partnerKey(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const PARTNER_STATUS_VALUES: PartnerStatusValue[] = [
  "not_contacted",
  "waiting_bank",
  "partially_paid",
  "fully_paid",
];

// ---------------------------------------------------------------------------
// Partner outreach status
// ---------------------------------------------------------------------------

export const fetchPartnerStatuses = createServerFn({ method: "GET" }).handler(
  async (): Promise<PartnerStatusRow[]> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { db, isoOrNull } = await import("./db.server");
    const sql = await db();
    const rows = await sql<
      {
        event_ref: string;
        partner_key: string;
        partner_name: string | null;
        status: PartnerStatusValue;
        updated_at: Date | null;
      }[]
    >`SELECT event_ref, partner_key, partner_name, status, updated_at
      FROM sla_partner_status`;
    return rows.map((r) => ({ ...r, updated_at: isoOrNull(r.updated_at) }));
  },
);

export const savePartnerStatus = createServerFn({ method: "POST" })
  .validator((input: { event_ref: string; partner_name: string; status: PartnerStatusValue }) => {
    if (!input?.event_ref || typeof input.event_ref !== "string") {
      throw new Error("event_ref is required");
    }
    if (typeof input.partner_name !== "string") throw new Error("partner_name is required");
    if (!PARTNER_STATUS_VALUES.includes(input.status)) throw new Error("Invalid status");
    return input;
  })
  .handler(async ({ data }) => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { db } = await import("./db.server");
    const sql = await db();
    await sql`
      INSERT INTO sla_partner_status
        (event_ref, partner_key, partner_name, status, updated_by, updated_at)
      VALUES (
        ${data.event_ref}, ${partnerKey(data.partner_name)}, ${data.partner_name},
        ${data.status}, ${session.email}, now()
      )
      ON CONFLICT (event_ref, partner_key) DO UPDATE SET
        partner_name = EXCLUDED.partner_name,
        status = EXCLUDED.status,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
    `;
  });

// ---------------------------------------------------------------------------
// Event comments
// ---------------------------------------------------------------------------

export const fetchEventComments = createServerFn({ method: "GET" })
  .validator((input: { event_ref: string }) => {
    if (!input?.event_ref || typeof input.event_ref !== "string") {
      throw new Error("event_ref is required");
    }
    return input;
  })
  .handler(async ({ data }): Promise<EventComment[]> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { db, isoOrNull } = await import("./db.server");
    const sql = await db();
    const rows = await sql<(Omit<EventComment, "created_at"> & { created_at: Date })[]>`
      SELECT id, event_ref, user_id, user_email, user_name, user_avatar_url, body, created_at
      FROM sla_event_comments
      WHERE event_ref = ${data.event_ref}
      ORDER BY created_at ASC
    `;
    return rows.map((r) => ({ ...r, created_at: isoOrNull(r.created_at) ?? "" }));
  });

export const fetchCommentSummaries = createServerFn({ method: "GET" }).handler(
  async (): Promise<CommentSummaryRow[]> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { db, isoOrNull } = await import("./db.server");
    const sql = await db();
    const rows = await sql<(Omit<CommentSummaryRow, "created_at"> & { created_at: Date })[]>`
      SELECT event_ref, user_id, user_name, user_email, user_avatar_url, created_at
      FROM sla_event_comments
      ORDER BY created_at ASC
    `;
    return rows.map((r) => ({ ...r, created_at: isoOrNull(r.created_at) ?? "" }));
  },
);

export const addEventComment = createServerFn({ method: "POST" })
  .validator((input: { event_ref: string; body: string }) => {
    if (!input?.event_ref || typeof input.event_ref !== "string") {
      throw new Error("event_ref is required");
    }
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!body) throw new Error("Comment body is required");
    if (body.length > 5000) throw new Error("Comment is too long");
    return { event_ref: input.event_ref, body };
  })
  .handler(async ({ data }) => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { db } = await import("./db.server");
    const sql = await db();
    await sql`
      INSERT INTO sla_event_comments
        (id, event_ref, user_id, user_email, user_name, user_avatar_url, body, created_at)
      VALUES (
        ${crypto.randomUUID()}, ${data.event_ref}, ${session.id}, ${session.email},
        ${session.name ?? session.email}, ${session.picture}, ${data.body}, now()
      )
    `;
  });

export const deleteEventComment = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => {
    if (!input?.id || typeof input.id !== "string") throw new Error("id is required");
    return input;
  })
  .handler(async ({ data }) => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { db } = await import("./db.server");
    const sql = await db();
    // Only the comment's author can delete it. Comments imported from the old
    // export carry a placeholder user_id, so match on email as well.
    await sql`
      DELETE FROM sla_event_comments
      WHERE id = ${data.id}
        AND (user_id = ${session.id} OR user_email = ${session.email})
    `;
  });

// ---------------------------------------------------------------------------
// PO first-emission dates
//
// BigQuery exposes the PO number and the row's last sync timestamp, but not when
// the PO first appeared — and the payout SLA deadline is measured from that date.
// The tracker therefore records it the first time it sees each PO.
// ---------------------------------------------------------------------------

export const fetchPoEmissions = createServerFn({ method: "GET" }).handler(
  async (): Promise<PoEmissionRow[]> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { db, isoOrNull } = await import("./db.server");
    const sql = await db();
    const rows = await sql<
      { event_ref: string; purchase_order_number: string; emitted_at: Date }[]
    >`SELECT event_ref, purchase_order_number, emitted_at FROM sla_po_emission`;
    return rows.map((r) => ({ ...r, emitted_at: isoOrNull(r.emitted_at) ?? "" }));
  },
);

export const upsertPoEmissions = createServerFn({ method: "POST" })
  .validator((input: { rows: Array<{ event_ref: string; purchase_order_number: string }> }) => {
    if (!Array.isArray(input?.rows)) throw new Error("rows is required");
    const rows = input.rows
      .filter(
        (r) =>
          r &&
          typeof r.event_ref === "string" &&
          r.event_ref.length > 0 &&
          typeof r.purchase_order_number === "string" &&
          r.purchase_order_number.length > 0,
      )
      .slice(0, 500);
    return { rows };
  })
  .handler(async ({ data }) => {
    if (data.rows.length === 0) return;
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { db } = await import("./db.server");
    const sql = await db();
    const payload = data.rows.map((r) => ({
      event_ref: r.event_ref,
      purchase_order_number: r.purchase_order_number,
    }));
    // One statement for the whole batch. An existing row only moves its
    // emitted_at when the PO number actually changed.
    await sql`
      INSERT INTO sla_po_emission
        (event_ref, purchase_order_number, emitted_at, updated_by, updated_at)
      SELECT x.event_ref, x.purchase_order_number, now(), ${session.email}, now()
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
        AS x(event_ref text, purchase_order_number text)
      ON CONFLICT (event_ref) DO UPDATE SET
        purchase_order_number = EXCLUDED.purchase_order_number,
        emitted_at = now(),
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      WHERE sla_po_emission.purchase_order_number <> EXCLUDED.purchase_order_number
    `;
  });
