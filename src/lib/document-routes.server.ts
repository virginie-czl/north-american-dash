/**
 * The document endpoints (server-only): a real PDF, as a file response.
 *
 *   GET /api/statement/{ref}                 → the client statement of account
 *   GET /api/commission/{ref}/{houseCode}    → the per-provider commission statement
 *
 * Plain fetch handlers rather than server functions, because what matters here is the
 * response itself — `Content-Type: application/pdf` and a `Content-Disposition`
 * filename the browser saves without asking. A server function returns JSON.
 *
 * Running ahead of the framework means there is no ambient request context, so the
 * access rule comes from `requireTrackerFor(request, …)` — the same rule every other
 * financial endpoint applies, reached through the Request rather than through storage.
 *
 * Errors come back as plain text with a real status code. The commission statement
 * refuses to render when the services do not add up to the commission claimed, and that
 * refusal has to arrive as a readable sentence on the button, never as a downloaded
 * file containing an error page.
 */

function pdfResponse(pdf: Buffer, filename: string): Response {
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      // The server names the document. The client reads the name back off this header
      // rather than rebuilding it, so there is one source of truth for it.
      "content-disposition": `attachment; filename="${filename.replace(/["\\]/g, "")}"`,
      "content-length": String(pdf.byteLength),
      // Generated per request from a fresh read, and dated today — never a cache hit.
      "cache-control": "no-store",
    },
  });
}

function errorResponse(error: unknown): Response {
  const status =
    typeof (error as { status?: unknown })?.status === "number"
      ? ((error as { status: number }).status ?? 500)
      : 500;
  const message = error instanceof Error ? error.message : String(error);
  console.error("Document render failed:", error);
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

const REF = /^[A-Z]-[A-Z0-9]{2,12}$/;

/** Returns a Response for /api/statement/* and /api/commission/*, or null to fall through. */
export async function handleDocumentRequest(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/statement/") && !pathname.startsWith("/api/commission/")) {
    return null;
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const parts = pathname.split("/").filter(Boolean).slice(1);
  try {
    const { requireTrackerFor } = await import("./session.server");
    await requireTrackerFor(request, "na");

    const { renderPdf } = await import("./pdf.server");
    const { standaloneDocument } = await import("./statement");

    if (parts[0] === "statement") {
      const ref = decodeURIComponent(parts[1] ?? "").toUpperCase();
      if (!REF.test(ref)) return new Response("Invalid booking reference", { status: 400 });
      const { buildNaStatement } = await import("./statement.functions");
      const doc = await buildNaStatement(ref);
      const pdf = await renderPdf(
        standaloneDocument({ title: doc.title, bodyHtml: doc.body_html, css: doc.css }),
      );
      return pdfResponse(pdf, doc.filename);
    }

    const ref = decodeURIComponent(parts[1] ?? "").toUpperCase();
    const house = decodeURIComponent(parts[2] ?? "").toUpperCase();
    if (!REF.test(ref)) return new Response("Invalid booking reference", { status: 400 });
    if (!REF.test(house)) return new Response("Invalid provider code", { status: 400 });
    const { buildNaCommissionStatement } = await import("./commission-statement.functions");
    const doc = await buildNaCommissionStatement(ref, house);
    const pdf = await renderPdf(
      standaloneDocument({ title: doc.title, bodyHtml: doc.body_html, css: doc.css }),
    );
    return pdfResponse(pdf, doc.filename);
  } catch (error) {
    return errorResponse(error);
  }
}
