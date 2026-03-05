import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { logCapture } from "@/lib/log-capture";
import { getSession } from "@/lib/auth";
import { headers } from "next/headers";

async function checkDatabase(): Promise<"connected" | "unreachable"> {
  try {
    await db.execute(sql`SELECT 1`);
    return "connected";
  } catch {
    return "unreachable";
  }
}

async function checkOpenClaw(): Promise<"connected" | "unreachable"> {
  const wsUrl = process.env.OPENCLAW_WS_URL;
  if (!wsUrl) return "unreachable";

  try {
    const httpUrl = wsUrl.replace(/^ws/, "http");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    await fetch(httpUrl, { signal: controller.signal });
    clearTimeout(timeout);

    // Any response (even 4xx) means the server is running
    return "connected";
  } catch {
    return "unreachable";
  }
}

export async function GET() {
  const [database, openclaw, session] = await Promise.all([
    checkDatabase(),
    checkOpenClaw(),
    getSession({ headers: await headers() }),
  ]);

  const response: Record<string, unknown> = {
    database,
    openclaw,
    version: process.env.NEXT_PUBLIC_PINCHY_VERSION ?? "unknown",
    nodeEnv: process.env.NODE_ENV ?? "unknown",
  };

  // Only include server logs for authenticated users
  if (session?.user) {
    response.logs = logCapture.formatAsText();
  }

  return NextResponse.json(response);
}
