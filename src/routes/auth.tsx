import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const searchSchema = z.object({
  error: z.string().optional(),
});

export const Route = createFileRoute("/auth")({
  validateSearch: searchSchema,
  component: AuthPage,
});

const ERROR_MESSAGES: Record<string, string> = {
  domain: "Access is restricted to @naboo.app email addresses.",
  oauth: "Sign-in failed. Please try again.",
};

function AuthPage() {
  const navigate = useNavigate();
  const { error: errorParam } = Route.useSearch();
  const error = errorParam ? (ERROR_MESSAGES[errorParam] ?? ERROR_MESSAGES.oauth) : null;
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" }).then((res) => {
      if (res.ok) navigate({ to: "/" });
    });
  }, [navigate]);

  function handleGoogle() {
    setLoading(true);
    window.location.href = "/api/auth/google";
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-1 flex items-center gap-2">
            <svg viewBox="0 0 19 32" fill="#EFF779" aria-hidden="true" className="h-[18px] w-auto">
              <path d="M18.3224 18.2291V31.606H12.8998V17.355C12.8998 13.4644 12.1129 11.5406 10.1011 11.5406C7.78332 11.5406 5.68484 13.9889 5.37882 19.6714V31.606H0V13.4644C2.05549 13.1585 4.02281 12.0658 5.37882 10.7539V17.6609C5.99087 13.2896 7.91521 10.5791 12.3752 10.5791C16.2669 10.5791 18.2786 13.2459 18.3224 18.2291Z" />
            </svg>
            <span className="font-display text-[22px] font-extrabold leading-none tracking-tight">
              naboo
            </span>
            <span className="ml-0.5 rounded-full bg-navy/10 px-[7px] py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-navy/70">
              tracker
            </span>
          </div>
          <CardTitle className="font-display text-xl font-bold">Sign in</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Access is restricted to <strong>@naboo.app</strong> Google accounts.
          </p>
          <Button
            onClick={handleGoogle}
            disabled={loading}
            className="w-full border-0 bg-naboo font-semibold text-navy shadow-none hover:bg-naboo-hover"
          >
            {loading ? "Redirecting…" : "Continue with Google"}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
