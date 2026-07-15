import { z } from "zod";
import { RESERVED_HEADERS } from "@/lib/integrations/mcp-shared";
import { MCP_PRESET_IDS } from "@/lib/integrations/mcp-presets";

// Shared with the create route (api/integrations/route.ts) AND the connect
// dialog (add-integration-dialog.tsx) — see AGENTS.md "Shared Schemas And
// Typed Client". Deliberately imports from mcp-shared.ts, not mcp-client.ts:
// the latter pulls in the MCP SDK and is server-only, and this schema is
// imported from a "use client" component.
export const mcpCreateSchema = z
  .object({
    type: z.literal("mcp"),
    name: z.string().min(1).max(100),
    description: z.string().max(500).default(""),
    preset: z.enum(MCP_PRESET_IDS),
    transport: z.enum(["http", "sse"]),
    url: z.string().url(),
    token: z.string().min(1),
    // Per-connection metadata the MCP credential proxy injects as HTTP headers
    // alongside Authorization: Bearer <token> when forwarding to the upstream.
    // Today only HighLevel needs this (locationId Sub-Account ID); other
    // presets ignore it. Values are non-secret and stay in Pinchy's DB (never
    // openclaw.json) — see AGENTS.md § Secret Handling, Pattern B.
    extraHeaders: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.extraHeaders) return;
    // The proxy (api/internal/mcp-proxy/[connectionId]/route.ts) always
    // strips these names out of extraHeaders via the same RESERVED_HEADERS
    // set before injecting the real Authorization header — silently
    // accepting them here and dropping them later would mean an admin's
    // "Test Connection" (which also strips them) looks identical to what
    // actually goes out at runtime, but a header they typed in the create
    // form would silently never apply. Reject at create time instead so the
    // admin finds out immediately, same principle as the HighLevel
    // locationId check in the route.
    const reserved = Object.keys(val.extraHeaders).filter((key) =>
      RESERVED_HEADERS.has(key.toLowerCase())
    );
    if (reserved.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extraHeaders"],
        message: `extraHeaders cannot set reserved header names (${reserved.join(", ")}) — they are set automatically by the credential proxy.`,
      });
    }
  });

export type McpCreateInput = z.infer<typeof mcpCreateSchema>;

// Shared with the test-credentials route (api/integrations/test-credentials/
// route.ts) — the pre-save "Test connection" call the dialog makes before
// (and independently of) creating the connection. Same wire shape as
// mcpCreateSchema minus name/description, since nothing is persisted here.
export const mcpTestCredentialsSchema = z.object({
  type: z.literal("mcp"),
  transport: z.enum(["http", "sse"]),
  url: z.string().url(),
  token: z.string().min(1),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

export type McpTestCredentialsInput = z.infer<typeof mcpTestCredentialsSchema>;
