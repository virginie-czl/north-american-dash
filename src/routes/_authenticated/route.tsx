import { createFileRoute, Link, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { LogOut, Mail, MailX, Search, Users } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TrackerChromeProvider, useTrackerChrome } from "@/components/tracker-chrome";
import { UserAvatar } from "@/components/user-avatar";
import { useDisconnectGmail, useGmailConnection } from "@/lib/use-gmail";

type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  role?: "owner" | "admin" | "member";
  trackers?: string[];
  admin?: boolean;
  pendingCount?: number;
};

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    if (!res.ok) {
      // 403 means the account is known but not approved (or was revoked) — say so,
      // rather than bouncing to a sign-in screen that will succeed and bounce again.
      if (res.status === 403) {
        const body = (await res.json().catch(() => null)) as { status?: string } | null;
        throw redirect({ to: "/auth", search: { status: body?.status ?? "pending" } });
      }
      throw redirect({ to: "/auth" });
    }
    const user = (await res.json()) as SessionUser;
    return { user, allowedTrackers: user.trackers ?? [] };
  },
  component: AuthedLayout,
});

function NabooMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 19 32" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M18.3224 18.2291V31.606H12.8998V17.355C12.8998 13.4644 12.1129 11.5406 10.1011 11.5406C7.78332 11.5406 5.68484 13.9889 5.37882 19.6714V31.606H0V13.4644C2.05549 13.1585 4.02281 12.0658 5.37882 10.7539V17.6609C5.99087 13.2896 7.91521 10.5791 12.3752 10.5791C16.2669 10.5791 18.2786 13.2459 18.3224 18.2291Z" />
    </svg>
  );
}

function AuthedLayout() {
  return (
    <TrackerChromeProvider>
      <div className="flex h-screen min-h-0 flex-col bg-white">
        <a
          href="#tracker-main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-navy focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
        >
          Skip to table
        </a>
        <TopBar />
        <main id="tracker-main" className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>
    </TrackerChromeProvider>
  );
}

