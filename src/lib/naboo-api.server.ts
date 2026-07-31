/**
 * Minimal Naboo GraphQL client (server-only).
 *
 * The tracker calls this to fetch partner invoice PDFs (reInvoicingRequests)
 * which live in MongoDB and are not synced to BigQuery.
 *
 * Auth: a long-lived admin JWT stored in NABOO_ADMIN_TOKEN. Generate one from
 * the Naboo BO (Settings → API / developer access, or ask the tech team).
 * The token is never sent to the browser — all calls go through server functions.
 */

const GQL = "https://api.services.naboo.app/graphql";

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = process.env.NABOO_ADMIN_TOKEN;
  if (!token) {
    throw new Error(
      "NABOO_ADMIN_TOKEN is not set — required to fetch partner invoice PDFs from the Naboo API.",
    );
  }
  const res = await fetch(GQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Naboo API HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Naboo API: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json.data as T;
}

export type ReInvoicingPdf = {
  pdfUrl: string | null;
};

export type ReInvoicingRequest = {
  userProvidedData: ReInvoicingPdf | null;
};

type GqlResult = {
  getClientRequestByIdAdmin: {
    reInvoicingRequests: ReInvoicingRequest[] | null;
  } | null;
};

const QUERY = `
  query ReInvoicingRequests($clientRequestId: String!) {
    getClientRequestByIdAdmin(clientRequestId: $clientRequestId) {
      reInvoicingRequests {
        userProvidedData {
          pdfUrl
        }
      }
    }
  }
`;

export async function fetchReInvoicingPdfs(clientRequestId: string): Promise<string[]> {
  const data = await gql<GqlResult>(QUERY, { clientRequestId });
  const requests = data?.getClientRequestByIdAdmin?.reInvoicingRequests ?? [];
  return requests
    .map((r) => r.userProvidedData?.pdfUrl ?? null)
    .filter((url): url is string => Boolean(url));
}
