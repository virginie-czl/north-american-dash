/**
 * The per-provider commission statement for one Marketplace NA booking.
 *
 * A recap, not an invoice: it consolidates and restates the `NABCO` commission
 * invoices and credit notes already issued to one provider on one booking, and
 * shows the services the commission was computed on. It does not replace those
 * documents — see the footnote, and the open question in the handover about what
 * making it issuable would take.
 *
 * Three things make the figures fragile, and all three are settled by one rule:
 *
 *  - The base is not the provider's GMV. On C-P222 Hyatt supplied 179,753.03 of
 *    services and only 50,193.00 of them carry a commission; the GMV would imply a
 *    1.96% rate against a real 7%.
 *  - The pricing table holds sibling rows that double-count. That same quote
 *    carries `Guestrooms` (297 nights) *and* two `ROH Default - Single room` rows
 *    (80 each, one INDIVIDUAL and one GROUP) at the same unit price. Summing all
 *    three gives 77,233.00.
 *  - Cancelled commission documents cannot be dropped: each comes with a credit
 *    note reversing it, so the pair nets out. Excluding them moves the total.
 *
 * The rule is the reconciliation invariant: the subset of service lines that
 * belongs is the one whose commission equals the net of the commission documents.
 * Nothing is hardcoded, and when no subset reconciles the statement is refused
 * rather than issued with a base that does not lead to its own total.
 */
import {
  documentShell,
  escapeHtml as esc,
  fmtDay,
  fmtLongDay,
  fmtMoney,
  pluralise,
} from "./statement.ts";

export type CommissionDocKind = "INVOICE" | "CREDIT_NOTE";

export type CommissionDoc = {
  /** NABCO-… as printed on the document the provider holds. */
  ref: string;
  kind: CommissionDocKind;
  status: string | null;
  currency: string;
  /** Signed: credit notes are negative, as recorded. */
  amount: number;
  /** ISO day. */
  issued: string | null;
  /** ISO day. */
  due: string | null;
};

export type CommissionService = {
  service: string;
  qty: number | null;
  /** GROUP, INDIVIDUAL, NIGHT… as recorded on the pricing item. */
  unit: string | null;
  unit_excl_tax: number | null;
  rate_pct: number | null;
};

export type CommissionProvider = {
  name: string;
  /** H-XXXX. */
  house_code: string;
  /** O-XXXX. */
  owner_code: string | null;
};

