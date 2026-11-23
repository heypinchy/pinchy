// A soft-deleted agent's leftovers must stop running and stop being actionable:
// deleteAgent switches off its email workflows and expires its pending
// confirmations. Real DB; only the side effects outside the database (workspace
// files, runtime config, Telegram) are stubbed.
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/workspace", () => ({ deleteWorkspace: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/telegram-allow-store", () => ({
  recalculateTelegramAllowStores: vi.fn().mockResolvedValue(undefined),
}));

import { db } from "@/db";
import { agents, emailWorkflows, toolApproval, users } from "@/db/schema";
import { deleteAgent } from "@/lib/agents";

async function seedAgent(name: string) {
  const [row] = await db
    .insert(agents)
    .values({ name, model: "ollama-cloud/gemini-3-flash", greetingMessage: "Hi" })
    .returning();
  return row;
}

async function seedWorkflow(agentId: string) {
  const [row] = await db
    .insert(emailWorkflows)
    .values({
      agentId,
      name: "File invoices",
      filter: { hasAttachment: true },
      action: "Draft a bill.",
      enabled: true,
    })
    .returning();
  return row;
}

async function seedPendingApproval(agentId: string, requesterId: string) {
  const [row] = await db
    .insert(toolApproval)
    .values({
      agentId,
      requesterId,
      sessionKey: `agent:${agentId}:direct:${requesterId}`,
      toolName: "odoo_write",
      argsDigest: "digest",
      argsSummary: { summary: "x" } as never,
      status: "pending",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning();
  return row;
}

describe("deleteAgent — leftovers of the agent", () => {
  it("switches off the agent's email workflows and leaves other agents' alone", async () => {
    const gone = await seedAgent("Gone");
    const kept = await seedAgent("Kept");
    const goneWf = await seedWorkflow(gone.id);
    const keptWf = await seedWorkflow(kept.id);

    await deleteAgent(gone.id);

    const [after] = await db.select().from(emailWorkflows).where(eq(emailWorkflows.id, goneWf.id));
    const [other] = await db.select().from(emailWorkflows).where(eq(emailWorkflows.id, keptWf.id));
    expect(after.enabled).toBe(false);
    expect(other.enabled).toBe(true);
  });

  it("expires the agent's pending confirmations and leaves other agents' alone", async () => {
    const [user] = await db
      .insert(users)
      .values({ name: "U", email: "cleanup@test.local", emailVerified: true, role: "member" })
      .returning();
    const gone = await seedAgent("Gone");
    const kept = await seedAgent("Kept");
    const goneApproval = await seedPendingApproval(gone.id, user.id);
    const keptApproval = await seedPendingApproval(kept.id, user.id);

    await deleteAgent(gone.id);

    const [a] = await db.select().from(toolApproval).where(eq(toolApproval.id, goneApproval.id));
    const [b] = await db.select().from(toolApproval).where(eq(toolApproval.id, keptApproval.id));
    expect(a.status).toBe("expired");
    expect(a.argsSummary).toBeNull();
    expect(b.status).toBe("pending");
  });
});
