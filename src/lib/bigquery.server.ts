/**
 * Shared BigQuery client (server-only).
 * Adapted from the naboo-bigquery edge function shared client.
 */

export const PROJECT_ID = "naboo-app-365515";

const BQ_SCOPES = [
  "https://www.googleapis.com/auth/bigquery",
  "https://www.googleapis.com/auth/drive.readonly",
];

const TOKEN_TTL_MS = 50 * 60 * 1000;
let cachedToken: { token: string; expiresAt: number } | null = null;

interface ServiceAccountCredentials {
  private_key: string;
  client_email: string;
  token_uri: string;
}

export type BigQueryValue = string | number | boolean | null;
export type BigQueryRow = Record<string, BigQueryValue>;

function getCredentials(): ServiceAccountCredentials {
  const keyJson = process.env.BIG_QUERY_JSON || "";
  if (!keyJson) throw new Error("BIG_QUERY_JSON environment variable is not set");
  try {
    return JSON.parse(Buffer.from(keyJson, "base64").toString("utf8"));
  } catch {
    return JSON.parse(keyJson);
  }
}

function b64url(input: ArrayBuffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function createJWT(credentials: ServiceAccountCredentials): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: credentials.client_email,
    scope: BQ_SCOPES.join(" "),
    aud: credentials.token_uri,
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const unsignedToken = `${headerB64}.${payloadB64}`;

  const pemContents = credentials.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binaryDer = Uint8Array.from(Buffer.from(pemContents, "base64"));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedToken),
  );

  return `${unsignedToken}.${b64url(signature)}`;
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt) return cachedToken.token;

  const creds = getCredentials();
  const jwt = await createJWT(creds);

  const response = await fetch(creds.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get access token: ${await response.text()}`);
  }
  const data = (await response.json()) as { access_token: string };
  cachedToken = { token: data.access_token, expiresAt: now + TOKEN_TTL_MS };
  return data.access_token;
}

function convertValue(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;
  const v = (value as { v?: unknown }).v ?? value;
  if (v === null || v === undefined) return null;
  switch (type) {
    case "INTEGER":
    case "INT64":
      return Number(v);
    case "FLOAT":
    case "FLOAT64":
    case "NUMERIC":
    case "BIGNUMERIC":
      return Number(v);
    case "BOOLEAN":
    case "BOOL":
      return v === "true" || v === true;
    case "TIMESTAMP":
      return new Date(Number(v) * 1000).toISOString();
    default:
      return v;
  }
}

/**
 * How many rows to ask for per page, and how many pages to walk.
 *
 * `jobs.query` returns one page: capped by a row count *and* by a ~10 MB
 * response, whichever comes first. Nothing here relied on that before, so a query
 * that outgrew a page had the rest of its rows silently dropped — on a tracker
 * whose rows are bookings and money. The page cap is a runaway guard: hitting it
 * throws rather than returning a short answer.
 */
export const RESULT_PAGE_SIZE = 20_000;
export const MAX_RESULT_PAGES = 20;

/** BigQuery's own default is 10 s, which the Marketplace NA query outgrew. */
export const QUERY_TIMEOUT_MS = 120_000;

type SchemaField = { name: string; type: string };

export type BigQueryPage = {
  jobComplete?: boolean;
  schema?: { fields: SchemaField[] };
  rows?: Array<{ f: Array<{ v: unknown }> }>;
  pageToken?: string;
  /** A string in the REST response, e.g. "265". */
  totalRows?: string;
  jobReference?: { jobId?: string; location?: string; projectId?: string };
};

function mapRows(page: BigQueryPage, schema: SchemaField[]): BigQueryRow[] {
  return (page.rows || []).map((row) => {
    const obj: BigQueryRow = {};
    row.f.forEach((cell, i) => {
      const field = schema[i];
      if (!field) return;
      obj[field.name] = convertValue(cell.v, field.type) as BigQueryValue;
    });
    return obj;
  });
}

/**
 * Walks every page of a result set and refuses to return a partial one.
 *
 * Two guarantees, both of which the single-page read never gave:
 *
 *  - Every page is read. `pageToken` is followed until it is absent.
 *  - The result is complete or it is an error. `totalRows` is what BigQuery says
 *    the answer holds; if fewer rows arrive, this throws instead of handing back a
 *    plausible-looking short list. A missing booking with no error shown is worse
 *    than a failed page load, because nobody goes looking for it.
 *
 * Separated from the HTTP call so the paging itself can be tested.
 */
export async function collectQueryPages(
  first: BigQueryPage,
  nextPage: (pageToken: string) => Promise<BigQueryPage>,
  maxPages = MAX_RESULT_PAGES,
): Promise<BigQueryRow[]> {
  // A timed-out job returns HTTP 200 with no rows, so an incomplete job has to be
  // caught explicitly or it reads as an empty result.
  if (first.jobComplete === false) {
    throw new Error("BigQuery job did not complete in time — please retry.");
  }

  const schema = first.schema?.fields ?? [];
  const rows = mapRows(first, schema);
  let token = first.pageToken;
  let pages = 1;
  let totalRows = first.totalRows;

  while (token) {
    if (pages >= maxPages) {
      throw new Error(
        `BigQuery result spans more than ${maxPages} pages (${rows.length} rows so far) — ` +
          "narrow the query rather than reading a partial result.",
      );
    }
    const page = await nextPage(token);
    if (page.jobComplete === false) {
      throw new Error("BigQuery job did not complete in time — please retry.");
    }
    rows.push(...mapRows(page, page.schema?.fields ?? schema));
    // Later pages restate it; the last word wins.
    if (page.totalRows != null) totalRows = page.totalRows;
    token = page.pageToken;
    pages += 1;
  }

  const expected = totalRows == null ? null : Number(totalRows);
  if (expected != null && Number.isFinite(expected) && expected !== rows.length) {
    throw new Error(`BigQuery returned ${rows.length} of ${expected} rows — result was truncated.`);
  }

  return rows;
}

export async function runBigQuery(
  query: string,
  params?: Record<string, string | number>,
  location = "EU",
): Promise<BigQueryRow[]> {
  const accessToken = await getAccessToken();

  const body: Record<string, unknown> = {
    query,
    useLegacySql: false,
    location,
    maximumBytesBilled: "5368709120", // 5 GB safety cap
    // Explicit, so the page size is ours rather than whatever the API defaults to.
    maxResults: RESULT_PAGE_SIZE,
    // Milliseconds the API waits for the job before answering with jobComplete
    // false. The default 10 s is shorter than the heavier tracker queries take.
    timeoutMs: QUERY_TIMEOUT_MS,
  };

  if (params && Object.keys(params).length > 0) {
    body.parameterMode = "NAMED";
    body.queryParameters = Object.entries(params).map(([name, value]) => ({
      name,
      parameterType: { type: typeof value === "number" ? "INT64" : "STRING" },
      parameterValue: { value: String(value) },
    }));
  }

  const response = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT_ID}/queries`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) throw new Error(`BigQuery: ${await errorMessage(response)}`);

  const first = (await response.json()) as BigQueryPage;
  const jobId = first.jobReference?.jobId;
  const jobLocation = first.jobReference?.location ?? location;

  return collectQueryPages(first, async (pageToken) => {
    if (!jobId) {
      throw new Error("BigQuery returned a paged result without a job reference.");
    }
    const url = new URL(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT_ID}/queries/${encodeURIComponent(
        jobId,
      )}`,
    );
    url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("maxResults", String(RESULT_PAGE_SIZE));
    url.searchParams.set("location", jobLocation);
    url.searchParams.set("timeoutMs", String(QUERY_TIMEOUT_MS));

    const page = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!page.ok) throw new Error(`BigQuery (page): ${await errorMessage(page)}`);
    return (await page.json()) as BigQueryPage;
  });
}

/** The API puts the useful part in `error.message`; fall back to the raw body. */
async function errorMessage(response: Response): Promise<string> {
  const raw = await response.text();
  try {
    return (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? raw;
  } catch {
    return raw;
  }
}
