// audit-exempt: read-only MCP tool discovery, no state changes
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { listMcpTools } from "@/lib/integrations/mcp-client";
import { isMcpEnabled } from "@/lib/feature-flags";

const testMcpSchema = z.object({
  url: z.string().url(),
  transport: z.enum(["http", "sse"]),
  token: z.string().min(1),
});

export const POST = withAdmin(async (request) => {
  if (!isMcpEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = await parseRequestBody(testMcpSchema, request);
  if ("error" in parsed) return parsed.error;

  const { url, transport, token } = parsed.data;

  try {
    const tools = await listMcpTools({ url, transport, token });
    return NextResponse.json({ tools });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
});
