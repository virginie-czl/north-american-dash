/**
 * Static checks on the document endpoints.
 *
 * They return a file rather than JSON, so they are plain fetch handlers rather than
 * server functions — which means the tracker gate is not applied for them by the
 * framework and has to be applied by hand. That is the thing worth pinning: an
 * unguarded /api/statement/{ref} would hand a client's balance to anyone with a session
 * on any tracker, or none.
 */
import { readFileSync } from "node:fs";
import { handleDocumentRequest } from "./document-routes.server.ts";

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

const src = readFileSync(new URL("./document-routes.server.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

console.log("\n[the endpoints are wired and gated]");
t("dispatched from the fetch handler", /handleDocumentRequest\(request\)/.test(server));
// Compared against the call site, not the declaration of getServerEntry above it.
t(
  "ahead of the framework's own handler",
  server.indexOf("handleDocumentRequest") < server.indexOf("await getServerEntry()"),
);
t("every request goes through the tracker gate", /requireTrackerFor\(request, "na"\)/.test(src));
t(
  "and the gate runs before any rendering",
  src.indexOf("requireTrackerFor") < src.indexOf("renderPdf"),
);
t("the response is a PDF attachment", /content-disposition.*attachment; filename=/.test(src));
t(
  "the filename comes from the document, not the request",
  /pdfResponse\(pdf, doc\.filename\)/.test(src),
);
t("failures answer in plain text, not a PDF", /text\/plain/.test(src));
t("both documents are served", /\/api\/statement\//.test(src) && /\/api\/commission\//.test(src));

console.log("\n[routing]");
{
  const other = await handleDocumentRequest(new Request("http://x/tracking-north-america"));
  t("a path that is not a document falls through to the app", other === null);
  const asset = await handleDocumentRequest(new Request("http://x/api/auth/me"));
  t("so does another api route", asset === null);
  const posted = await handleDocumentRequest(
    new Request("http://x/api/statement/C-P222", { method: "POST" }),
  );
  t("a non-GET is refused", posted?.status === 405, String(posted?.status));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
