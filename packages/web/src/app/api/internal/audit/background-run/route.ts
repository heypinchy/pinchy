import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api-auth";
import { appendAuditLog } from "@/lib/audit";
import { parseRequestBody } from "@/lib/api-validation";

const BackgroundRunBody = z.object({
  agentId: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
});

export const POST = withAuth(async (req: NextRequest, _ctx, session) => {
  const parsed = await parseRequestBody(BackgroundRunBody, req);
  if ("error" in parsed) return parsed.error;

  const { agentId, durationMs } = parsed.data;

  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "chat.background_run_completed",
    resource: `agent:${agentId}`,
    detail: { agentId, durationMs },
    outcome: "success",
  });

  return new NextResponse(null, { status: 204 });
});
