/**
 * Downloading a rendered document, with the wait made visible.
 *
 * The server renders these in Chromium, which costs a second or two on a cold function.
 * A button that goes dead for two seconds and then silently drops a file in the
 * downloads folder is indistinguishable from a broken one — that is exactly how the
 * Slack refresh button hid a failure for an afternoon. So the hook reports four states
 * and the caller renders all four:
 *
 *   idle → pending (with a "still working" note once the wait is long) → done → failed
 *
 * `done` decays back to idle on its own: the browser's own download indicator is easy
 * to miss, especially on a second monitor, so the button says so itself for a moment.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** How long a wait may run before the button admits it is a render, not a hang. */
export const SLOW_AFTER_MS = 1500;
/** How long "Downloaded" stays before the button goes back to idle. */
export const DONE_FOR_MS = 2500;

export type DownloadState = "idle" | "pending" | "done" | "error";

export type DocumentDownload = {
  /** Starts a download for one key — a booking ref, or a ref and a provider. */
  start: (key: string, url: string) => void;
  /** The key currently downloading, so one card's spinner never lights up another's. */
  pendingKey: string | null;
  stateFor: (key: string) => DownloadState;
  /** True once this download has been waiting long enough to say so. */
  slow: boolean;
  /** The failure, for the key that failed. */
  error: { key: string; message: string } | null;
};

/** Content-Disposition is the server's own naming; the client never rebuilds it. */
export function filenameFromHeaders(headers: Headers): string | null {
  const header = headers.get("content-disposition") ?? "";
  const quoted = /filename\*?=(?:UTF-8'')?"([^"]+)"/i.exec(header);
  if (quoted) return decodeURIComponent(quoted[1]);
  const bare = /filename\*?=(?:UTF-8'')?([^;]+)/i.exec(header);
  return bare ? decodeURIComponent(bare[1].trim()) : null;
}

export function useDocumentDownload(): DocumentDownload {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [slow, setSlow] = useState(false);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      for (const id of timers.current) window.clearTimeout(id);
    },
    [],
  );

  const start = useCallback(
    (key: string, url: string) => {
      // Guard the second click: each one is another Chromium page, and the first
      // download is already on its way.
      if (pendingKey) return;
      setError(null);
      setDoneKey(null);
      setPendingKey(key);
      setSlow(false);
      const slowTimer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
      timers.current.push(slowTimer);

      void (async () => {
        try {
          const res = await fetch(url, { credentials: "include" });
          // The reconciliation guard answers with a sentence and a 4xx/5xx. Treating
          // that as a PDF would download an error page named like a statement.
          if (!res.ok) {
            throw new Error((await res.text()).trim() || `Request failed (${res.status})`);
          }
          const type = res.headers.get("content-type") ?? "";
          if (!type.includes("application/pdf")) {
            throw new Error(`Expected a PDF but the server sent ${type || "nothing"}`);
          }

          const blob = await res.blob();
          const href = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = href;
          a.download = filenameFromHeaders(res.headers) ?? "Naboo_document.pdf";
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(href);

          setDoneKey(key);
          const doneTimer = window.setTimeout(() => setDoneKey(null), DONE_FOR_MS);
          timers.current.push(doneTimer);
        } catch (caught) {
          setError({
            key,
            message: caught instanceof Error ? caught.message : String(caught),
          });
        } finally {
          window.clearTimeout(slowTimer);
          setSlow(false);
          setPendingKey(null);
        }
      })();
    },
    [pendingKey],
  );

  const stateFor = useCallback(
    (key: string): DownloadState => {
      if (pendingKey === key) return "pending";
      if (doneKey === key) return "done";
      if (error?.key === key) return "error";
      return "idle";
    },
    [pendingKey, doneKey, error],
  );

  return { start, pendingKey, stateFor, slow, error };
}

/** The endpoints, in one place so a caller cannot spell one wrong. */
export function statementUrl(eventRef: string): string {
  return `/api/statement/${encodeURIComponent(eventRef)}`;
}

export function commissionStatementUrl(eventRef: string, houseCode: string): string {
  return `/api/commission/${encodeURIComponent(eventRef)}/${encodeURIComponent(houseCode)}`;
}