export type CommissionInput = {
  booking: {
    readable_id: string;
    client_name: string;
    event: string;
    /** The Naboo entity that issued the commission documents. */
    billing_entity: string;
  };
  provider: CommissionProvider;
  services: CommissionService[];
  documents: CommissionDoc[];
  currency: string;
  /** From the reconciliation master, not recomputed. */
  commission_ht: number | null;
  commission_ttc: number | null;
  /** ISO day, computed at request time. */
  generatedOn: string;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The stored owner-fee rate as a percentage.
 *
 * `price_option_fees_owner_fees_rate` is a percentage scaled by 10,000: 70000 is
 * 7%, 120000 is 12%. Dividing by 1,000 instead printed 70% in an email to the
 * provider being billed, which is why this now lives in one tested place.
 */
export function ratePctFromStored(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
  return round2(raw / 10000);
}

/** Line total excluding tax: what the commission percentage applies to. */
export function serviceBase(s: CommissionService): number {
  return round2((s.qty ?? 0) * (s.unit_excl_tax ?? 0));
}

/** The commission a set of service lines implies, each at its own rate. */
export function commissionOfServices(services: CommissionService[]): number {
  return round2(
    services.reduce((total, s) => total + (serviceBase(s) * (s.rate_pct ?? 0)) / 100, 0),
  );
}

/** What the provider is actually left owing across every commission document. */
export function netOfDocuments(docs: CommissionDoc[]): number {
  return round2(docs.reduce((total, d) => total + d.amount, 0));
}

export type Reconciliation = {
  ok: boolean;
  /** The service lines that belong: the subset whose commission equals the net. */
  services: CommissionService[];
  base: number;
  /** Commission implied by those lines. Equal to `net` when ok. */
  commission: number;
  net: number;
  /** Distinct rates across the chosen lines. */
  rates: number[];
  /** How many candidate lines were left out to make the figures agree. */
  dropped: number;
  /** Why no statement can be issued, in words the UI can show as-is. */
  reason: string | null;
};

/** Above this many candidate lines an exhaustive subset search is not worth it. */
const MAX_SUBSET_ROWS = 16;
const TOLERANCE = 0.01;

/**
 * Decides which service lines belong, by asking which subset reconciles.
 *
 * The full set is tried first — that is the normal case, and it keeps every line
 * on the document. Only when it disagrees with the documents does this search for
 * a subset that agrees, preferring the largest one so nothing is dropped without
 * cause. Ties break on the bigger base, then on order, so the same input always
 * produces the same statement.
 *
 * A failure is deliberately not a fallback: a commission statement whose base does
 * not lead to its own total is worse than none, because the provider will check it
 * line by line.
 */
export function reconcile(
  services: CommissionService[],
  documents: CommissionDoc[],
): Reconciliation {
  const net = netOfDocuments(documents);
  const fail = (reason: string, chosen = services): Reconciliation => ({
    ok: false,
    services: chosen,
    base: round2(chosen.reduce((t, s) => t + serviceBase(s), 0)),
    commission: commissionOfServices(chosen),
    net,
    rates: distinctRates(chosen),
    dropped: services.length - chosen.length,
    reason,
  });

  if (documents.length === 0) {
    return fail("No commission document has been issued to this provider on this booking.");
  }
  if (services.length === 0) {
    return fail(
      "No commissionable service line was found for this provider, so the commission of " +
        `${fmtMoney(net)} cannot be shown against the services it was computed on.`,
    );
  }

  const candidates = [...services].sort(
    (a, b) => serviceBase(b) - serviceBase(a) || a.service.localeCompare(b.service),
  );

  const good = (subset: CommissionService[]) =>
    Math.abs(commissionOfServices(subset) - net) <= TOLERANCE;

  if (good(candidates)) return success(candidates, net, 0);

  if (candidates.length <= MAX_SUBSET_ROWS) {
    let best: CommissionService[] | null = null;
    for (let mask = 1; mask < 1 << candidates.length; mask++) {
      const subset = candidates.filter((_, i) => mask & (1 << i));
      if (!good(subset)) continue;
      if (
        best == null ||
        subset.length > best.length ||
        (subset.length === best.length &&
          round2(subset.reduce((t, s) => t + serviceBase(s), 0)) >
            round2(best.reduce((t, s) => t + serviceBase(s), 0)))
      ) {
        best = subset;
      }
    }
    if (best) return success(best, net, candidates.length - best.length);
  }

  const all = commissionOfServices(candidates);
  return fail(
    `The commissionable services do not reconcile with the commission documents: ` +
      `${fmtMoney(round2(candidates.reduce((t, s) => t + serviceBase(s), 0)))} of services imply ` +
      `${fmtMoney(all)} of commission, while the documents net to ${fmtMoney(net)}. ` +
      `This is usually a pricing line that has moved since the commission was invoiced, or a ` +
      `commission document that has not reached the warehouse yet.`,
    candidates,
  );
}

function distinctRates(services: CommissionService[]): number[] {
  return [
    ...new Set(services.map((s) => s.rate_pct).filter((r): r is number => r != null && r > 0)),
  ].sort((a, b) => a - b);
}

function success(services: CommissionService[], net: number, dropped: number): Reconciliation {
  return {
    ok: true,
    services,
    base: round2(services.reduce((t, s) => t + serviceBase(s), 0)),
    commission: commissionOfServices(services),
    net,
    rates: distinctRates(services),
    dropped,
    reason: null,
  };
}

/** Latest due date across every commission document, ISO day. */
export function latestDue(docs: CommissionDoc[]): string | null {
  return docs.reduce<string | null>(
    (latest, d) => (d.due && (latest == null || d.due > latest) ? d.due : latest),
    null,
  );
}

export function commissionStatementFilename(
  readableId: string,
  houseCode: string,
  generatedOn: string,
): string {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9._-]/g, "_");
  return `Naboo_commission_${safe(readableId)}_${safe(houseCode)}_${generatedOn}.pdf`;
}

