import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { listAdminOnlyAgents } from "@/lib/admin-only-agents";

/**
 * Shared agents only admins can use while a license is active: `restricted`
 * with no group (#1278). Answers in every license state on purpose — on a
 * community instance it is the list of agents members would lose the moment a
 * key is entered, which is the moment an admin needs to know it.
 */
export const GET = withAdmin(async () => {
  return NextResponse.json({ agents: await listAdminOnlyAgents() });
});
