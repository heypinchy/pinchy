import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq, or, and } from "drizzle-orm";
import { getTemplate } from "@/lib/agent-templates";
import { validateAllowedPaths } from "@/lib/path-validation";
import { ensureWorkspace, writeWorkspaceFile } from "@/lib/workspace";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { getSetting } from "@/lib/settings";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { appendAuditLog } from "@/lib/audit";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = session.user.role === "admin";

  if (isAdmin) {
    const allAgents = await db.select().from(agents);
    return NextResponse.json(allAgents);
  }

  // Non-admins see shared agents + their own personal agents
  const visibleAgents = await db
    .select()
    .from(agents)
    .where(
      or(
        eq(agents.isPersonal, false),
        and(eq(agents.isPersonal, true), eq(agents.ownerId, session.user.id!))
      )
    );
  return NextResponse.json(visibleAgents);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json();
  const { name, templateId, pluginConfig } = body;

  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  if (!templateId || typeof templateId !== "string") {
    return NextResponse.json({ error: "Template is required" }, { status: 400 });
  }

  const template = getTemplate(templateId);
  if (!template) {
    return NextResponse.json({ error: `Unknown template: ${templateId}` }, { status: 400 });
  }

  // Templates with pluginId require directory selection
  if (template.pluginId) {
    const paths = pluginConfig?.allowed_paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      return NextResponse.json(
        { error: "At least one directory must be selected" },
        { status: 400 }
      );
    }
    try {
      validateAllowedPaths(paths);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid paths";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  // Determine default model from current provider
  const defaultProvider = (await getSetting("default_provider")) as ProviderName | null;
  const model = defaultProvider
    ? PROVIDERS[defaultProvider].defaultModel
    : "anthropic/claude-haiku-4-5-20251001";

  const [agent] = await db
    .insert(agents)
    .values({
      name,
      model,
      templateId,
      pluginConfig: template.pluginId && pluginConfig ? pluginConfig : null,
      ownerId: session.user.id,
      allowedTools: template.allowedTools,
      greetingMessage: template.defaultGreeting,
    })
    .returning();

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "agent.created",
    resource: `agent:${agent.id}`,
    detail: { name: agent.name, model: agent.model, templateId },
  }).catch(() => {});

  // Create workspace with template's default SOUL.md
  ensureWorkspace(agent.id);
  writeWorkspaceFile(agent.id, "SOUL.md", template.defaultSoulMd);

  await regenerateOpenClawConfig();

  revalidatePath("/", "layout");

  return NextResponse.json(agent, { status: 201 });
}