// ── Document ────────────────────────────────────────────────────────────────

function rateLabel(rates: number[]): string {
  if (rates.length === 0) return "—";
  return rates.map((r) => `${r}%`).join(" / ");
}

function quantityLabel(s: CommissionService): string {
  const qty = s.qty ?? 0;
  const unit = (s.unit ?? "").toUpperCase();
  // GROUP and INDIVIDUAL say how the price was built, not what was supplied, so
  // they would read as nonsense on a provider's document. Nights is what a room
  // line is counted in; anything else keeps the recorded word.
  const noun = unit === "GROUP" || unit === "INDIVIDUAL" || !unit ? "nights" : unit.toLowerCase();
  const price = s.unit_excl_tax == null ? "—" : fmtMoney(s.unit_excl_tax);
  return `${fmtMoney(qty).replace(/\.00$/, "")} ${noun} × ${price}`;
}

function serviceRow(s: CommissionService, taxRatio: number): string {
  const base = serviceBase(s);
  const commissionHt = round2((base * (s.rate_pct ?? 0)) / 100);
  const commissionTtc = round2(commissionHt * taxRatio);
  return `<tr>
  <td class="ref">${esc(s.service)}</td>
  <td>${esc(quantityLabel(s))}</td>
  <td class="amount num">${esc(fmtMoney(base))}</td>
  <td class="amount num">${esc(`${s.rate_pct ?? "—"}%`)}</td>
  <td class="amount num">${esc(fmtMoney(commissionHt))}</td>
  <td class="amount num">${esc(fmtMoney(commissionTtc))}</td>
</tr>`;
}

function documentRow(d: CommissionDoc): string {
  const credit = d.amount < 0;
  const type = d.kind === "CREDIT_NOTE" ? `<span class="chip">Credit note</span>` : "Invoice";
  return `<tr>
  <td class="ref">${esc(d.ref)}</td>
  <td>${type}</td>
  <td class="day">${esc(fmtDay(d.issued))}</td>
  <td class="day">${esc(fmtDay(d.due))}</td>
  <td class="amount num${credit ? " credit" : ""}">${esc(fmtMoney(d.amount))}</td>
</tr>`;
}

/**
 * The client and the event in one cell, without saying the client twice.
 *
 * Event names are generated from the company, so the event label often *is* the
 * client name — "Altman Solon · Altman Solon · 21–26 Jun 2026" is what naive
 * concatenation produces.
 */
export function clientEventLabel(client: string, event: string): string {
  const c = client.trim();
  const e = event.trim();
  if (!c) return e || "—";
  if (!e) return c;
  return e === c || e.startsWith(`${c} ·`) || e.startsWith(`${c} `) ? e : `${c} · ${e}`;
}

export type CommissionHtmlOptions = {
  fontBaseUrl?: string;
  contact: { email: string; name: string | null };
};

/**
 * The document. Only ever called with a reconciliation that holds: the caller
 * refuses to render otherwise, so no figure here can contradict another.
 */
