/**
 * Annotation storage server functions — comments, partner outreach statuses and
 * PO emission tracking, stored in BigQuery (`finance_ops` dataset) instead of Supabase.
 *
 * All mutations require an authenticated @naboo.app session; author attribution is
 * resolved server-side from the session cookie, never trusted from the client.
 * All queries are parameterized — no string interpolation of user input.
 */
import { createServerFn } from "@tanstack/react-start";

const DATASET = "finance_ops";
const T_COMMENTS = `\`${DATASET}.sla_event_comments\``;
const T_PARTNER_STATUS = `\`${DATASET}.sla_partner_status\``;
const T_PO_EMISSION = `\`${DATASET}.sla_po_emission\``;

export type PartnerStatusValue =
  | "not_contacted"
  | "waiting_bank"
  | "partially_paid"
  | "fully_paid";

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
    const { runBigQuery } = await import("./bigquery.server");
    const rows = await runBigQuery(
      `SELECT event_ref, partner_key, partner_name, status,
              FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', updated_at) AS updated_at
       FROM ${T_PARTNER_STATUS}`,
    );
    return rows as unknown as PartnerStatusRow[];
  },
);

export const savePartnerStatus = createServerFn({ method: "POST" })
  .validator(
    (input: { event_ref: string; partner_name: string; status: PartnerStatusValue }) => {
      if (!input?.event_ref || typeof input.event_ref !== "string") {
        throw new Error("event_ref is required");
      }
      if (typeof input.partner_name !== "string") throw new Error("partner_name is required");
      if (!PARTNER_STATUS_VALUES.includes(input.status)) throw new Error("Invalid status");
      return input;
    },
  )
  .handler(async ({ data }) => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { runBigQuery } = await import("./bigquery.server");
    await runBigQuery(
      `MERGE ${T_PARTNER_STATUS} t
       USING (SELECT @event_ref AS event_ref, @partner_key AS partner_key) s
       ON t.event_ref = s.event_ref AND t.partner_key = s.partner_key
       WHEN MATCHED THEN UPDATE SET
         status = @status, partner_name = @partner_name,
         updated_by = @updated_by, updated_at = CURRENT_TIMESTAMP()
       WHEN NOT MATCHED THEN INSERT
         (event_ref, partner_key, partner_name, status, updated_by, updated_at)
         VALUES (@event_ref, @partner_key, @partner_name, @status, @updated_by, CURRENT_TIMESTAMP())`,
      {
        event_ref: data.event_ref,
        partner_key: partnerKey(data.partner_name),
        partner_name: data.partner_name,
        status: data.status,
        updated_by: session.email,
      },
    );
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
    const { runBigQuery } = await import("./bigquery.server");
    const rows = await runBigQuery(
      `SELECT id, event_ref, user_id, user_email, user_name, user_avatar_url, body,
              FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at
       FROM ${T_COMMENTS}
       WHERE event_ref = @event_ref
       ORDER BY created_at ASC`,
      { event_ref: data.event_ref },
    );
    return rows as unknown as EventComment[];
  });

export const fetchCommentSummaries = createServerFn({ method: "GET" }).handler(
  async (): Promise<CommentSummaryRow[]> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { runBigQuery } = await import("./bigquery.server");
    const rows = await runBigQuery(
      `SELECT event_ref, user_id, user_name, user_email, user_avatar_url,
              FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at
       FROM ${T_COMMENTS}
       ORDER BY created_at ASC`,
    );
    return rows as unknown as CommentSummaryRow[];
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
    const { runBigQuery } = await import("./bigquery.server");
    await runBigQuery(
      `INSERT INTO ${T_COMMENTS}
         (id, event_ref, user_id, user_email, user_name, user_avatar_url, body, created_at)
       VALUES (GENERATE_UUID(), @event_ref, @user_id, @user_email, @user_name, @user_avatar_url,
               @body, CURRENT_TIMESTAMP())`,
      {
        event_ref: data.event_ref,
        user_id: session.id,
        user_email: session.email,
        user_name: session.name ?? session.email,
        user_avatar_url: session.picture ?? "",
        body: data.body,
      },
    );
  });

export const deleteEventComment = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => {
    if (!input?.id || typeof input.id !== "string") throw new Error("id is required");
    return input;
  })
  .handler(async ({ data }) => {
    const { requireSession } = await import("./session.server");
    const session = await requireSession();
    const { runBigQuery } = await import("./bigquery.server");
    // Only the comment's author can delete it. Comments imported from the old
    // Supabase export carry a placeholder user_id, so match on email as well.
    await runBigQuery(
      `DELETE FROM ${T_COMMENTS}
       WHERE id = @id AND (user_id = @user_id OR user_email = @user_email)`,
      { id: data.id, user_id: session.id, user_email: session.email },
    );
  });

// ---------------------------------------------------------------------------
// PO emission tracking
// ---------------------------------------------------------------------------

export const fetchPoEmissions = createServerFn({ method: "GET" }).handler(
  async (): Promise<PoEmissionRow[]> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { runBigQuery } = await import("./bigquery.server");
    const rows = await runBigQuery(
      `SELECT event_ref, purchase_order_number,
              FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', emitted_at) AS emitted_at
       FROM ${T_PO_EMISSION}`,
    );
    return rows as unknown as PoEmissionRow[];
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
    const { runBigQuery } = await import("./bigquery.server");
    // Single MERGE over a JSON array parameter — one BigQuery job for the whole batch.
    await runBigQuery(
      `MERGE ${T_PO_EMISSION} t
       USING (
         SELECT
           JSON_VALUE(x, '$.event_ref') AS event_ref,
           JSON_VALUE(x, '$.purchase_order_number') AS purchase_order_number
         FROM UNNEST(JSON_QUERY_ARRAY(@rows_json)) AS x
       ) s
       ON t.event_ref = s.event_ref
       WHEN MATCHED AND t.purchase_order_number != s.purchase_order_number THEN UPDATE SET
         purchase_order_number = s.purchase_order_number,
         emitted_at = CURRENT_TIMESTAMP(),
         updated_by = @updated_by,
         updated_at = CURRENT_TIMESTAMP()
       WHEN NOT MATCHED THEN INSERT
         (event_ref, purchase_order_number, emitted_at, updated_by, updated_at)
         VALUES (s.event_ref, s.purchase_order_number, CURRENT_TIMESTAMP(), @updated_by, CURRENT_TIMESTAMP())`,
      { rows_json: JSON.stringify(data.rows), updated_by: session.email },
    );
  });
