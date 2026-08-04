/**
 * Watching for an approval from the waiting screen.
 *
 * Someone signing in for the first time lands on "waiting for an admin" and, until now,
 * stayed there: the page had no way of learning that the decision had been taken, so the
 * only way in was to notice by chance, go back through Google and hope. The person most
 * likely to be watching that screen is a new colleague on their first day.
 *
 * So the screen asks. `/api/auth/status` answers for whoever the browser remembers and,
 * on an approval, hands back a real session cookie — which is why the answer to `ready`
 * is followed by a full page load rather than a client-side navigation: the reload is
 * what carries the new cookie into the app.
 *
 * Polling is paused while the tab is hidden and resumes the moment it is looked at
 * again. A tab nobody is watching costs nothing; a tab in front of someone gets a fast
 * answer for the first couple of minutes and a slower one after that, because an
 * approval that has not arrived in two minutes is probably not arriving in the next ten.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const FAST_POLL_MS = 5_000;
export const SLOW_POLL_MS = 20_000;
/** How long the fast cadence lasts before easing off. */
export const FAST_POLL_FOR_MS = 120_000;

export type AccessStatus = "approved" | "pending" | "blocked" | "signed-out";

export type AccessState = {
  status: AccessStatus;
  trackers: string[];
  /** Approved *and* able to open something — an approval with no page ticked is not. */
  ready: boolean;
};

/** Pure so the cadence can be checked without waiting two minutes for it. */
export function pollDelay(waitedMs: number): number {
  return waitedMs < FAST_POLL_FOR_MS ? FAST_POLL_MS : SLOW_POLL_MS;
}

export type AccessWatch = AccessState & {
  /** True while a check is in flight, for the "checking…" line. */
  checking: boolean;
  /** Forces a check now — the manual button, for someone who cannot wait five seconds. */
  checkNow: () => void;
};

function parse(body: unknown): AccessState | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const status = b.status;
  if (status !== "approved" && status !== "pending" && status !== "blocked") {
    return status === "signed-out" ? { status: "signed-out", trackers: [], ready: false } : null;
  }
  return {
    status,
    trackers: Array.isArray(b.trackers) ? b.trackers.map(String) : [],
    ready: b.ready === true,
  };
}

export function useAccessWatch(enabled: boolean, initial: AccessStatus = "pending"): AccessWatch {
  const [state, setState] = useState<AccessState>({
    status: initial,
    trackers: [],
    ready: false,
  });
  const [checking, setChecking] = useState(false);
  const timer = useRef(0);
  const inFlight = useRef(false);
  const cancelled = useRef(false);
  const startedAt = useRef(0);
  /** The running loop, so the manual button restarts it rather than racing it. */
  const tick = useRef<() => void>(() => {});

  const check = useCallback(async (): Promise<AccessState | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setChecking(true);
    try {
      const res = await fetch("/api/auth/status", { credentials: "include", cache: "no-store" });
      if (!res.ok) return null;
      const next = parse(await res.json());
      if (!next || cancelled.current) return null;
      setState(next);
      if (next.ready) {
        // A full load, not a router navigation: the session cookie was only just
        // issued and the app's own gate has to run against it.
        window.location.href = "/";
      }
      return next;
    } catch {
      // Offline, or the deployment restarting. Neither is an answer — keep waiting.
      return null;
    } finally {
      inFlight.current = false;
      if (!cancelled.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    cancelled.current = false;
    startedAt.current = Date.now();

    const loop = async () => {
      if (cancelled.current) return;
      if (document.visibilityState === "visible") {
        const next = await check();
        // Nothing left to poll for: they were refused, or the browser has forgotten
        // who they are and has to sign in again.
        if (next?.ready || next?.status === "blocked" || next?.status === "signed-out") return;
      }
      if (cancelled.current) return;
      timer.current = window.setTimeout(loop, pollDelay(Date.now() - startedAt.current));
    };
    tick.current = () => {
      window.clearTimeout(timer.current);
      void loop();
    };

    const onVisibility = () => {
      if (document.visibilityState !== "visible" || cancelled.current) return;
      tick.current();
    };

    void loop();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled.current = true;
      window.clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, check]);

  const checkNow = useCallback(() => {
    // The cadence starts over: someone pressing the button is watching the screen.
    startedAt.current = Date.now();
    tick.current();
  }, []);

  return { ...state, checking, checkNow };
}
