import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ShieldCheck, ShieldOff, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user-avatar";
import { TRACKERS, type TrackerKey } from "@/lib/trackers";

type AccessStatus = "pending" | "approved" | "blocked";
type Role = "owner" | "admin" | "member";

type AppUser = {
  email: string;
  name: string | null;
  picture: string | null;
  status: AccessStatus;
  role: Role;
  requested_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  last_seen_at: string | null;
  trackers: TrackerKey[];
};

export const Route = createFileRoute("/_authenticated/admin")({
  ssr: false,
  beforeLoad: async () => {
    // Server decides; this only keeps non-admins from loading a page of 403s.
    const res = await fetch("/api/admin/users", { credentials: "include" });
    if (res.status === 401) throw redirect({ to: "/auth" });
    if (!res.ok) throw redirect({ to: "/" });
  },
  component: AdminPage,
});

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("fr-FR", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function useUsers() {
  return useQuery({
    queryKey: ["admin-users"],
    queryFn: async (): Promise<{ users: AppUser[]; role: Role }> => {
      const res = await fetch("/api/admin/users", { credentials: "include" });
      if (!res.ok) throw new Error(`Chargement impossible (HTTP ${res.status})`);
      return (await res.json()) as { users: AppUser[]; role: Role };
    },
    staleTime: 15_000,
  });
}

function useDecide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      email: string;
      action: "approve" | "block" | "make_admin" | "make_member" | "set_trackers";
      trackers?: TrackerKey[];
    }) => {
      const res = await fetch("/api/admin/decide", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Échec (HTTP ${res.status})`);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      qc.invalidateQueries({ queryKey: ["current-user"] });
    },
  });
}

function Avatar({ user }: { user: AppUser }) {
  return <UserAvatar name={user.name} email={user.email} picture={user.picture} />;
}


/**
 * Which trackers a person may open. Separate from approval on purpose: someone can
 * be a trusted colleague and still have no business in the L'Oréal numbers.
 */
function TrackerChoice({
  user,
  disabled,
  onChange,
}: {
  user: AppUser;
  disabled: boolean;
  onChange: (trackers: TrackerKey[]) => void;
}) {
  const owner = user.role === "owner";
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {TRACKERS.map((t) => {
        const on = owner || user.trackers.includes(t.key);
        return (
          <label
            key={t.key}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] text-[11px] ${
              on
                ? "border-navy/15 bg-naboo/60 font-medium text-navy"
                : "border-border bg-white text-slate-500"
            } ${owner || disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}
            title={
              owner
                ? "Le propriétaire a accès à tous les trackers"
                : on
                  ? `Retirer l'accès à ${t.label}`
                  : `Donner l'accès à ${t.label}`
            }
          >
            <input
              type="checkbox"
              className="h-3 w-3 accent-navy"
              checked={on}
              disabled={owner || disabled}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...user.trackers, t.key]
                    : user.trackers.filter((k) => k !== t.key),
                )
              }
            />
            {t.label}
          </label>
        );
      })}
    </span>
  );
}

