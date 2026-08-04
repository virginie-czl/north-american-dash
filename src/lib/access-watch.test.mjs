/**
 * The waiting identity, and the cadence that watches for a decision.
 *
 * The waiting cookie is signed with the same secret as a session because it carries the
 * same thing — an identity Google verified. What keeps it from being a way in is a single
 * claim check, so that is what is pinned hardest here: a pending token pasted into the
 * session cookie must not open the app, and the conversion to a real session must be
 * reachable only through an approved standing.
 */
import { readFileSync } from "node:fs";

process.env.SESSION_SECRET ??= "test-secret-for-access-watch";

const { pollDelay, FAST_POLL_MS, SLOW_POLL_MS, FAST_POLL_FOR_MS } =
  await import("./use-access-watch.ts");
const { signPendingIdentity, signSession, verifyPendingToken, verifySessionToken } =
  await import("./session.server.ts");

let pass = 0,
  fail = 0;
const t = (name, cond, got = "") => {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, got);
  }
};

const user = { id: "1234567890", email: "new.joiner@naboo.app", name: "New Joiner", picture: null };

console.log("\n[the waiting identity is not a session]");
{
  const pendingToken = await signPendingIdentity(user);
  const sessionToken = await signSession(user);

  t(
    "a waiting identity verifies as one",
    (await verifyPendingToken(pendingToken))?.email === user.email,
  );
  t("it carries the account through", (await verifyPendingToken(pendingToken))?.id === user.id);
  // The whole point: same secret, so only the claim stands between the two.
  t("it is refused as a session", (await verifySessionToken(pendingToken)) === null);
  t(
    "and a session is refused as a waiting identity",
    (await verifyPendingToken(sessionToken)) === null,
  );
  t(
    "a real session still verifies",
    (await verifySessionToken(sessionToken))?.email === user.email,
  );
  t("a forged token verifies as neither", (await verifySessionToken("not.a.token")) === null);
  const exp = (token) =>
    JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp;
  t("it expires long before a session does", exp(pendingToken) < exp(sessionToken), {
    pending: exp(pendingToken),
    session: exp(sessionToken),
  });
}

console.log("\n[the cadence]");
{
  t("the first checks are quick", pollDelay(0) === FAST_POLL_MS);
  t("still quick just before the switch", pollDelay(FAST_POLL_FOR_MS - 1) === FAST_POLL_MS);
  // An approval that has not landed in two minutes is not landing in the next ten.
  t("then it eases off", pollDelay(FAST_POLL_FOR_MS) === SLOW_POLL_MS);
  t("and stays eased off", pollDelay(60 * 60 * 1000) === SLOW_POLL_MS);
  t("quick is quicker than eased off", FAST_POLL_MS < SLOW_POLL_MS);
}

console.log("\n[the endpoint]");
{
  const src = readFileSync(new URL("./auth-routes.server.ts", import.meta.url), "utf8");
  const status = src.slice(src.indexOf("async function handleAccessStatus"));
  const body = status.slice(0, status.indexOf("\nfunction handleLogout"));

  t("the status endpoint is routed", /pathname === "\/api\/auth\/status"/.test(src));
  t("and only for GET", /"\/api\/auth\/status" && request\.method === "GET"/.test(src));
  // A session is only ever minted from an approved standing, read live.
  t(
    "a session is minted only when approved",
    /if \(status === "approved" && !session\)/.test(body),
  );
  t(
    "the standing is read past the cache",
    /getAccess\(identity\.email, \{ fresh: true \}\)/.test(body),
  );
  t("the waiting cookie is dropped once it is spent", /PENDING_COOKIE, ""/.test(body));
  t("nothing is cached by the browser either", /"cache-control": "no-store"/.test(body));
  // Approved with no page ticked is still a locked door.
  t("readiness needs somewhere to go", /trackers\.length > 0 \|\| isAdmin\(role\)/.test(body));

  const callback = src.slice(src.indexOf("async function handleCallback"));
  const callbackBody = callback.slice(0, callback.indexOf("\n/**"));
  t(
    "only a pending account is remembered",
    /if \(standing\.status === "pending"\)/.test(callbackBody),
  );
  t(
    "signing out forgets the waiting identity too",
    /PENDING_COOKIE, ""/.test(src.slice(src.indexOf("function handleLogout"))),
  );
}

