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

/** How long the first call waits before we start polling the job by id. */
const FIRST_WAIT_MS = 20_000;
/** How long each follow-up wait blocks for. */
const POLL_WAIT_MS = 10_000;
/** Total budget for one query, polling included. Keep under the function limit. */
const TOTAL_BUDGET_MS = 50_000;

type QueryPayload = {
  jobComplete?: boolean;
  jobReference?: { jobId?: string; location?: string };
  schema?: { fields: Array<{ name: string; type: string }> };
  rows?: Array<{ f: Array<{ v: unknown }> }>;
  pageToken?: string;
};

async function readPayload(response: Response): Promise<QueryPayload> {
  if (!response.ok) {
    const raw = await response.text();
    let message = raw;
    try {
      message = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? raw;
    } catch {
      /* keep the raw body */
    }
    throw new Error(`BigQuery: ${message}`);
  }
  return (await response.json()) as QueryPayload;
}

/**
 * Collect one page of an already-started job.
 *
 * `jobs.query` only ever waits a fixed time before answering; a slower query
 * comes back with `jobComplete: false` while the job carries on running server
 * side. Reading it back by id is how you wait for it — the alternative, which
 * this used to do, is to call a still-running job a failure.
 */
async function fetchResults(
  accessToken: string,
  jobId: string,
  location: string,
  pageToken?: string,
): Promise<QueryPayload> {
  const url = new URL(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT_ID}/queries/${jobId}`,
  );
  url.searchParams.set("location", location);
  url.searchParams.set("timeoutMs", String(POLL_WAIT_MS));
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return readPayload(await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }));
}

export async function runBigQuery(
  query: string,
  params?: Record<string, string | number>,
  location = "EU",
): Promise<BigQueryRow[]> {
  const accessToken = await getAccessToken();
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  const body: Record<string, unknown> = {
    query,
    useLegacySql: false,
    location,
    maximumBytesBilled: "5368709120", // 5 GB safety cap
    timeoutMs: FIRST_WAIT_MS,
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

  let payload = await readPayload(response);
  const jobId = payload.jobReference?.jobId;
  const jobLocation = payload.jobReference?.location ?? location;

  // Wait the job out rather than reporting a failure the moment it outlives one
  // request. Only a job still unfinished at the budget is given up on.
  while (payload.jobComplete === false) {
    if (!jobId) throw new Error("BigQuery: no job id to wait on.");
    if (Date.now() >= deadline) {
      throw new Error("BigQuery job did not complete in time — please retry.");
    }
    payload = await fetchResults(accessToken, jobId, jobLocation);
  }

  const schema = payload.schema?.fields || [];
  const toRows = (page: QueryPayload): BigQueryRow[] =>
    (page.rows || []).map((row) => {
      const obj: BigQueryRow = {};
      row.f.forEach((cell, i) => {
        const field = schema[i];
        obj[field.name] = convertValue(cell.v, field.type) as BigQueryValue;
      });
      return obj;
    });

  const rows = toRows(payload);
  // Big result sets come back a page at a time. Reading only the first page
  // returns a truncated table that looks perfectly healthy.
  let pageToken = payload.pageToken;
  while (pageToken) {
    if (!jobId) break;
    if (Date.now() >= deadline) {
      throw new Error("BigQuery returned more rows than we could read in time — please retry.");
    }
    const page = await fetchResults(accessToken, jobId, jobLocation, pageToken);
    rows.push(...toRows(page));
    pageToken = page.pageToken;
  }
  return rows;
}
