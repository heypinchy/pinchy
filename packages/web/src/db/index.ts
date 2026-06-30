import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL!;

// Explicit pool sizing (#263): postgres-js defaults to max=10 with
// idle_timeout=0 (idle connections never close). At ~50 concurrent requests
// the default pool saturates and queues. max=20 with a 30 s idle timeout
// keeps headroom for bursty chat/audit/usage traffic while letting idle
// connections reclaim during quiet periods; connect_timeout=10 fails fast
// against a misconfigured/unreachable DB instead of hanging boot.
const client = postgres(connectionString, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
});
export const db = drizzle(client, { schema });

/**
 * Close the postgres-js connection pool. Called during graceful shutdown so
 * `docker compose down` doesn't hang on lingering DB connections past the
 * HTTP server close. `timeout: 5` gives in-flight queries up to 5 s to settle
 * before the pool is force-closed (#263).
 */
export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}
