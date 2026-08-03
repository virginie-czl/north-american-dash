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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
