/**
 * Scheduled work, dispatched from src/server.ts ahead of the app.
 *
 * One job: pull each connected person's own Slack items so their board is current
 * without anyone pressing anything. Every fifteen minutes (see vercel.json), which is also
 * the window a sync reads mentions over — the two are the same number on purpose, so no
 * quarter hour of somebody's Activity goes unread.
 *
 * Two things this deliberately does not do. It does not touch a person who has not
 * connected Slack, and it does not read anything but that person's own reminders, saved
 * items and mentions of them — the loop is over stored grants, and each iteration uses
 * that grant's own token, anchored to that grant's own handle. A cron with a shared token
 * reading everybody's Slack would be a different feature and not one that was asked for.
 *
 * Authorisation: Vercel signs its own cron calls with `CRON_SECRET`. Without the secret
 * configured the route refuses rather than running open to the internet.
 */
export async function handleCronRequest(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/cron/")) return null;

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("cron called but CRON_SECRET is not set — refusing");
    return new Response("Cron is not configured", { status: 503 });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) return new Response("Forbidden", { status: 403 });

  if (pathname === "/api/cron/slack-tasks") return await runSlackTaskSync();
  return new Response("Not found", { status: 404 });
}

/**
 * Refreshes every connected person's Slack tasks.
 *
 * One person's failure is theirs alone: a revoked grant or a rate limit must not stop the
 * rest of the round, so each is caught and counted. The summary goes to the runtime log
 * because nobody is watching a cron — a silent failure here would show up as a board that
 * quietly stopped changing.
 */
async function runSlackTaskSync(): Promise<Response> {
  const { connectedSlackUsers, syncSlackTasks } = await import("./slack-user.server");
  const emails = await connectedSlackUsers();
  let items = 0;
  const failed: Array<{ email: string; error: string }> = [];

  for (const email of emails) {
    try {
      const result = await syncSlackTasks(email);
      items += result.items;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Slack task sync failed for ${email}:`, message);
      failed.push({ email, error: message });
    }
  }

  const summary = {
    connected: emails.length,
    synced: emails.length - failed.length,
    items,
    failed: failed.length,
  };
  console.log(
    `Slack task cron: ${summary.synced}/${summary.connected} accounts, ${items} items` +
      (failed.length > 0 ? `, ${failed.length} failed` : ""),
  );
  // 200 with the failures named rather than a 500: the round did what it could, and a
  // retry of the whole thing would re-sync the accounts that worked.
  return new Response(JSON.stringify({ ...summary, failures: failed }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
