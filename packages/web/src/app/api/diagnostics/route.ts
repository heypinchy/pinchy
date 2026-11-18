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
    // causes apart: a member has no account on the host, so sending them to
    // `docker compose logs` yields a report with no logs and an instruction
    // they cannot follow — their administrator is the step they can take.
    // An anonymous caller gets no marker, because with no session there is
    // no role to withhold for. That is deliberately NOT a claim that the
    // caller holds the host shell: nothing in the request separates whoever
    // is running the setup wizard from a signed-out member, so the client's
    // fallback copy names both routes instead.
    response.logsWithheld = "admin-only";
  }

  return NextResponse.json(response);
}
