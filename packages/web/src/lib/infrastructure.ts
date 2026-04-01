import { db } from "@/db";
import { sql } from "drizzle-orm";

export type InfrastructureStatus = "connected" | "unreachable";

export async function checkDatabase(): Promise<InfrastructureStatus> {
  try {
    await db.execute(sql`SELECT 1`);
    return "connected";
  } catch {
    return "unreachable";
  }
}

export async function checkOpenClaw(): Promise<InfrastructureStatus> {
  const wsUrl = process.env.OPENCLAW_WS_URL;
  if (!wsUrl) return "connected"; // Not configured — nothing to check

  try {
    const httpUrl = wsUrl.replace(/^ws/, "http");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    await fetch(httpUrl, { signal: controller.signal });
    clearTimeout(timeout);

    // Any response (even 4xx) means the server is running
    return "connected";
  } catch {
    return "unreachable";
  }
}
