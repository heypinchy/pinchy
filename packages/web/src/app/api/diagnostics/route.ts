// auth-direct: public diagnostics endpoint — the session lookup is OPTIONAL,
// used only to decide whether to include server logs in the response.
// withAuth/withAdmin would force a 401 on unauthenticated requests, which
// would break the public health-check use case.
import { NextResponse } from "next/server";
import { logCapture } from "@/lib/log-capture";
import { getSession } from "@/lib/auth";
import { headers } from "next/headers";
import { checkDatabase, checkOpenClaw } from "@/lib/infrastructure";

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
