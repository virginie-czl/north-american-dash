/**
 * The two screens both trackers share: an action list, and one event.
 *
 * They are presentation only. Every sentence, figure and verdict is built by
 * the page that owns the data — what lives here is the layout the design
 * specifies, so L'Oréal CA and Marketplace NA cannot drift apart.
 */
import { useState, type ReactNode } from "react";
import {
  BreadcrumbBar,
  DownloadLink,
  OutlineButton,
  PaperCheckbox,
  PaperLink,
  PrimaryButton,
  SectionLabel,
  StatStrip,
  ccyLabel,
  type StatCell,
} from "./paper";

/**
 * A row on an action list, and the sentence that explains it.
 *
 * The sentence is split so the counterparty can carry the emphasis — "Ask
 * **Espace Canal** for bank details" — without the row having to parse a string
 * back apart.
 */
export type PaperRow = {
  id: string;
  /** The event or booking this row belongs to — the sentence opens it. */
  ref: string;
  lead: string;
  strong: string;
  tail: string;
  /** Mono: ref · client · type · dates. */
  meta: string;
  state: string | null;
  /** The state line names a breach: it is the only thing on the row in alert. */
  stateAlert?: boolean;
  a: string;
  b: string;
  /** Currency suffixes, where a tracker runs in several at once. */
  aCcy?: string | null;
  bCcy?: string | null;
  trail: string;
  trailAlert?: boolean;
  aAlert?: boolean;
  /** Present when the row can be emailed — it is then selectable. */
  target?: unknown;
};

/**
 * An action list.
 *
 * One screen per action type: a title that reads as the instruction, the rule
 * that produced the work, and the rows — each a sentence, its evidence in mono,
 * what is already known, and the two figures that decide priority. Selection and
 * the send buttons only appear on a list that actually sends an email.
 */
