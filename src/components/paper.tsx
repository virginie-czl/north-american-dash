/**
 * The "paper" primitives shared by the redesigned trackers.
 *
 * Ink on off-white, hairline rules, radius 0, no shadows — hierarchy comes from
 * type size and rule colour, never from a box. Colour is spent only on a real
 * breach (`--color-paper-alert`) and on the single primary action per screen
 * (Naboo lime).
 *
 * These are presentation only: every figure and verdict is computed by the
 * pages and passed in.
 */
import { Download } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

/**
 * "12 min ago" — how old the figures on screen are.
 *
 * It re-renders itself once a minute: a page left open all afternoon that still
 * claims "just now" is worse than no timestamp at all.
 */
export function useSyncedLabel(at: number | undefined): string {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  if (!at) return "just now";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 min ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 h ago" : `${hours} h ago`;
}

/**
 * ⌘K (or Ctrl-K) from anywhere on the page. The palette itself is the page's —
 * this only says when to open it.
 */
export function usePaletteShortcut(onOpen: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);
}

/** `1 284 600,00` — the figure style the design uses everywhere. */
export function fmtPaper(value: number): string {
  return new Intl.NumberFormat("fr-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .format(value)
    .replace(/[\u00a0\u202f]/g, " ");
}

const CCY_SYMBOL: Record<string, string> = { EUR: "€", USD: "$US", CAD: "$CA", GBP: "£" };

/** `$CA` — how the design writes a currency next to a figure. */
export function ccyLabel(ccy: string | null | undefined): string {
  if (!ccy) return "";
  return CCY_SYMBOL[ccy] ?? ccy;
}

export type Crumb = { label: string; onClick?: () => void };

/**
 * `Overview / <list> / <ref>`, with the screen's own links on the right.
 * The last crumb is the current screen and never a button.
 */
export function BreadcrumbBar({ crumbs, right }: { crumbs: Crumb[]; right?: ReactNode }) {
  return (
    <div className="flex h-14 flex-none items-center gap-4 border-b border-paper-rule bg-paper-canvas px-8 font-paper text-[13px] text-paper-muted">
      {crumbs.map((crumb, i) => (
        <span key={`${crumb.label}-${i}`} className="flex items-center gap-4">
          {i > 0 && <span className="text-paper-faint">/</span>}
          {crumb.onClick ? (
            <button
              type="button"
              onClick={crumb.onClick}
              className="underline-offset-[3px] hover:underline"
            >
              {crumb.label}
            </button>
          ) : (
            <span className="text-paper-ink">{crumb.label}</span>
          )}
        </span>
      ))}
      {right && <span className="ml-auto flex items-center gap-[22px]">{right}</span>}
    </div>
  );
}

/** A quiet text link with the design's 1px underline on hover. */
export function PaperLink({
  children,
  onClick,
  href,
  strong,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  /** Ink rather than body colour — used for the one link that matters most. */
  strong?: boolean;
  className?: string;
}) {
  const cls = `underline-offset-[3px] hover:underline ${
    strong ? "text-paper-ink" : "text-paper-body"
  } ${className}`;
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

/** "Download this list" and its siblings: icon + label, no box. */
export function DownloadLink({
  children,
  onClick,
  className = "",
}: {
  children: ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-[7px] text-paper-ink underline-offset-[3px] hover:underline ${className}`}
    >
      <Download className="h-[13px] w-[13px] flex-none" strokeWidth={1.6} aria-hidden="true" />
      {children}
    </button>
  );
}

/**
 * The selection square. Filled ink when selected — the design has no tick, the
 * fill is the state.
 */
export function PaperCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`mt-1 h-[14px] w-[14px] flex-none border border-paper-ink ${
        checked ? "bg-paper-ink" : "bg-transparent"
      }`}
    />
  );
}

/** The one lime action per screen. */
export function PrimaryButton({
  children,
  onClick,
  disabled,
  size = "screen",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  size?: "screen" | "inline";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex flex-none items-center justify-center bg-naboo px-5 font-paper text-paper-ink hover:bg-naboo-hover disabled:bg-paper-hairline disabled:text-paper-faint ${
        size === "screen" ? "h-[38px] text-[13.5px]" : "h-[34px] text-[13px]"
      }`}
    >
      {children}
    </button>
  );
}

export function OutlineButton({
  children,
  onClick,
  disabled,
  size = "screen",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  size?: "screen" | "inline";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex flex-none items-center justify-center border border-paper-ink px-5 font-paper text-paper-ink hover:bg-paper-canvas disabled:border-paper-rule-strong disabled:text-paper-faint ${
        size === "screen" ? "h-[38px] text-[13.5px]" : "h-[34px] text-[13px]"
      }`}
    >
      {children}
    </button>
  );
}

/** An uppercase section label — the design's only "heading" below display type. */
export function SectionLabel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`text-[10.5px] uppercase tracking-[0.2em] text-paper-label ${className}`}>
      {children}
    </div>
  );
}

export type StatCell = {
  label: string;
  value: string;
  alert?: boolean;
  /** Under the figure — "virtual card", a currency, a caveat. */
  note?: string | null;
  muted?: boolean;
};

/**
 * The stat strip on an event: figures over a top rule, no boxes. Column count
 * is the caller's (4 on L'Oréal, 6 on Marketplace NA).
 */
export function StatStrip({ stats, columns }: { stats: StatCell[]; columns: number }) {
  return (
    <div
      className="grid gap-6 border-t border-paper-rule pt-3.5"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {stats.map((s) => (
        <div key={s.label}>
          <div
            className={`text-[10px] uppercase tracking-[0.16em] ${
              s.alert ? "text-paper-alert" : "text-paper-label"
            }`}
          >
            {s.label}
          </div>
          <div
            className={`mt-1.5 whitespace-nowrap text-[24px] tabular-nums ${
              s.alert ? "text-paper-alert" : s.muted ? "text-paper-muted" : "text-paper-ink"
            }`}
          >
            {s.value}
          </div>
          {s.note && <div className="mt-1 text-[11.5px] text-paper-label">{s.note}</div>}
        </div>
      ))}
    </div>
  );
}

/** A rail block: uppercase label over a rule, then whatever the page puts in it. */
export function RailBlock({
  title,
  children,
  first,
}: {
  title: string;
  children: ReactNode;
  first?: boolean;
}) {
  return (
    <div className={first ? "" : "mt-9 border-t border-paper-rule pt-6"}>
      <SectionLabel>{title}</SectionLabel>
      {children}
    </div>
  );
}

/** label / value rows separated by hairlines — the SLA and Sources blocks. */
export function RailRows({
  rows,
}: {
  rows: Array<{ label: string; value: string; alert?: boolean }>;
}) {
  return (
    <div className="mt-2">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-baseline justify-between gap-3 border-b border-paper-hairline py-4"
        >
          <span className="text-[13.5px] text-paper-body">{row.label}</span>
          <span
            className={`text-[14px] tabular-nums ${row.alert ? "text-paper-alert" : "text-paper-ink"}`}
          >
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}
