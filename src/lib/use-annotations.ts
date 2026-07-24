/**
 * Shared annotation hooks (comments, partner statuses, PO emission) backed by
 * BigQuery server functions — drop-in replacements for the former Supabase hooks.
 */
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  addEventComment,
  deleteEventComment,
  fetchCommentSummaries,
  fetchEventComments,
  fetchPartnerStatuses,
  fetchPoEmissions,
  partnerKey,
  savePartnerStatus,
  upsertPoEmissions,
  type EventComment,
  type PartnerStatusRow,
  type PartnerStatusValue,
} from "@/lib/annotations.functions";

export { partnerKey };
export type { EventComment, PartnerStatusRow, PartnerStatusValue };

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
};

export type CommenterSummary = {
  user_id: string;
  user_name: string | null;
  user_email: string;
  user_avatar_url: string | null;
};

export type EventCommentSummary = {
  count: number;
  commenters: CommenterSummary[];
};

export function useCurrentUser() {
  return useQuery({
    queryKey: ["current-user"],
    queryFn: async (): Promise<SessionUser | null> => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (!res.ok) return null;
      return (await res.json()) as SessionUser;
    },
    staleTime: 5 * 60_000,
  });
}

export function usePartnerStatuses() {
  return useQuery({
    queryKey: ["partner-status"],
    queryFn: async () => {
      const rows = await fetchPartnerStatuses();
      const map = new Map<string, PartnerStatusRow>();
      rows.forEach((r) => {
        map.set(`${r.event_ref}::${r.partner_key}`, r);
      });
      return map;
    },
    staleTime: 30_000,
  });
}

export function useSetPartnerStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      event_ref: string;
      partner_name: string;
      status: PartnerStatusValue;
    }) => {
      await savePartnerStatus({ data: input });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["partner-status"] }),
  });
}

export function useEventComments(eventRef: string) {
  return useQuery({
    queryKey: ["event-comments", eventRef],
    enabled: !!eventRef,
    queryFn: async () => fetchEventComments({ data: { event_ref: eventRef } }),
    staleTime: 15_000,
  });
}

function invalidateComments(qc: QueryClient, eventRef: string) {
  qc.invalidateQueries({ queryKey: ["event-comments", eventRef] });
  qc.invalidateQueries({ queryKey: ["event-comments-summary"] });
}

export function useAddComment(eventRef: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) => {
      await addEventComment({ data: { event_ref: eventRef, body } });
    },
    onSuccess: () => invalidateComments(qc, eventRef),
  });
}

export function useDeleteComment(eventRef: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await deleteEventComment({ data: { id } });
    },
    onSuccess: () => invalidateComments(qc, eventRef),
  });
}

export function useCommentSummaries() {
  return useQuery({
    queryKey: ["event-comments-summary"],
    queryFn: async () => {
      const rows = await fetchCommentSummaries();
      const map = new Map<string, EventCommentSummary>();
      for (const r of rows) {
        const entry = map.get(r.event_ref) ?? { count: 0, commenters: [] };
        entry.count += 1;
        if (!entry.commenters.some((c) => c.user_id === r.user_id)) {
          entry.commenters.push({
            user_id: r.user_id,
            user_name: r.user_name,
            user_email: r.user_email,
            user_avatar_url: r.user_avatar_url,
          });
        }
        map.set(r.event_ref, entry);
      }
      return map;
    },
    staleTime: 30_000,
  });
}

/**
 * Mirrors the BigQuery-sourced PO numbers into the annotation table so the app
 * remembers when a PO was first seen (emission date), and returns the map.
 */
export function usePoEmissionDates(rows: Array<{ readable_id: string | null; purchase_order_number?: string | number | null }>) {
  const qc = useQueryClient();
  const { data: map } = useQuery({
    queryKey: ["po-emission"],
    queryFn: async () => {
      const data = await fetchPoEmissions();
      const m = new Map<string, { po: string; emitted_at: string }>();
      data.forEach((r) => {
        m.set(r.event_ref, { po: r.purchase_order_number, emitted_at: r.emitted_at });
      });
      return m;
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!map || rows.length === 0) return;
    const toUpsert: Array<{ event_ref: string; purchase_order_number: string }> = [];
    for (const r of rows) {
      const ref = r.readable_id;
      const po = r.purchase_order_number ? String(r.purchase_order_number).trim() : "";
      if (!ref || !po) continue;
      const existing = map.get(ref);
      if (!existing || existing.po !== po) {
        toUpsert.push({ event_ref: ref, purchase_order_number: po });
      }
    }
    if (toUpsert.length === 0) return;
    void (async () => {
      try {
        await upsertPoEmissions({ data: { rows: toUpsert } });
        qc.invalidateQueries({ queryKey: ["po-emission"] });
      } catch (error) {
        console.error("PO emission sync failed:", error);
      }
    })();
  }, [rows, map, qc]);

  return map;
}
