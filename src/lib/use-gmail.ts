/** Client hooks for the Gmail integration. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  draftPartnerEmail,
  lookupPartnerEmails,
  sendPartnerEmail,
  type PartnerEmailStatus,
} from "@/lib/gmail.functions";

export type { PartnerEmailStatus };

export type GmailConnection = {
  connected: boolean;
  scopes?: string;
  connected_at?: string;
};

/**
 * Server functions should return arrays, but a transport-level surprise (an auth
 * error serialised into the return value, say) would otherwise crash on
 * `.forEach` with something unreadable like "e.forEach is not a function".
 * Fail loudly and legibly instead.
 */
function expectArray<T>(value: unknown, what: string): T[] {
  if (Array.isArray(value)) return value as T[];
  const detail =
    value && typeof value === "object" && "error" in (value as Record<string, unknown>)
      ? String((value as Record<string, unknown>).error)
      : `réponse inattendue (${typeof value})`;
  throw new Error(`${what} : ${detail}`);
}

export function useGmailConnection() {
  return useQuery({
    queryKey: ["gmail-connection"],
    queryFn: async (): Promise<GmailConnection> => {
      const res = await fetch("/api/gmail/status", { credentials: "include" });
      // 200 is the only answer that actually tells us about the connection.
      // Treating a 500 as "not connected" hides the Gmail button and makes a
      // backend outage look like the user never connected — surface it instead.
      if (res.ok) return (await res.json()) as GmailConnection;
      if (res.status === 401) return { connected: false };
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) detail = body.error;
      } catch {
        /* keep the status code */
      }
      throw new Error(`État Gmail indisponible (${detail})`);
    },
    retry: 1,
    staleTime: 5 * 60_000,
  });
}

export function useDisconnectGmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await fetch("/api/gmail/disconnect", { method: "POST", credentials: "include" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gmail-connection"] }),
  });
}

/** Looks up the latest exchange with each partner address. Opt-in per event. */
export function usePartnerEmails(addresses: string[], enabled: boolean) {
  const key = [...new Set(addresses.filter(Boolean))].sort();
  return useQuery({
    queryKey: ["partner-emails", key],
    enabled: enabled && key.length > 0,
    queryFn: () => lookupPartnerEmails({ data: { addresses: key } }),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useDraftEmail() {
  return useMutation({
    mutationFn: (input: { to: string; subject: string; body: string }) =>
      draftPartnerEmail({ data: input }),
  });
}

export function useSendEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { to: string; subject: string; body: string }) =>
      sendPartnerEmail({ data: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["partner-emails"] }),
  });
}

// --- Shared partner facts (readable by everyone, no mail access needed) ------

import { useCallback, useState } from "react";
import {
  fetchPartnerFacts,
  scanEventsForFacts,
  type PartnerFacts,
  type ScanEventInput,
} from "@/lib/gmail.functions";

export type { PartnerFacts };

/** The stickers every tracker user sees. Keyed `${event_ref}::${partner_key}`. */
export function usePartnerFacts() {
  return useQuery({
    queryKey: ["partner-facts"],
    queryFn: async () => {
      const rows = expectArray<PartnerFacts>(await fetchPartnerFacts(), "Pastilles email");
      const map = new Map<string, PartnerFacts>();
      rows.forEach((r) => map.set(`${r.event_ref}::${r.partner_key}`, r));
      return map;
    },
    staleTime: 60_000,
  });
}

const CHUNK = 3;

export type ScanProgress = {
  running: boolean;
  done: number;
  total: number;
  matched: number;
  error: string | null;
};

/**
 * Drives the scan in small chunks so each request is short and the user sees
 * progress. Runs only when explicitly started — never on a table refresh.
 */
export function useFactScan() {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<ScanProgress>({
    running: false,
    done: 0,
    total: 0,
    matched: 0,
    error: null,
  });

  const start = useCallback(
    async (events: ScanEventInput[]) => {
      const queue = events.filter((e) => e.partners.length > 0);
      if (queue.length === 0) return;
      setProgress({ running: true, done: 0, total: queue.length, matched: 0, error: null });
      let matched = 0;
      try {
        for (let i = 0; i < queue.length; i += CHUNK) {
          const batch = queue.slice(i, i + CHUNK);
          const outcomes = await scanEventsForFacts({ data: { events: batch } });
          matched += outcomes.filter((o) => o.matched_by !== "none").length;
          setProgress({
            running: true,
            done: Math.min(i + CHUNK, queue.length),
            total: queue.length,
            matched,
            error: null,
          });
          // Show results as they land rather than only at the end.
          qc.invalidateQueries({ queryKey: ["partner-facts"] });
        }
        setProgress((p) => ({ ...p, running: false, done: queue.length }));
      } catch (error) {
        setProgress((p) => ({
          ...p,
          running: false,
          error: String((error as Error)?.message ?? error),
        }));
      } finally {
        qc.invalidateQueries({ queryKey: ["partner-facts"] });
      }
    },
    [qc],
  );

  return { progress, start };
}

// --- Batch provider requests -------------------------------------------------

import { sendPartnerRequests, type BatchResult, type OutgoingMessage } from "@/lib/gmail.functions";

export type { BatchResult, OutgoingMessage };

/** Sends or drafts in chunks so a long round shows progress and cannot time out. */
export function usePartnerRequests() {
  const qc = useQueryClient();
  const [state, setState] = useState<{
    running: boolean;
    done: number;
    total: number;
    results: BatchResult[];
    error: string | null;
  }>({ running: false, done: 0, total: 0, results: [], error: null });

  const run = useCallback(
    async (messages: OutgoingMessage[], mode: "draft" | "send") => {
      if (messages.length === 0) return [];
      setState({ running: true, done: 0, total: messages.length, results: [], error: null });
      const all: BatchResult[] = [];
      const CHUNK_SIZE = 5;
      try {
        for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
          const chunk = messages.slice(i, i + CHUNK_SIZE);
          const res = await sendPartnerRequests({ data: { messages: chunk, mode } });
          all.push(...(Array.isArray(res) ? res : []));
          setState({
            running: true,
            done: Math.min(i + CHUNK_SIZE, messages.length),
            total: messages.length,
            results: [...all],
            error: null,
          });
        }
        setState((s) => ({ ...s, running: false, done: messages.length, results: all }));
      } catch (error) {
        setState((s) => ({
          ...s,
          running: false,
          results: all,
          error: String((error as Error)?.message ?? error),
        }));
      } finally {
        // A sent request changes what the next scan will find.
        qc.invalidateQueries({ queryKey: ["partner-emails"] });
      }
      return all;
    },
    [qc],
  );

  const reset = useCallback(
    () => setState({ running: false, done: 0, total: 0, results: [], error: null }),
    [],
  );

  return { ...state, run, reset };
}