function TopBar() {
  const router = useRouter();
  const { user } = Route.useRouteContext();
  const { actions } = useTrackerChrome();
  const allowed = user?.trackers ?? [];
  const { data: gmail } = useGmailConnection();
  const disconnectGmail = useDisconnectGmail();
  const email = user?.email ?? "";
  const displayName = user?.name ?? email;
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    router.navigate({ to: "/auth" });
  }

  const exports = actions.exports ?? [];

  return (
    <header className="flex h-16 flex-none items-center gap-6 border-b border-paper-rule bg-paper-canvas px-8 font-paper text-paper-ink">
      <span className="flex flex-none items-center gap-2">
        <NabooMark className="h-4 w-auto" />
        <span className="font-paper-display text-[17px] leading-none">naboo tracker</span>
      </span>

      {/* Nav is text, not chrome: the active tracker is the one with a rule
          under it, everything else recedes to label colour. */}
      <nav aria-label="Trackers" className="flex flex-none items-center gap-[26px] text-[13.5px]">
        {allowed.includes("loreal") && <TrackerTab to="/">L'Oréal CA</TrackerTab>}
        {allowed.includes("veolia") && <TrackerTab to="/veolia">Veolia US</TrackerTab>}
        {allowed.includes("na") && (
          <TrackerTab to="/tracking-north-america">Marketplace NA</TrackerTab>
        )}
        {allowed.includes("na-commissions") && (
          <TrackerTab to="/na-commissions">Commissions NA</TrackerTab>
        )}
      </nav>

      {actions.search && (
        <button
          type="button"
          onClick={actions.search.onOpen}
          className="mx-auto flex h-[34px] w-[320px] flex-none items-center gap-2 whitespace-nowrap border border-paper-rule-strong bg-white px-2.5 text-left"
        >
          <Search
            className="h-3.5 w-3.5 flex-none text-paper-label"
            strokeWidth={1.6}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-[13px] text-paper-label">
            {actions.search.placeholder}
          </span>
          <span className="flex-none font-paper-mono text-[11px] text-paper-faint">⌘K</span>
        </button>
      )}

      <div className={`flex items-center gap-5 ${actions.search ? "" : "ml-auto"}`}>
        {actions.status && (
          <span className="flex items-center gap-4 whitespace-nowrap text-[13px] text-paper-muted">
            {actions.status.text}
            {actions.status.action && (
              <button
                type="button"
                onClick={actions.status.action.onClick}
                disabled={actions.isFetching}
                className="border-b border-paper-ink pb-0.5 text-paper-ink disabled:border-paper-rule-strong disabled:text-paper-faint"
              >
                {actions.status.action.label}
              </button>
            )}
          </span>
        )}

        {exports.length === 1 ? (
          <button
            type="button"
            onClick={exports[0].onClick}
            disabled={exports[0].disabled}
            className="whitespace-nowrap border-b border-paper-ink pb-0.5 text-[13px] disabled:border-paper-rule-strong disabled:text-paper-faint"
          >
            {exports[0].label}
          </button>
        ) : exports.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="whitespace-nowrap border-b border-paper-ink pb-0.5 text-[13px]"
              >
                Export
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {exports.map((action) => (
                <DropdownMenuItem
                  key={action.label}
                  onSelect={action.onClick}
                  disabled={action.disabled}
                >
                  {action.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {actions.onRefresh && !actions.status?.action && (
          <button
            type="button"
            onClick={actions.onRefresh}
            disabled={actions.isFetching}
            className="whitespace-nowrap border-b border-paper-ink pb-0.5 text-[13px] disabled:border-paper-rule-strong disabled:text-paper-faint"
          >
            {actions.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="relative flex h-7 w-7 flex-none items-center justify-center rounded-full"
              aria-label={
                (user?.pendingCount ?? 0) > 0
                  ? `${email} — ${user?.pendingCount} demande(s) d'accès en attente`
                  : `Compte : ${email}`
              }
            >
              <UserAvatar
                name={user?.name}
                email={email}
                picture={user?.picture}
                className="h-7 w-7"
                fallbackClassName="bg-paper-ink text-paper-canvas"
                textClassName="text-[11px] font-normal"
              />
              {(user?.pendingCount ?? 0) > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-amber-400 px-[3px] text-[9px] font-bold text-navy ring-2 ring-white">
                  {user?.pendingCount}
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <span className="flex items-center gap-2.5">
                <UserAvatar name={user?.name} email={email} picture={user?.picture} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{displayName}</span>
                  <span className="block truncate text-xs text-muted-foreground">{email}</span>
                </span>
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {user?.admin && (
              <DropdownMenuItem
                onSelect={() => {
                  router.navigate({ to: "/admin" });
                }}
              >
                <Users className="mr-2 h-4 w-4" aria-hidden="true" />
                Accès à l'outil
                {(user.pendingCount ?? 0) > 0 && (
                  <span className="ml-auto rounded-full bg-amber-100 px-1.5 text-[10px] font-bold text-amber-800">
                    {user.pendingCount}
                  </span>
                )}
              </DropdownMenuItem>
            )}
            {gmail?.connected ? (
              <DropdownMenuItem onSelect={() => disconnectGmail.mutate()}>
                <MailX className="mr-2 h-4 w-4" aria-hidden="true" />
                Disconnect Gmail
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onSelect={() => {
                  window.location.href = "/api/gmail/connect";
                }}
              >
                <Mail className="mr-2 h-4 w-4" aria-hidden="true" />
                Connect Gmail
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut}>
              <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function TrackerTab({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      className="whitespace-nowrap pb-0.5 text-paper-label data-[status=active]:border-b data-[status=active]:border-paper-ink data-[status=active]:text-paper-ink"
    >
      {children}
    </Link>
  );
}
