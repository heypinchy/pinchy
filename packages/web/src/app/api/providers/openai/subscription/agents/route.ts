import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { getAgentsUsingOpenAiProvider } from "@/lib/agents";
// audit-exempt: read-only endpoint, no state changes

export async function GET() {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const agentList = await getAgentsUsingOpenAiProvider();
  return NextResponse.json(agentList);
}
