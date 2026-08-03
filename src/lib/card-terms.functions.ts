/**
 * The manual half of Card tracking NA: what the provider will accept, and what
 * Naboo decided.
 *
 * Attribution comes from the session cookie, never from the client, and the same
 * validation the table runs before it lets you save runs again here — a tab left
 * open while someone else edited the row must not be able to store a contradiction
 * (a fee on a refusing provider, or a silent "we don't pay by card" with no reason).
 */
import { createServerFn } from "@tanstack/react-start";
import type { CardEvidence, CardTerms, CardTermsInput, CardYesNo } from "./card-tracking";

const YES_NO: CardYesNo[] = ["yes", "no"];

function yesNo(value: unknown): CardYesNo | null {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  return (YES_NO as string[]).includes(v) ? (v as CardYesNo) : null;
}

function text(value: unknown, max = 2000): string | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  return v.slice(0, max);
}

function money(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

function ownerCode(value: unknown): string {
  const code = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!/^O-[A-Z0-9]{2,12}$/.test(code)) throw new Error("Invalid provider code");
  return code;
}

function rowToTerms(r: Record<string, unknown>, iso: (v: unknown) => string | null): CardTerms {
  return {
    owner_code: String(r.owner_code),
    accepts_card: yesNo(r.accepts_card),
    // numeric comes back as a string from the driver.
    fee_percent: r.fee_percent == null ? null : Number(r.fee_percent),
    fee_fixed: r.fee_fixed == null ? null : Number(r.fee_fixed),
    fee_currency: (r.fee_currency as string) ?? null,
    refusal_reason: (r.refusal_reason as string) ?? null,
    naboo_pays_card: yesNo(r.naboo_pays_card),
    naboo_reason: (r.naboo_reason as string) ?? null,
    updated_by: (r.updated_by as string) ?? null,
    updated_at: iso(r.updated_at),
  };
}

/** Readable by anyone allowed on the tracker — these are shared team decisions. */
export const fetchCardTerms = createServerFn({ method: "GET" }).handler(
  async (): Promise<CardTerms[]> => {
    const { requireTracker } = await import("./session.server");
    await requireTracker("na-cards");
    const { db, isoOrNull } = await import("./db.server");
    const sql = await db();
    const rows = await sql<Record<string, unknown>[]>`
      SELECT owner_code, accepts_card, fee_percent, fee_fixed, fee_currency,
             refusal_reason, naboo_pays_card, naboo_reason, updated_by, updated_at
      FROM provider_card_terms
    `;
    return rows.map((r) => rowToTerms(r, isoOrNull));
  },
);

/**
 * The card evidence for every provider, keyed by `O-` code.
 *
 * Slack approvals are matched on the owner code, which is exact. The Gmail scan is
 * keyed by booking and by a slug of the partner's *name*, so the caller has to say
 * which names belong to which provider — hence the aliases. A provider can have one
 * verdict per booking, and they are not equally current: the most recently decided
 * one wins, full stop, in either direction. An old acceptance does not outlive a
 * fresh refusal — a provider that took card two years ago and declined it last week
 * is a provider that currently declines it, and the reverse holds just as well.
 *
 * Reading this never calls Slack. The mirror is refreshed by the button alone.
 */
export type CardEvidenceResult = {
  evidence: Array<{ owner_code: string } & CardEvidence>;
  syncedAgeSeconds: number | null;
};

/**
 * The evidence for a set of providers.
 *
 * Separate from the server function so the task board can reach the same answer without
 * a second copy of the matching rules — the Slack code match and the alias-keyed email
 * scan are exactly the kind of thing that drifts when duplicated. Reading this never
 * calls Slack; the mirror is refreshed by its own button alone.
 */
