import { createFileRoute, Link, Outlet, redirect, useRouter } from "@tanstack/react-router";
import {
  Download,
  Droplets,
  Globe,
  LogOut,
  Mail,
  MailX,
  ReceiptText,
  RefreshCw,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
  admin?: boolean;
  pendingCount?: number;
};

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    if (!res.ok) {
      throw redirect({ to: "/auth" });
    }
    const user = (await res.json()) as SessionUser;
    return { user };
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
    <header className="flex h-14 flex-none items-center gap-4 border-b border-border bg-white px-5">
      <span className="flex items-center gap-1.5 text-navy">
        <NabooMark className="h-[17px] w-auto" />
        <span className="font-display text-[19px] font-extrabold leading-none tracking-tight">
          naboo
        </span>
        <span className="ml-0.5 rounded-full bg-slate-100 px-[7px] py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-600">
          tracker
        </span>
      </span>

      <nav aria-label="Trackers" className="ml-3 flex items-center gap-1">
        <TrackerTab to="/" icon={<ReceiptText className="h-4 w-4" aria-hidden="true" />}>
          L'Oréal CA
        </TrackerTab>
        <TrackerTab to="/veolia" icon={<Droplets className="h-4 w-4" aria-hidden="true" />}>
          Veolia US
        </TrackerTab>
        <TrackerTab
          to="/tracking-north-america"
          icon={<Globe className="h-4 w-4" aria-hidden="true" />}
        >
          Marketplace NA
        </TrackerTab>
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {exports.length === 1 ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={exports[0].onClick}
            disabled={exports[0].disabled}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            {exports[0].label}
          </Button>
        ) : exports.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5">
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                Export
              </Button>
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

        {actions.onRefresh && (
          <Button
            size="sm"
            onClick={actions.onRefresh}
            disabled={actions.isFetching}
            className="h-8 gap-1.5 border-0 bg-naboo font-semibold text-navy shadow-none hover:bg-naboo-hover"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${actions.isFetching ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            Refresh
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="relative flex h-[30px] w-[30px] items-center justify-center rounded-full"
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
                className="h-[30px] w-[30px]"
                textClassName="text-xs"
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

function TrackerTab({
  to,
  icon,
  children,
}: {
  to: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-slate-700 transition-colors hover:bg-slate-100 data-[status=active]:bg-naboo data-[status=active]:font-semibold data-[status=active]:text-navy"
    >
      {icon}
      {children}
    </Link>
  );
}
