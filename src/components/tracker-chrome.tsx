/**
 * Shared tracker chrome: the top-bar action slot and the collapsible summary strip.
 *
 * The shell (routes/_authenticated/route.tsx) owns the top bar; each tracker page
 * registers its Export/Refresh actions into it so the bar stays consistent across
 * the three trackers.
 */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";

export type ExportAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

export type TrackerActions = {
  onRefresh?: () => void;
  isFetching?: boolean;
  exports?: ExportAction[];
};

type ChromeContextValue = {
  actions: TrackerActions;
  setActions: (actions: TrackerActions) => void;
};

const ChromeContext = createContext<ChromeContextValue | null>(null);

export function TrackerChromeProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<TrackerActions>({});
  return (
    <ChromeContext.Provider value={{ actions, setActions }}>{children}</ChromeContext.Provider>
  );
}

export function useTrackerChrome(): ChromeContextValue {
  const ctx = useContext(ChromeContext);
  if (!ctx) throw new Error("useTrackerChrome must be used inside TrackerChromeProvider");
  return ctx;
}

/**
 * Publishes a page's actions to the top bar. `deps` should list the primitive
 * values that change the buttons' state (loading flags, row counts) — the
 * callbacks themselves are read through a ref so they never retrigger the effect.
 */
export function useRegisterTrackerActions(actions: TrackerActions, deps: unknown[]) {
  const { setActions } = useTrackerChrome();
  const ref = useRef(actions);
  ref.current = actions;

  useEffect(() => {
    setActions({
      isFetching: ref.current.isFetching,
      onRefresh: () => ref.current.onRefresh?.(),
      exports: (ref.current.exports ?? []).map((action, i) => ({
        label: action.label,
        disabled: action.disabled,
        onClick: () => ref.current.exports?.[i]?.onClick(),
      })),
    });
    return () => setActions({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export type SummaryStat = {
  label: string;
  value: string;
};

/**
 * Dense, collapsible summary bar. Collapsed by default so the table is the first
 * thing on screen; the headline figures stay visible inline either way.
 */
export function SummaryStrip({
  title,
  stats,
  alert,
  children,
}: {
  title: string;
  stats: SummaryStat[];
  alert?: string | null;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="flex-none">
      <h1 className="sr-only">{title}</h1>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full flex-wrap items-center gap-x-6 gap-y-2 border-b border-border bg-slate-50 px-5 py-2.5 text-left transition-colors hover:bg-slate-100"
      >
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold uppercase tracking-[0.06em] text-slate-600">
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
            aria-hidden="true"
          />
          {title} — summary
        </span>
        {stats.map((s) => (
          <span key={s.label} className="flex items-baseline gap-1.5 whitespace-nowrap text-[13px]">
            <span className="text-slate-500">{s.label}</span>
            <span className="font-semibold tabular-nums">{s.value}</span>
          </span>
        ))}
        {alert ? (
          <span className="inline-flex items-center rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-semibold text-rose-800">
            {alert}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-slate-500">{open ? "Hide" : "Show"} details</span>
      </button>
      {open && (
        <div
          id={panelId}
          className="space-y-3 border-b border-border bg-slate-50 px-5 py-3.5"
        >
          {children}
        </div>
      )}
    </div>
  );
}