console.log("\n[the watcher]");
{
  const src = readFileSync(new URL("./use-access-watch.ts", import.meta.url), "utf8");
  // The new session cookie only takes effect on a real load — a router navigation would
  // re-run the gate against the cookie the page started with.
  t("entering the app is a full load", /window\.location\.href = "\/"/.test(src));
  t("it only enters when ready", /if \(next\.ready\)/.test(src));
  t("a hidden tab does not poll", /visibilityState === "visible"/.test(src));
  t("and is woken when looked at again", /addEventListener\("visibilitychange"/.test(src));
  t(
    "polling stops once there is an answer",
    /status === "blocked" \|\| next\?\.status === "signed-out"/.test(src),
  );
  t("a network failure is not an answer", /catch \{[\s\S]{0,200}return null;/.test(src));
}

// ── The board is something access is given to ───────────────────────────────
// It has no data of its own, so the temptation is to leave it open to everyone who is
// signed in. But it is a page, an admin can want it gone for somebody, and a gate that
// exists only in the nav is decoration. Every entry point asks.
console.log("\n[the task board is grantable]");
{
  const { ALL_ACCESS, ALL_TRACKERS, isAccessKey, isTrackerKey, areaLabel } =
    await import("./trackers.ts");
  t("tasks is an area access can be given to", isAccessKey("tasks"));
  t("and it is listed with the trackers", ALL_ACCESS.includes("tasks"));
  // The distinction that keeps it out of the tracker picker on a typed task, out of the
  // board's own chips, and out of every count that means "which ledger is this about".
  t("but it is not a tracker", !isTrackerKey("tasks") && !ALL_TRACKERS.includes("tasks"));
  t("every tracker is still an area", ALL_TRACKERS.every(isAccessKey));
  t("and nothing else is", !isAccessKey("admin") && !isAccessKey(""));
  t("it has a name for the admin screen", areaLabel("tasks") === "Tasks");

  const board = readFileSync(new URL("./tasks.functions.ts", import.meta.url), "utf8");
  const asks = (board.match(/requireTracker\("tasks"\)/g) ?? []).length;
  // Read plus four mutations: fetchBoard, saveTaskState, createManualTask,
  // updateManualTask, deleteTask. A mutation left on requireSession would let a revoked
  // person keep moving cards through the API.
  t("every board entry point asks for it", asks === 5, String(asks));
  t("none of them settle for a session", !/requireSession\(\)/.test(board));

  const page = readFileSync(new URL("../routes/_authenticated/tasks.tsx", import.meta.url), "utf8");
  t("the page redirects when it is not granted", /!allowed\.includes\("tasks"\)/.test(page));
  const shell = readFileSync(
    new URL("../routes/_authenticated/route.tsx", import.meta.url),
    "utf8",
  );
  t("and the tab hides", /allowed\.includes\("tasks"\) && \(/.test(shell));

  const admin = readFileSync(
    new URL("../routes/_authenticated/admin.tsx", import.meta.url),
    "utf8",
  );
  t("the admin screen offers every area", /ACCESS_AREAS\.map/.test(admin));

  // The Slack connector feeds the board and nothing else, so it follows the same grant —
  // except disconnect, which has to stay reachable so a live token can always be revoked.
  const routes = readFileSync(new URL("./auth-routes.server.ts", import.meta.url), "utf8");
  const gated = (routes.match(/hasBoardAccess\(session\.email\)/g) ?? []).length;
  t("connect, callback, status and sync ask", gated === 4, String(gated));
  t(
    "disconnect does not",
    !/hasBoardAccess[\s\S]{0,200}handleSlackDisconnect/.test(routes) &&
      /async function handleSlackDisconnect[\s\S]{0,220}disconnectSlack/.test(routes),
  );
  const cron = readFileSync(new URL("./cron-routes.server.ts", import.meta.url), "utf8");
  t("and the cron skips accounts without the board", /!trackers\.includes\("tasks"\)/.test(cron));

  // Nobody loses the board because it became grantable — but the backfill that gives it
  // to everyone must run once, or it would hand it back to each person an admin takes it
  // from, on every deploy, silently.
  const db = readFileSync(new URL("./db.server.ts", import.meta.url), "utf8");
  t("new people get the board by default", /'na', 'tasks'\]::text\[\]/.test(db));
  t("existing people are backfilled", /array_append\(trackers, 'tasks'\)/.test(db));
  t("through a marker table", /INSERT INTO schema_migrations \(id\)/.test(db));
  t("and only on the run that claims it", /WHERE EXISTS \(SELECT 1 FROM claimed\)/.test(db));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
