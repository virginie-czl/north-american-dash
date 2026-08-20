/**
 * ⌘K — one search box over everything a tracker knows about.
 *
 * The panel is presentation only: each page passes the groups it wants shown
 * (events/bookings, partners on the match, invoices) already filtered by the
 * query, so matching stays with the data that defines it. What lives here is
 * the behaviour the design specifies: ↑ ↓ move, ↵ opens, esc closes, and the
 * first result is always the one Enter would take.
 */
import { useEffect, useMemo, useRef } from "react";
import { Search } from "lucide-react";

export type PaletteItem = {
  id: string;
  title: string;
  /** The line under the title. Alert-coloured when it names a breach. */
  meta?: string | null;
  metaAlert?: boolean;
  amount?: string | null;
  amountLabel?: string | null;
  amountAlert?: boolean;
  /** Right-hand note on the highlighted kind of row — "2 moves waiting". */
  note?: string | null;
  onPick: () => void;
};

export type PaletteGroup = {
  label: string;
  items: PaletteItem[];
  /** "23 more — narrow the query" when the group had to stop listing. */
  overflow?: string | null;
};

export function CommandPalette({
  open,
  query,
  onQuery,
  onClose,
  groups,
  placeholder,
  intro,
  hint,
  cursor,
  onCursor,
}: {
  open: boolean;
  query: string;
  onQuery: (value: string) => void;
  onClose: () => void;
  groups: PaletteGroup[];
  placeholder: string;
  /** What this search covers, and what happens when you pick a result. */
  intro: string;
  /** "Partial codes work: 0847, CA-2411, 45012773" */
  hint: string;
  cursor: number;
  onCursor: (index: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // The cursor has to stay on a row that still exists as the query narrows.
  useEffect(() => {
    if (cursor > flat.length - 1) onCursor(0);
  }, [flat.length, cursor, onCursor]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      onCursor(flat.length === 0 ? 0 : (cursor + 1) % flat.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      onCursor(flat.length === 0 ? 0 : (cursor - 1 + flat.length) % flat.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      flat[cursor]?.onPick();
    }
  };

  let index = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-paper-ink/20 px-6 pt-[12vh] font-paper"
      role="dialog"
      aria-modal="true"
      aria-label="Search"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[820px]" onKeyDown={onKeyDown}>
        {/* The panel says what it searches over. Someone opening ⌘K for the
            first time should not have to guess what to type. */}
        <div className="text-[10.5px] uppercase tracking-[0.2em] text-paper-label">
          Search — ⌘K from any screen
        </div>
        <p className="mt-3 max-w-[640px] text-[14px] leading-relaxed text-paper-body [text-wrap:pretty]">
          {intro}
        </p>

        <div className="mt-6 flex max-h-[64vh] flex-col border border-paper-rule-strong bg-paper-canvas text-paper-ink">
          <div className="flex h-[58px] flex-none items-center gap-3 px-5">
            <Search
              className="h-4 w-4 flex-none text-paper-label"
              strokeWidth={1.6}
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                onQuery(e.target.value);
                onCursor(0);
              }}
              placeholder={placeholder}
              aria-label="Search"
              className="min-w-0 flex-1 border-0 bg-transparent font-paper-mono text-[17px] outline-none placeholder:font-paper placeholder:text-[15px] placeholder:text-paper-label"
            />
            <span className="flex-none text-[12.5px] text-paper-muted">
              {flat.length} match{flat.length === 1 ? "" : "es"}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-auto border-t border-paper-rule">
            {flat.length === 0 ? (
              <p className="px-5 py-10 text-center text-[13px] text-paper-muted">
                {query.trim()
                  ? `Nothing matches “${query.trim()}”.`
                  : "Type an event code, a PO number, a partner name or an invoice reference."}
              </p>
            ) : (
              groups
                .filter((g) => g.items.length > 0)
                .map((group) => (
                  <div key={group.label}>
                    <div className="border-b border-paper-hairline bg-paper-canvas px-5 py-2 text-[10.5px] uppercase tracking-[0.16em] text-paper-label">
                      {group.label}
                    </div>
                    {group.items.map((item) => {
                      index += 1;
                      const active = index === cursor;
                      const at = index;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onMouseMove={() => {
                            if (!active) onCursor(at);
                          }}
                          onClick={item.onPick}
                          className={`flex w-full items-center gap-5 border-b border-paper-hairline px-5 py-3.5 text-left ${
                            active ? "bg-paper-selected" : ""
                          }`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-paper-mono text-[14px]">
                              {item.title}
                            </span>
                            {item.meta && (
                              <span
                                className={`mt-1 block truncate text-[12.5px] ${
                                  item.metaAlert ? "text-paper-alert" : "text-paper-muted"
                                }`}
                              >
                                {item.meta}
                              </span>
                            )}
                          </span>
                          {item.amount && (
                            <span className="flex-none text-right">
                              <span
                                className={`block whitespace-nowrap text-[15.5px] tabular-nums ${
                                  item.amountAlert ? "text-paper-alert" : ""
                                }`}
                              >
                                {item.amount}
                              </span>
                              {item.amountLabel && (
                                <span className="mt-0.5 block text-[10px] uppercase tracking-[0.14em] text-paper-label">
                                  {item.amountLabel}
                                </span>
                              )}
                            </span>
                          )}
                          {item.note && (
                            <span className="flex-none whitespace-nowrap text-[12.5px] text-paper-muted">
                              {item.note}
                            </span>
                          )}
                          {active && (
                            <span className="flex-none font-paper-mono text-[11px] text-paper-faint">
                              ↵
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
            )}
          </div>

          <div className="flex flex-none flex-wrap items-center gap-5 border-t border-paper-rule px-5 py-2.5 text-[11.5px] text-paper-muted">
            <span className="font-paper-mono text-paper-faint">
              ↵ <span className="font-paper text-paper-muted">open</span>
            </span>
            <span className="font-paper-mono text-paper-faint">
              ↑ ↓ <span className="font-paper text-paper-muted">move</span>
            </span>
            <span className="font-paper-mono text-paper-faint">
              esc <span className="font-paper text-paper-muted">close</span>
            </span>
            <span className="ml-auto">{hint}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
