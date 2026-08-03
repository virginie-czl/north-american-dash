import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAccessWatch } from "@/lib/use-access-watch";

const searchSchema = z.object({
  error: z.string().optional(),
  status: z.string().optional(),
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
  const { error: errorParam, status } = Route.useSearch();
  const error = errorParam ? (ERROR_MESSAGES[errorParam] ?? ERROR_MESSAGES.oauth) : null;
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Only from the bare sign-in screen. Arriving with a status means the app already
    // knows why this person is not inside, and bouncing them through "/" would only
    // send them straight back here.
    if (status) return;
    fetch("/api/auth/me", { credentials: "include" }).then((res) => {
      if (res.ok) navigate({ to: "/" });
    });
  }, [navigate, status]);

  function handleGoogle() {
    setLoading(true);
    window.location.href = "/api/auth/google";
  }

  if (status === "pending" || status === "no-tracker") {
    return <WaitingCard waitingFor={status === "pending" ? "approval" : "trackers"} />;
  }

  if (status === "blocked") return <RefusedCard />;

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

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-navy px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="font-display text-xl font-bold">{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">{children}</CardContent>
      </Card>
    </div>
  );
}

function RefusedCard() {
  return (
    <Shell title="Accès refusé">
      <p>
        Votre accès à cet outil a été refusé ou révoqué. Contactez l'équipe Finance si vous pensez
        qu'il s'agit d'une erreur.
      </p>
      <Button
        variant="outline"
        className="w-full"
        onClick={() => {
          window.location.href = "/auth";
        }}
      >
        Retour
      </Button>
    </Shell>
  );
}

/**
 * The two ways of being outside the door with nothing to do about it: waiting for an
 * admin to approve the account, and waiting for one to tick which pages it may open.
 *
 * Both watch for the decision and let themselves in the moment it lands, so nobody has
 * to sit refreshing a page or guess when to try again. The screen keeps a manual button
 * anyway — a person who has just been told "it's done" on Slack should not have to wait
 * out a poll interval to believe it.
 */
function WaitingCard({ waitingFor }: { waitingFor: "approval" | "trackers" }) {
  const watch = useAccessWatch(true, waitingFor === "approval" ? "pending" : "approved");

  // The decision can be a refusal, and the waiting identity can expire while the tab
  // sits open overnight. Both are answers, and neither is this screen.
  if (watch.status === "blocked") return <RefusedCard />;
  if (watch.status === "signed-out") {
    return (
      <Shell title="Session expirée">
        <p>
          Nous ne savons plus qui vous êtes — reconnectez-vous, puis laissez cette page ouverte le
          temps qu'un administrateur valide votre accès.
        </p>
        <Button
          className="w-full border-0 bg-naboo font-semibold text-navy shadow-none hover:bg-naboo-hover"
          onClick={() => {
            window.location.href = "/api/auth/google";
          }}
        >
          Se reconnecter
        </Button>
      </Shell>
    );
  }

  // Approved, but no page ticked yet: the account is in, the door still is not.
  const approvedWithoutTrackers = watch.status === "approved" && !watch.ready;
  const awaitingTrackers = waitingFor === "trackers" || approvedWithoutTrackers;

  return (
    <Shell title={awaitingTrackers ? "Aucun tracker attribué" : "Accès en attente de validation"}>
      {awaitingTrackers ? (
        <p>
          {approvedWithoutTrackers && waitingFor === "approval"
            ? "Votre accès vient d'être validé, mais aucun tracker ne vous a encore été attribué."
            : "Votre accès est validé, mais aucun tracker ne vous a encore été attribué."}{" "}
          Un administrateur doit cocher les pages auxquelles vous avez droit.
        </p>
      ) : (
        <>
          <p>
            Votre compte a bien été reconnu. Un administrateur doit valider votre accès une seule
            fois : votre demande vient d'être enregistrée.
          </p>
          <p>
            Une fois validée, vous entrerez directement à chaque connexion — vous n'aurez plus rien
            à demander.
          </p>
        </>
      )}

      <p className="flex items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-[13px] text-slate-600">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" aria-hidden="true" />
        <span aria-live="polite">
          Cette page s'ouvrira toute seule dès que ce sera fait — vous pouvez la laisser ouverte.
        </span>
      </p>

      <Button
        variant="outline"
        className="w-full"
        onClick={watch.checkNow}
        disabled={watch.checking}
      >
        {watch.checking ? "Vérification…" : "Vérifier maintenant"}
      </Button>
    </Shell>
  );
}
