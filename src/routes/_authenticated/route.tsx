import { createFileRoute, Link, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { Droplets, Globe, LogOut, ReceiptText } from "lucide-react";

type SessionUser = { id: string; email: string; name: string | null; picture: string | null };

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
    <svg viewBox="0 0 19 32" fill="#EFF779" aria-hidden="true" className={className}>
      <path d="M18.3224 18.2291V31.606H12.8998V17.355C12.8998 13.4644 12.1129 11.5406 10.1011 11.5406C7.78332 11.5406 5.68484 13.9889 5.37882 19.6714V31.606H0V13.4644C2.05549 13.1585 4.02281 12.0658 5.37882 10.7539V17.6609C5.99087 13.2896 7.91521 10.5791 12.3752 10.5791C16.2669 10.5791 18.2786 13.2459 18.3224 18.2291Z" />
    </svg>
  );
}

function AuthedLayout() {
  const router = useRouter();
  const { user } = Route.useRouteContext();
  const email = user?.email ?? "";
  const displayName = user?.name ?? (email
    ? email
        .split("@")[0]
        .split(/[._-]/)
        .filter(Boolean)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(" ")
    : "");
  const initials = email
    ? email
        .split("@")[0]
        .split(/[._-]/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p.charAt(0).toUpperCase())
        .join("") || email.charAt(0).toUpperCase()
    : "?";

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    router.navigate({ to: "/auth" });
  }

  return (
    <div className="flex min-h-screen items-stretch bg-background">
      <aside className="sticky top-0 flex h-screen w-[232px] flex-none flex-col bg-navy px-3.5 py-[22px] text-white">
        <div className="flex items-center gap-2 px-2 pb-5">
          <NabooMark className="h-[18px] w-auto" />
          <span className="font-display text-[22px] font-extrabold leading-none tracking-tight">
            naboo
          </span>
          <span className="ml-0.5 rounded-full bg-white/10 px-[7px] py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-white/75">
            tracker
          </span>
        </div>

        <div className="px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-white/40">
          Trackers
        </div>
        <nav className="flex flex-col gap-0.5">
          <SidebarLink to="/" icon={<ReceiptText className="h-5 w-5" />}>
            L'Oréal CA
          </SidebarLink>
          <SidebarLink to="/veolia" icon={<Droplets className="h-5 w-5" />}>
            Veolia US
          </SidebarLink>
          <SidebarLink to="/tracking-north-america" icon={<Globe className="h-5 w-5" />}>
            Marketplace NA
          </SidebarLink>
        </nav>

        <div className="mt-auto flex items-center gap-2.5 border-t border-white/10 px-2 pt-3.5">
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full bg-naboo text-xs font-bold text-navy">
            {initials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold leading-tight">{displayName}</span>
            <span className="block truncate text-[11px] text-white/50">{email}</span>
          </span>
          <button
            type="button"
            title="Sign out"
            onClick={signOut}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <LogOut className="h-[18px] w-[18px]" />
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

function SidebarLink({
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
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-white/70 transition-colors hover:bg-white/[.06] hover:text-white data-[status=active]:bg-naboo data-[status=active]:font-semibold data-[status=active]:text-navy data-[status=active]:hover:bg-naboo-hover"
    >
      {icon}
      {children}
    </Link>
  );
}
