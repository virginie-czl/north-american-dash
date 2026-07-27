/**
 * Server function: fetch partner invoice PDFs for one event.
 *
 * The PDF URLs are signed S3 links that expire after ~15 minutes, so they must
 * be fetched on demand rather than stored. The result is never cached in the DB.
 */
import { createServerFn } from "@tanstack/react-start";

export type ReInvoicingResult = {
  pdfs: string[];
};

export const fetchReInvoicingPdfs = createServerFn({ method: "GET" })
  .validator((input: { client_request_id: string }) => {
    if (!input?.client_request_id || typeof input.client_request_id !== "string") {
      throw new Error("client_request_id is required");
    }
    return input;
  })
  .handler(async ({ data }): Promise<ReInvoicingResult> => {
    const { requireSession } = await import("./session.server");
    await requireSession();
    const { fetchReInvoicingPdfs: fetch } = await import("./naboo-api.server");
    const pdfs = await fetch(data.client_request_id);
    return { pdfs };
  });
