/**
 * Vercel Cron endpoints (server-only).
 *
 * Scheduled in vercel.json's "crons" array. Vercel invokes these as a plain GET
 * request; the CRON_SECRET bearer check is what distinguishes Vercel's own
 * trigger from anyone who finds the URL — Vercel adds this header itself once
 * CRON_SECRET is set as an environment variable.
 */

function isAuthorizedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function handleRefreshCardApprovals(): Promise<Response> {
  try {
    const { refreshSharedCardApprovalsCache } = await import("./slack-cards.server");
    const approvals = await refreshSharedCardApprovalsCache();
    return new Response(
      JSON.stringify({ ok: true, count: approvals.length, refreshedAt: new Date().toISOString() }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (error) {
    console.error("Cron: refresh-card-approvals failed:", error);
    return new Response(JSON.stringify({ ok: false, error: String(error) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

/** Returns a Response for /api/cron/* requests, or null to fall through to the app. */
export async function handleCronRequest(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/cron/")) return null;

  if (!isAuthorizedCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (pathname === "/api/cron/refresh-card-approvals" && request.method === "GET") {
    return handleRefreshCardApprovals();
  }
  return new Response("Not found", { status: 404 });
}