export async function loadCardEvidence(
  providers: Array<{ owner_code: string; aliases: string[] }>,
): Promise<CardEvidenceResult> {
  {
    const data = { providers };
    const { db } = await import("./db.server");
    const sql = await db();

    const approvals = await sql<
      { owner_code: string; approval_count: number | null; approved_at: Date | null }[]
    >`
        SELECT owner_code, approval_count, approved_at FROM slack_card_approvals
      `;
    const approved = new Map(
      approvals.map((a) => [
        a.owner_code.trim().toUpperCase(),
        {
          count: Number(a.approval_count ?? 1),
          lastAt: a.approved_at ? a.approved_at.toISOString().slice(0, 10) : null,
        },
      ]),
    );

    const ageRows = await sql<{ age: number | null }[]>`
        SELECT EXTRACT(EPOCH FROM (now() - MAX(synced_at)))::int AS age FROM slack_card_approvals
      `;

    const facts = await sql<
      { partner_key: string; card_payment: string; card_decided_at: Date | null }[]
    >`
        SELECT partner_key, card_payment, card_decided_at FROM partner_email_facts
        WHERE card_payment <> 'unknown'
      `;
    const { partnerKey } = await import("./annotations.functions");
    const decidedByKey = new Map<string, Array<{ card_payment: string; card_decided_at: Date | null }>>();
    for (const f of facts) {
      const arr = decidedByKey.get(f.partner_key) ?? [];
      arr.push({ card_payment: f.card_payment, card_decided_at: f.card_decided_at });
      decidedByKey.set(f.partner_key, arr);
    }

    const evidence = data.providers.map((p) => {
      // The most recently decided verdict across every alias and every booking wins —
      // never "any acceptance ever", which would let a stale yes outrank a fresh no.
      let latest: { card_payment: string; card_decided_at: Date } | null = null;
      for (const alias of p.aliases) {
        const key = partnerKey(alias);
        if (!key) continue;
        for (const f of decidedByKey.get(key) ?? []) {
          if (!f.card_decided_at) continue;
          if (!latest || f.card_decided_at > latest.card_decided_at) {
            latest = { card_payment: f.card_payment, card_decided_at: f.card_decided_at };
          }
        }
      }
      const cards = approved.get(p.owner_code);
      return {
        owner_code: p.owner_code,
        slackApproved: cards != null,
        approvalCount: cards?.count,
        lastApprovedAt: cards?.lastAt ?? null,
        emailVerdict: (latest?.card_payment as "accepted" | "refused" | undefined) ?? ("unknown" as const),
      };
    });

    return { evidence, syncedAgeSeconds: ageRows[0]?.age ?? null };
  }
}

export const fetchCardEvidence = createServerFn({ method: "POST" })
  .validator((input: { providers: Array<{ owner_code: string; aliases: string[] }> }) => ({
    providers: (input?.providers ?? []).slice(0, 2000).map((p) => ({
      owner_code: String(p.owner_code ?? "")
        .trim()
        .toUpperCase(),
      aliases: (p.aliases ?? []).slice(0, 40).map((a) => String(a ?? "")),
    })),
  }))
  .handler(async ({ data }): Promise<CardEvidenceResult> => {
    const { requireTracker } = await import("./session.server");
    await requireTracker("na-cards");
    return loadCardEvidence(data.providers);
  });