export function buildCommissionStatementHtml(
  input: CommissionInput,
  rec: Reconciliation,
  options: CommissionHtmlOptions,
): string {
  const ccy = esc(input.currency);
  const { email, name } = options.contact;
  // The commission's own tax, from the master rather than recomputed: equal to the
  // net on US providers, and genuinely different on European ones. Allocated across
  // the lines in proportion, so the column sums to the figure finance holds.
  const taxRatio =
    input.commission_ht != null && input.commission_ttc != null && input.commission_ht !== 0
      ? input.commission_ttc / input.commission_ht
      : 1;
  const dueOn = latestDue(input.documents);
  const providerLine = [input.provider.house_code, input.provider.owner_code]
    .filter(Boolean)
    .join(" · ");

  const tiles = `
<div class="tiles tiles-2">
  <div class="tile">
    <div class="tile-head"><span class="tile-label">Commissionable base</span></div>
    <div class="tile-figure num">${esc(fmtMoney(rec.base))}</div>
    <div class="tile-caption">${ccy} · excl. tax, ${esc(rateLabel(rec.rates))} rate</div>
  </div>
  <div class="tile tile-due">
    <div class="tile-head">
      <span class="tile-label">Net commission due</span>
      ${dueOn ? `<span class="pill">Due ${esc(fmtDay(dueOn))}</span>` : ""}
    </div>
    <div class="tile-figure tile-figure-due num">${esc(fmtMoney(rec.net))}</div>
    <div class="tile-caption">${ccy} · after credit notes</div>
  </div>
</div>`;

  const servicesSection = `
<section>
  <div class="section-head">
    <h2>Commissionable services</h2>
    <span class="section-qualifier">Only services carrying a commission are listed · amounts in ${ccy}</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Service</th><th>Quantity</th>
        <th class="amount">Base excl. tax</th>
        <th class="amount">Comm. %</th>
        <th class="amount">Commission excl. tax</th>
        <th class="amount">Commission incl. tax</th>
      </tr>
    </thead>
    <tbody>
      ${rec.services.map((s) => serviceRow(s, taxRatio)).join("\n      ")}
      <tr class="total">
        <td colspan="2">Commissionable base and commission</td>
        <td class="amount num">${esc(fmtMoney(rec.base))}</td>
        <td></td>
        <td class="amount num">${esc(fmtMoney(rec.commission))}</td>
        <td class="amount num">${esc(fmtMoney(round2(rec.commission * taxRatio)))}</td>
      </tr>
    </tbody>
  </table>
</section>`;

  const documentsSection = `
<section>
  <div class="section-head">
    <h2>Commission documents</h2>
    <span class="section-qualifier">Commission documents for this provider on this booking</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Document</th><th>Type</th><th>Issued</th><th>Due</th>
        <th class="amount">Amount (${ccy})</th>
      </tr>
    </thead>
    <tbody>
      ${input.documents.map(documentRow).join("\n      ")}
      <tr class="total">
        <td colspan="4">Net commission due</td>
        <td class="amount num">${esc(fmtMoney(rec.net))}</td>
      </tr>
    </tbody>
  </table>
</section>`;

  const closing = `
<div class="closing">
  <div>
    <div class="closing-title">Net commission due</div>
    <div class="closing-sub">Payable to ${esc(input.booking.billing_entity)}${
      dueOn ? ` by ${esc(fmtDay(dueOn))}` : ""
    } · reference ${esc(input.booking.readable_id)} · ${esc(input.provider.house_code)}</div>
  </div>
  <div class="closing-figure">
    <div class="closing-amount num">${esc(fmtMoney(rec.net))}</div>
    <div class="closing-ccy">${ccy}</div>
  </div>
</div>`;

  const droppedNote =
    rec.dropped > 0
      ? ` ${pluralise(rec.dropped, "pricing line")} recorded against this quote ${
          rec.dropped === 1 ? "is" : "are"
        } not listed: ${
          rec.dropped === 1 ? "it duplicates" : "they duplicate"
        } services already priced above, and including ${
          rec.dropped === 1 ? "it" : "them"
        } would not agree with the commission actually invoiced.`
      : "";

  return documentShell({
    kind: "Commission statement",
    reference: input.booking.readable_id,
    label: "COMMISSION STATEMENT",
    generatedOn: input.generatedOn,
    currencies: input.currency,
    metaCells: [
      { label: "Billed to", value: input.provider.name },
      {
        label: "Client / event",
        value: clientEventLabel(input.booking.client_name, input.booking.event),
      },
      { label: "Provider", value: providerLine || "—" },
      { label: "Billing entity", value: input.booking.billing_entity },
    ],
    bodyHtml: `${tiles}\n${servicesSection}\n${documentsSection}\n${closing}`,
    footnoteHtml: `This statement consolidates and restates the commission invoices and credit
    notes already issued to ${esc(
      input.provider.name,
    )} for this booking; it does not replace them, and it
    is not itself an invoice. Generated from Naboo's finance records on ${esc(
      fmtLongDay(input.generatedOn),
    )}.${esc(droppedNote)}
    Questions on this statement: <a href="mailto:${esc(email)}">${esc(email)}</a>${
      name ? ` (${esc(name)}, event manager)` : ""
    }.`,
    contactEmail: email,
    fontBaseUrl: options.fontBaseUrl,
  });
}
