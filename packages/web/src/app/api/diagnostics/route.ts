// auth-direct: public diagnostics endpoint — the session lookup is OPTIONAL,
// used only to decide whether to include server logs in the response (admin
// role only — see below). withAuth/withAdmin would force a 401 on
// unauthenticated requests, which would break the public health-check use
// case.
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

  // Server logs can contain unredacted provider errors, stack traces, and
  // other diagnostic detail from OTHER users' sessions (the capture buffer
  // is process-global, not per-user). Restrict to admins only — a plain
  // member has no business reading another user's error traces.
  if (session?.user?.role === "admin") {
    response.logs = logCapture.formatAsText();
  } else if (session?.user) {
    // Signed in, but not an admin. An absent `logs` field on its own cannot
    // say WHY it is absent, and the in-app bug reporter has to tell the two
    // causes apart: it can send whoever is holding the host shell to
    // `docker compose logs`, but a member has no account there and needs
    // their administrator instead. The anonymous caller is the setup
    // wizard's pre-flight check — that person IS the host operator, so no
    // marker for them.
    response.logsWithheld = "admin-only";
  }

  return NextResponse.json(response);
}