export const saveCardTerms = createServerFn({ method: "POST" })
  .validator(
    (
      input: CardTermsInput & {
        aliases?: string[];
        provider_name?: string;
        venue_types?: string[];
      },
    ) => ({
      owner_code: ownerCode(input?.owner_code),
      accepts_card: yesNo(input?.accepts_card),
      fee_percent: money(input?.fee_percent),
      fee_fixed: money(input?.fee_fixed),
      fee_currency: text(input?.fee_currency, 8)?.toUpperCase() ?? null,
      refusal_reason: text(input?.refusal_reason),
      naboo_pays_card: yesNo(input?.naboo_pays_card),
      naboo_reason: text(input?.naboo_reason),
      aliases: (input?.aliases ?? []).slice(0, 40).map((a) => String(a ?? "")),
      provider_name: String(input?.provider_name ?? "").slice(0, 200),
      venue_types: (input?.venue_types ?? []).slice(0, 20).map((v) => String(v ?? "")),
    }),
  )
  .handler(async ({ data }): Promise<CardTerms> => {
    const { requireTracker } = await import("./session.server");
    const session = await requireTracker("na-cards");

    const { cardStatus, emptyTerms, validateCardTerms } = await import("./card-tracking");
    const { db, isoOrNull } = await import("./db.server");
    const sql = await db();

    // The status the reason requirement hangs off is derived here rather than taken
    // from the client, so a tab that believed the provider refused cannot save a
    // decision with no reason behind it.
    //
    // The aliases come from the client because the Gmail scan is keyed by a slug of
    // the partner's name, which only the provider list knows. They are used to raise
    // the status and never to lower it: an alias whose facts say "refused" lands in
    // the same place as no evidence at all, so a wrong or missing alias can only ask
    // for a reason that was not needed — never waive one that was.
    //
    // The provider's name and classification arrive the same way and under the same
    // rule. `isAirline` can only ever turn "unknown" into "Card OK", which is the
    // direction that *demands* a written reason for a decline, so a client claiming to
    // be an airline can only make this check stricter — never let a bare "no" through.
    const approvals = await sql<{ owner_code: string }[]>`
      SELECT owner_code FROM slack_card_approvals WHERE upper(owner_code) = ${data.owner_code}
    `;
    let emailAccepted = false;
    if (approvals.length === 0 && data.aliases.length > 0) {
      const { partnerKey } = await import("./annotations.functions");
      const keys = [...new Set(data.aliases.map(partnerKey).filter(Boolean))];
      if (keys.length > 0) {
        const hits = await sql<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM partner_email_facts
          WHERE card_payment = 'accepted' AND partner_key = ANY(${keys})
        `;
        emailAccepted = (hits[0]?.n ?? 0) > 0;
      }
    }
    const { isAirline } = await import("./card-tracking");
    const status = cardStatus(
      {
        slackApproved: approvals.length > 0,
        emailVerdict: emailAccepted ? "accepted" : "unknown",
        airline: isAirline({
          provider_name: data.provider_name,
          venue_types: data.venue_types.map((v) => v.trim().toUpperCase()),
        }),
      },
      {
        ...emptyTerms(data.owner_code),
        accepts_card: data.accepts_card,
        fee_percent: data.fee_percent,
        fee_fixed: data.fee_fixed,
      },
    ).status;

    const problem = validateCardTerms(data, status);
    if (problem) throw new Error(problem);

    const rows = await sql<Record<string, unknown>[]>`
      INSERT INTO provider_card_terms (
        owner_code, accepts_card, fee_percent, fee_fixed, fee_currency,
        refusal_reason, naboo_pays_card, naboo_reason, updated_by, updated_at
      ) VALUES (
        ${data.owner_code}, ${data.accepts_card}, ${data.fee_percent}, ${data.fee_fixed},
        ${data.fee_currency}, ${data.refusal_reason}, ${data.naboo_pays_card},
        ${data.naboo_reason}, ${session.email}, now()
      )
      ON CONFLICT (owner_code) DO UPDATE SET
        accepts_card = EXCLUDED.accepts_card,
        fee_percent = EXCLUDED.fee_percent,
        fee_fixed = EXCLUDED.fee_fixed,
        fee_currency = EXCLUDED.fee_currency,
        refusal_reason = EXCLUDED.refusal_reason,
        naboo_pays_card = EXCLUDED.naboo_pays_card,
        naboo_reason = EXCLUDED.naboo_reason,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING owner_code, accepts_card, fee_percent, fee_fixed, fee_currency,
                refusal_reason, naboo_pays_card, naboo_reason, updated_by, updated_at
    `;
    return rowToTerms(rows[0], isoOrNull);
  });
