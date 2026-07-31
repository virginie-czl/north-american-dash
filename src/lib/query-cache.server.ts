/**
 * Short-lived cache for expensive BigQuery payloads (server-only).
 *
 * The tracker queries scan tens of megabytes across a dozen joins; the cost is
 * BigQuery's job latency rather than the data volume, so the fix is not to make
 * them cheaper but to stop running them on every page load. Finance figures move
 * slowly, and the Refresh button bypasses the cache when freshness matters.
 */
const DEFAULT_TTL_SECONDS = 300;

export async function readCache<T>(
  key: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<T | null> {
  try {
    const { db } = await import("./db.server");
    const sql = await db();
    const rows = await sql<{ payload: string }[]>`
      SELECT payload FROM query_cache
      WHERE cache_key = ${key}
        AND computed_at > now() - make_interval(secs => ${ttlSeconds})
    `;
    if (!rows[0]) return null;
    return JSON.parse(rows[0].payload) as T;
  } catch (error) {
    // A cache miss must never take the page down with it.
    console.error(`query cache read failed for ${key}:`, error);
    return null;
  }
}

export async function writeCache(key: string, value: unknown): Promise<void> {
  try {
    const { db } = await import("./db.server");
    const sql = await db();
    await sql`
      INSERT INTO query_cache (cache_key, payload, computed_at)
      VALUES (${key}, ${JSON.stringify(value)}, now())
      ON CONFLICT (cache_key) DO UPDATE
        SET payload = EXCLUDED.payload, computed_at = now()
    `;
  } catch (error) {
    console.error(`query cache write failed for ${key}:`, error);
  }
}

/** Age of a cached entry in seconds, or null when absent. */
export async function cacheAge(key: string): Promise<number | null> {
  try {
    const { db } = await import("./db.server");
    const sql = await db();
    const rows = await sql<{ age: number }[]>`
      SELECT EXTRACT(EPOCH FROM (now() - computed_at))::int AS age
      FROM query_cache WHERE cache_key = ${key}
    `;
    return rows[0]?.age ?? null;
  } catch {
    return null;
  }
}