function AdminPage() {
  const { data, isLoading, error } = useUsers();
  const decide = useDecide();
  const users = data?.users ?? [];
  const isOwner = data?.role === "owner";
  const pending = users.filter((u) => u.status === "pending");
  const approved = users.filter((u) => u.status === "approved");
  const blocked = users.filter((u) => u.status === "blocked");

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-white">
      <header className="border-b border-border px-6 pb-4 pt-7">
        <h1 className="font-display text-[28px] font-extrabold leading-tight tracking-tight">
          Accès à l'outil
        </h1>
        <p className="mt-1 max-w-2xl text-[13px] text-slate-600">
          Un compte Google <strong>@naboo.app</strong> permet de se présenter, pas d'entrer. Chaque
          nouvelle personne apparaît ici et attend votre validation. Une fois validée, elle entre
          directement à chaque connexion suivante — sans nouvelle demande. Cochez ensuite les
          trackers auxquels elle a accès : la validation ouvre le compte, pas toutes les pages.
        </p>
      </header>

      {error != null && (
        <div role="alert" className="border-b border-rose-200 bg-rose-50 px-6 py-2.5 text-sm text-rose-800">
          {String((error as Error).message)}
        </div>
      )}
      {decide.isError && (
        <div role="alert" className="border-b border-rose-200 bg-rose-50 px-6 py-2.5 text-sm text-rose-800">
          {String((decide.error as Error).message)}
        </div>
      )}

      <div className="space-y-8 px-6 py-6">
        <section>
          <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-600">
            En attente
            {pending.length > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                {pending.length}
              </span>
            )}
          </h2>
          {isLoading ? (
            <p className="mt-2 text-sm text-slate-500">Chargement…</p>
          ) : pending.length === 0 ? (
            <p className="mt-2 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-slate-500">
              Aucune demande en attente.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {pending.map((u) => (
                <li
                  key={u.email}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3.5 py-3"
                >
                  <Avatar user={u} />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{u.name ?? u.email}</span>
                    <span className="block truncate text-xs text-slate-600">{u.email}</span>
                    <span className="block text-[11px] text-slate-500">
                      Première connexion {fmt(u.requested_at)}
                    </span>
                    <span className="mt-1.5 block">
                      <TrackerChoice
                        user={u}
                        disabled={decide.isPending}
                        onChange={(trackers) =>
                          decide.mutate({ email: u.email, action: "set_trackers", trackers })
                        }
                      />
                    </span>
                  </span>
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      className="h-8 gap-1.5 border-0 bg-naboo font-semibold text-navy shadow-none hover:bg-naboo-hover"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ email: u.email, action: "approve" })}
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      Valider l'accès
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ email: u.email, action: "block" })}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                      Refuser
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-600">
            Accès validés ({approved.length})
          </h2>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
            {approved.map((u) => (
              <li key={u.email} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
                <Avatar user={u} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {u.name ?? u.email}
                    {u.role === "owner" && (
                      <span className="rounded-full bg-navy px-1.5 py-[1px] text-[9.5px] font-bold uppercase tracking-wide text-naboo">
                        propriétaire
                      </span>
                    )}
                    {u.role === "admin" && (
                      <span className="rounded-full bg-sky-100 px-1.5 py-[1px] text-[9.5px] font-bold uppercase tracking-wide text-sky-800">
                        admin
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-slate-500">{u.email}</span>
                  <span className="block text-[11px] text-slate-400">
                    {u.decided_by
                      ? `Validé par ${u.decided_by} le ${fmt(u.decided_at)}`
                      : "Validation automatique"}{" "}
                    · vu {fmt(u.last_seen_at)}
                  </span>
                  <span className="mt-1.5 block">
                    <TrackerChoice
                      user={u}
                      disabled={decide.isPending}
                      onChange={(trackers) =>
                        decide.mutate({ email: u.email, action: "set_trackers", trackers })
                      }
                    />
                  </span>
                </span>
                {u.role !== "owner" && (
                  <span className="ml-auto flex flex-wrap items-center gap-1.5">
                    {isOwner &&
                      (u.role === "admin" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1.5 text-[11.5px]"
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ email: u.email, action: "make_member" })}
                        >
                          <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />
                          Retirer admin
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1.5 text-[11.5px]"
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ email: u.email, action: "make_admin" })}
                        >
                          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                          Nommer admin
                        </Button>
                      ))}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[11.5px]"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ email: u.email, action: "block" })}
                    >
                      Révoquer
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-slate-400">
            Une révocation prend effet en moins d'une minute, sans attendre l'expiration de la
            session.
          </p>
        </section>

        {blocked.length > 0 && (
          <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-600">
              Refusés ({blocked.length})
            </h2>
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
              {blocked.map((u) => (
                <li key={u.email} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
                  <UserRound className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-600">{u.name ?? u.email}</span>
                    <span className="block truncate text-[11px] text-slate-400">
                      {u.email} · refusé par {u.decided_by ?? "—"} le {fmt(u.decided_at)}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 text-[11.5px]"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ email: u.email, action: "approve" })}
                  >
                    Réautoriser
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
