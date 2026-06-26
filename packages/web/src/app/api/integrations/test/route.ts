// audit-exempt: read-only MCP tool discovery, no state changes
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { listMcpTools, mcpErrorCodeFromError } from "@/lib/integrations/mcp-client";
import { isMcpEnabled } from "@/lib/feature-flags";

const testMcpSchema = z.object({
  url: z.string().url(),
  transport: z.enum(["http", "sse"]),
  token: z.string().min(1),
  // Same shape as POST /api/integrations — used today by HighLevel to send
  // the required `locationId` header during pre-save discovery.
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

export const POST = withAdmin(async (request) => {
  if (!isMcpEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = await parseRequestBody(testMcpSchema, request);
  if ("error" in parsed) return parsed.error;

  const { url, transport, token, extraHeaders } = parsed.data;

  try {
    const tools = await listMcpTools({ url, transport, token, extraHeaders });
    return NextResponse.json({ tools });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `code` lets the dialog render a human-friendly, preset-aware message
    // (mcp-error-messages.ts); the raw `error` string stays available as a
    // debugging detail for custom MCP servers.
    return NextResponse.json({ error: message, code: mcpErrorCodeFromError(err) }, { status: 502 });
  }
});
