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

export function useGmailConnection() {
  return useQuery({
    queryKey: ["gmail-connection"],
    queryFn: async (): Promise<GmailConnection> => {
      const res = await fetch("/api/gmail/status", { credentials: "include" });
      if (!res.ok) return { connected: false };
      return (await res.json()) as GmailConnection;
    },
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