export function ListScreen({
  crumb,
  title,
  explanation,
  columns,
  unitNoun,
  rows,
  selected,
  onToggle,
  primary,
  secondary,
  siblings,
  filters,
  isLoading,
  onBack,
  onDownload,
  onOpen,
}: {
  crumb: string;
  title: string;
  explanation: string;
  columns: [string, string, string];
  unitNoun: string;
  rows: PaperRow[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  primary?: { label: string; onClick: () => void; disabled?: boolean };
  secondary?: { label: string; onClick: () => void; disabled?: boolean };
  siblings: Array<{ key: string; label: string; count: number; onClick: () => void }>;
  filters?: ReactNode;
  isLoading: boolean;
  onBack: () => void;
  onDownload: () => void;
  onOpen: (ref: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const selectable = rows.some((r) => r.target != null);
  const visible = showAll ? rows : rows.slice(0, 12);
  const hidden = rows.length - visible.length;
  const grid = "grid-cols-[22px_1fr_150px_150px_132px]";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-paper-canvas font-paper text-paper-ink">
      <BreadcrumbBar
        crumbs={[{ label: "Overview", onClick: onBack }, { label: crumb }]}
        right={
          <>
            {filters}
            <DownloadLink onClick={onDownload}>Download this list</DownloadLink>
            {siblings.map((s) => (
              <PaperLink key={s.key} onClick={s.onClick}>
                {s.label}{" "}
                <span className="font-paper-mono text-[11.5px] text-paper-label">{s.count}</span>
              </PaperLink>
            ))}
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-8 px-8 pb-[26px] pt-9">
        <div className="min-w-[420px] flex-1">
          <h1 className="font-paper-display text-[34px] leading-[1.1]">{title}</h1>
          <p className="mt-2.5 max-w-[760px] text-[13.5px] text-paper-muted [text-wrap:pretty]">
            {explanation}
          </p>
        </div>
        {(primary || secondary) && (
          <div className="ml-auto flex items-center gap-3">
            {selectable && (
              <span className="text-[12.5px] text-paper-muted">{selected.size} selected</span>
            )}
            {secondary && (
              <OutlineButton onClick={secondary.onClick} disabled={secondary.disabled}>
                {secondary.label}
              </OutlineButton>
            )}
            {primary && (
              <PrimaryButton onClick={primary.onClick} disabled={primary.disabled}>
                {primary.label}
              </PrimaryButton>
            )}
          </div>
        )}
      </div>

      <div
        className={`grid ${grid} gap-6 border-y border-paper-rule px-8 py-2.5 text-[10.5px] uppercase tracking-[0.16em] text-paper-label`}
      >
        <span>·</span>
        <span>Action</span>
        <span className="text-right">{columns[0]}</span>
        <span className="text-right">{columns[1]}</span>
        <span className="text-right">{columns[2]}</span>
      </div>

      {isLoading && <p className="px-8 py-10 text-[13.5px] text-paper-muted">Loading…</p>}
      {!isLoading && rows.length === 0 && (
        <div className="px-8 py-14">
          <div className="font-paper-display text-[26px]">Nothing in this list</div>
          <p className="mt-2 max-w-[560px] text-[13.5px] leading-relaxed text-paper-muted">
            Either the work is done, or the filters have narrowed it away.
          </p>
        </div>
      )}

      {visible.map((row, i) => (
        <div
          key={row.id}
          className={`grid ${grid} items-start gap-6 border-b border-paper-hairline px-8 py-5 ${
            row.stateAlert ? "bg-paper-row" : "hover:bg-paper-row"
          }`}
        >
          {row.target ? (
            <PaperCheckbox
              checked={selected.has(row.id)}
              onChange={() => onToggle(row.id)}
              label={`Select ${row.strong}`}
            />
          ) : (
            <span className="mt-1 font-paper-mono text-[13px] text-paper-label">
              {String(i + 1).padStart(2, "0")}
            </span>
          )}
          <span className="min-w-0">
            <button
              type="button"
              onClick={() => onOpen(row.ref)}
              className="block text-left text-[16.5px] leading-[1.4] underline-offset-[3px] hover:underline"
            >
              {row.lead} <span className="font-medium">{row.strong}</span> {row.tail}
            </button>
            <span className="mt-1.5 block font-paper-mono text-[12px] text-paper-muted">
              {row.meta}
            </span>
            {row.state && (
              <span
                className={`mt-1.5 block text-[12.5px] ${
                  row.stateAlert ? "text-paper-alert" : "text-paper-muted"
                }`}
              >
                {row.state}
              </span>
            )}
          </span>
          <span
            className={`text-right text-[15.5px] tabular-nums ${row.aAlert ? "text-paper-alert" : ""}`}
          >
            {row.a}
            {row.aCcy && (
              <span className="ml-1 text-[11px] text-paper-label">{ccyLabel(row.aCcy)}</span>
            )}
          </span>
          <span className="text-right text-[15.5px] tabular-nums">
            {row.b}
            {row.bCcy && (
              <span className="ml-1 text-[11px] text-paper-label">{ccyLabel(row.bCcy)}</span>
            )}
          </span>
          <span
            className={`text-right text-[13px] ${
              row.trailAlert ? "text-paper-alert" : "text-paper-muted"
            }`}
          >
            {row.trail}
          </span>
        </div>
      ))}

      {hidden > 0 && (
        <div className="flex items-center gap-4 px-8 py-4 text-[13px] text-paper-muted">
          <span>
            {hidden} more {unitNoun} in this list
          </span>
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="ml-auto border-b border-paper-ink pb-0.5 text-paper-ink"
          >
            Show all {rows.length}
          </button>
        </div>
      )}
    </div>
  );
}

/** A move that can still be made on this event, as a sentence and a button. */
export type EventMove = {
  id: string;
  lead: string;
  strong: string;
  tail: string;
  reason: string;
  reasonAlert?: boolean;
  action?: { label: string; primary?: boolean; onClick: () => void };
};

export type EventPartnerRow = {
  key: string;
  name: string;
  /** "compta@espacecanal.ca · venue · locked by admin" */
  contact: string;
  state: string;
  stateAlert?: boolean;
  /** A second, quieter line — what our emails with them say, when we asked. */
  note?: string | null;
  /** A line nobody has to act on — a provision leg, or a settled partner. */
  muted?: boolean;
  /** Two on L'Oréal (due / paid), three on Marketplace NA. */
  figures: Array<{ label: string; value: string; note?: string | null; alert?: boolean }>;
  /** "Supplier summary", "Summarise our emails" — whatever this row can do. */
  links?: ReactNode;
};

/**
 * One event, as the design has it: what is true, what can be done about it, and
 * the trail of how it got here — no pills anywhere, every state a sentence.
 */
export function EventScreen({
  crumbs,
  onPrev,
  onNext,
  statement,
  backOffice,
  eventLabel,
  reference,
  po,
  meta,
  stats,
  moves,
  partnersLabel = "Partners",
  partners,
  subtotal,
  invoices,
  onClientStatement,
  clientStatementLabel,
  history,
  rail,
  notes,
  panel,
  caption,
  titleNote,
  movesLabel = "Next moves on this event",
}: {
  crumbs: Array<{ label: string; onClick?: () => void }>;
  onPrev?: () => void;
  onNext?: () => void;
  /** The whole file as one archive — the download people come here for. */
  statement?: { label: string; onClick: () => void };
  backOffice?: string | null;
  eventLabel: string;
  /** The event or booking code — `ref` is React's, so it is spelled out here. */
  reference: string;
  po: string | null;
  meta: string;
  stats: StatCell[];
  moves: EventMove[];
  /** "Partners", or "Suppliers · 3 payable, 1 provision excluded". */
  partnersLabel?: string;
  partners: EventPartnerRow[];
  /** Marketplace NA totals its supplier legs; L'Oréal does not. */
  subtotal?: { label: string; values: string[] };
  invoices: Array<{ id: string; ref: string; prose: string; amount: string }>;
  onClientStatement: () => void;
  /** Names the client, so the file's contents are obvious before downloading. */
  clientStatementLabel: string;
  history: Array<{ id: string; title: string; meta: string }>;
  /** Links to everything that lives elsewhere: emails, PDFs, comments. */
  rail: Array<{ id: string; label: string; onClick: () => void; download?: boolean }>;
  notes: ReactNode;
  /** The panel a rail link opened, rendered under the invoicing block. */
  panel?: ReactNode;
  /** A line under the stat strip, where a figure needs its definition. */
  caption?: string | null;
  /** Next to the title — the lock state on Marketplace NA. */
  titleNote?: ReactNode;
  movesLabel?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-paper-canvas font-paper text-paper-ink">
      <BreadcrumbBar
        crumbs={crumbs}
        right={
          <>
            {statement && (
              <DownloadLink onClick={statement.onClick}>{statement.label}</DownloadLink>
            )}
            {onPrev && <PaperLink onClick={onPrev}>← Previous</PaperLink>}
            {onNext && <PaperLink onClick={onNext}>Next →</PaperLink>}
            {backOffice && (
              <a
                href={backOffice}
                target="_blank"
                rel="noreferrer"
                className="border-b border-paper-ink pb-0.5 text-paper-ink"
              >
                Back office ↗
              </a>
            )}
          </>
        }
      />

      <div className="border-b border-paper-rule px-8 pb-6 pt-9">
        <SectionLabel>Event</SectionLabel>
        <div className="mt-2 flex flex-wrap items-baseline gap-4">
          <h1 className="font-paper-display text-[40px] leading-[1.0]">{eventLabel}</h1>
          <span className="font-paper-mono text-[13px] text-paper-muted">
            {reference}
            {po ? ` · PO ${po}` : ""}
          </span>
          {titleNote}
        </div>
        <p className="mt-2.5 text-[13.5px] text-paper-body">{meta}</p>
        <div className="mt-6">
          <StatStrip stats={stats} columns={stats.length} />
        </div>
        {caption && <p className="mt-3.5 text-[12px] text-paper-muted">{caption}</p>}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_380px]">
        <div className="border-paper-rule px-8 pb-12 pt-8 lg:border-r">
          <h2 className="font-paper-display text-[26px]">
            {movesLabel} — {moves.length}
          </h2>
          <div className="mt-4 border-t border-paper-rule">
            {moves.length === 0 && (
              <p className="py-5 text-[13.5px] text-paper-muted">
                Nothing is waiting on us here. The figures above are the record.
              </p>
            )}
            {moves.map((move, i) => (
              <div
                key={move.id}
                className="flex items-start gap-6 border-b border-paper-hairline py-[18px]"
              >
                <span className="mt-1 w-[26px] flex-none font-paper-mono text-[13px] text-paper-label">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[17px] leading-[1.4]">
                    {move.lead} <span className="font-medium">{move.strong}</span> {move.tail}
                  </span>
                  <span
                    className={`mt-1.5 block text-[12.5px] ${
                      move.reasonAlert ? "text-paper-alert" : "text-paper-muted"
                    }`}
                  >
                    {move.reason}
                  </span>
                </span>
                {move.action &&
                  (move.action.primary ? (
                    <PrimaryButton size="inline" onClick={move.action.onClick}>
                      {move.action.label}
                    </PrimaryButton>
                  ) : (
                    <OutlineButton size="inline" onClick={move.action.onClick}>
                      {move.action.label}
                    </OutlineButton>
                  ))}
              </div>
            ))}
          </div>

          <SectionLabel className="mt-11">{partnersLabel}</SectionLabel>
          <div className="mt-4 border-t border-paper-rule">
            {partners.map((p) => (
              <div
                key={p.key}
                className={`flex items-start gap-6 border-b border-paper-hairline py-[18px] ${
                  p.muted ? "opacity-55" : ""
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px]">{p.name}</span>
                  <span className="mt-[3px] block text-[12.5px] text-paper-muted">{p.contact}</span>
                  <span
                    className={`mt-1.5 block text-[13px] ${
                      p.stateAlert ? "text-paper-alert" : "text-paper-body"
                    }`}
                  >
                    {p.state}
                  </span>
                  {p.note && (
                    <span className="mt-1.5 block text-[12.5px] leading-relaxed text-paper-muted">
                      {p.note}
                    </span>
                  )}
                  {p.links && (
                    <span className="mt-1.5 flex flex-wrap items-center gap-5">{p.links}</span>
                  )}
                </span>
                {p.figures.map((f) => (
                  <span key={f.label} className="w-[130px] flex-none text-right">
                    <span
                      className={`block text-[10px] uppercase tracking-[0.14em] ${
                        f.alert ? "text-paper-alert" : "text-paper-label"
                      }`}
                    >
                      {f.label}
                    </span>
                    <span
                      className={`mt-0.5 block whitespace-nowrap text-[15.5px] tabular-nums ${
                        f.alert ? "text-paper-alert" : ""
                      }`}
                    >
                      {f.value}
                    </span>
                    {f.note && (
                      <span className="mt-0.5 block text-[11px] text-paper-label">{f.note}</span>
                    )}
                  </span>
                ))}
              </div>
            ))}
            {partners.length === 0 && (
              <p className="py-5 text-[13.5px] text-paper-muted">
                No partner line on this event yet.
              </p>
            )}
            {subtotal && (
              <div className="flex items-baseline gap-6 border-b border-paper-rule-strong py-3.5">
                <span className="flex-1 text-[10px] uppercase tracking-[0.14em] text-paper-label">
                  {subtotal.label}
                </span>
                {subtotal.values.map((v, i) => (
                  <span
                    key={i}
                    className="w-[130px] flex-none text-right text-[15.5px] tabular-nums"
                  >
                    {v}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="mt-11 flex items-center gap-4">
            <SectionLabel>Client invoicing</SectionLabel>
            <DownloadLink onClick={onClientStatement} className="ml-auto text-[12.5px]">
              {clientStatementLabel}
            </DownloadLink>
          </div>
          <div className="mt-4 border-t border-paper-rule">
            {invoices.length === 0 && (
              <p className="py-5 text-[13.5px] text-paper-muted">
                No invoice has been issued on this event yet.
              </p>
            )}
            {invoices.map((inv) => (
              <div
                key={inv.id}
                className="grid grid-cols-[150px_1fr_150px] items-baseline gap-6 border-b border-paper-hairline py-4"
              >
                <span className="font-paper-mono text-[13px]">{inv.ref}</span>
                <span className="text-[13px] text-paper-body">{inv.prose}</span>
                <span className="text-right text-[15.5px] tabular-nums">{inv.amount}</span>
              </div>
            ))}
          </div>

          {panel && <div className="mt-10">{panel}</div>}
        </div>

        <aside className="px-8 pb-12 pt-8">
          <SectionLabel>History</SectionLabel>
          <div className="mt-3">
            {history.length === 0 && (
              <p className="py-3 text-[13px] text-paper-muted">Nothing recorded yet.</p>
            )}
            {history.map((h) => (
              <div key={h.id} className="border-b border-paper-hairline py-3.5">
                <div className="text-[13.5px] leading-snug text-paper-ink">{h.title}</div>
                <div className="mt-1 text-[12px] text-paper-muted">{h.meta}</div>
              </div>
            ))}
          </div>

          <SectionLabel className="mt-9">Notes</SectionLabel>
          {notes}

          <div className="mt-9 flex flex-col items-start gap-2.5 border-t border-paper-rule pt-6 text-[13.5px]">
            {rail.map((link) =>
              link.download ? (
                <DownloadLink key={link.id} onClick={link.onClick} className="text-[13.5px]">
                  {link.label}
                </DownloadLink>
              ) : (
                <PaperLink key={link.id} onClick={link.onClick}>
                  {link.label}
                </PaperLink>
              ),
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
