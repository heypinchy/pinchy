import { z } from "zod";
import { EMAIL_OPERATIONS } from "@/lib/tool-registry";

/**
 * MCP tool-name length cap for `model: "mcp"` permission rows, where
 * `operation` is the raw tool name reported by a third-party MCP server
 * (not a Pinchy-defined vocabulary like EMAIL_OPERATIONS). We deliberately
 * do NOT enforce the MCP tool-naming SEP's character set here — discovery
 * (mcp-client.ts `validateAndMapTools`) only requires a non-empty string, so
 * a real (if non-conformant) tool from a real server must still be grantable.
 * The length cap mirrors the SEP's own guidance ("tool names SHOULD be
 * between 1 and 128 characters") and exists purely as a sanity bound against
 * a hostile/misbehaving server: unbounded third-party strings would flow
 * into `tools.allow` (T6) and a per-connection skill body (T7).
 */
const MCP_TOOL_NAME_MAX_LENGTH = 128;

/**
 * Request schema for PUT /api/agents/[agentId]/integrations.
 *
 * `operation` is validated per-row: for model "email" it is restricted to
 * EMAIL_OPERATIONS (read/draft/send). Without this, pre-#328 legacy
 * per-tool operation strings ("search", "list") could be minted as NEW
 * agent_connection_permissions rows via this API — the runtime treats
 * "search"/"list" as an alias for "read" (see tool-registry.ts and the
 * pinchy-email plugin's permissions.ts), so a `{ model: "email", operation:
 * "search" }` row would silently grant a standing "read" toolset that (pre-
 * C2) the permissions UI didn't even render as checked, and the audit row
 * would log the raw legacy string instead of the effective operation.
 *
 * For model "mcp", `operation` is the tool name synced from a third-party
 * MCP server (see MCP_TOOL_NAME_MAX_LENGTH above) — length-capped only, no
 * fixed vocabulary. Whether the name is actually a tool the connection has
 * synced is checked in the route handler (agent-integrations route.ts),
 * not here, because that check needs the connection row's `data.tools`.
 *
 * Other models (e.g. Odoo's per-model operations like "create") are
 * validated only as a non-empty string — this route is generic across
 * integration types, and the operation vocabulary is model-specific.
 */
export const setAgentIntegrationsSchema = z.object({
  connectionId: z.string().min(1),
  permissions: z
    .array(z.object({ model: z.string().min(1), operation: z.string().min(1) }))
    .superRefine((permissions, ctx) => {
      permissions.forEach((perm, index) => {
        if (
          perm.model === "email" &&
          !EMAIL_OPERATIONS.includes(perm.operation as (typeof EMAIL_OPERATIONS)[number])
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid email operation "${perm.operation}". Allowed values: ${EMAIL_OPERATIONS.join(", ")}.`,
            path: [index, "operation"],
          });
        }
        if (perm.model === "mcp" && perm.operation.length > MCP_TOOL_NAME_MAX_LENGTH) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `MCP tool name is ${perm.operation.length} characters, exceeding the ${MCP_TOOL_NAME_MAX_LENGTH}-character limit.`,
            path: [index, "operation"],
          });
        }
      });
    }),
});

export type SetAgentIntegrationsInput = z.infer<typeof setAgentIntegrationsSchema>;
