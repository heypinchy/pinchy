# Smithers Onboarding Interview — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Smithers interviews new users to learn about them (and for admins, their organization), then saves the context via OpenClaw tools — replacing the empty Settings → Context fields that nobody would fill out manually.

**Architecture:** A new OpenClaw plugin (`pinchy-context`) provides `save_user_context` and `save_org_context` tools. Internal API endpoints handle persistence and sync. An `ONBOARDING.md` file in Smithers' workspace triggers the interview when user/org context is missing. Tools are assigned to Smithers at creation time based on the owner's role.

**Tech Stack:** OpenClaw plugin system, Next.js API routes, Drizzle ORM, Vitest, Docker Compose

---

## Batch 1: Plugin + Internal API

### Task 1: Create pinchy-context plugin scaffold

**Files:**
- Create: `packages/plugins/pinchy-context/package.json`
- Create: `packages/plugins/pinchy-context/tsconfig.json`
- Create: `packages/plugins/pinchy-context/openclaw.plugin.json`
- Create: `packages/plugins/pinchy-context/index.ts`
- Create: `packages/plugins/pinchy-context/index.test.ts`

**Step 1:** Create `packages/plugins/pinchy-context/package.json`:
```json
{
  "name": "@pinchy/pinchy-context",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^3.0.0",
    "typescript": "^5.7.0"
  }
}
```

**Step 2:** Create `packages/plugins/pinchy-context/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "outDir": "dist",
    "rootDir": ".",
    "esModuleInterop": true
  },
  "include": ["*.ts"],
  "exclude": ["*.test.ts"]
}
```

**Step 3:** Create `packages/plugins/pinchy-context/openclaw.plugin.json`:
```json
{
  "id": "pinchy-context",
  "name": "Pinchy Context",
  "description": "Allows agents to save user and organization context during onboarding.",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiBaseUrl": {
        "type": "string"
      },
      "gatewayToken": {
        "type": "string"
      },
      "agents": {
        "type": "object",
        "additionalProperties": {
          "type": "object",
          "properties": {
            "tools": {
              "type": "array",
              "items": { "type": "string" }
            },
            "userId": {
              "type": "string"
            }
          },
          "required": ["tools", "userId"]
        }
      }
    },
    "required": ["apiBaseUrl", "gatewayToken", "agents"]
  }
}
```

**Step 4:** Write tests in `packages/plugins/pinchy-context/index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRegisterTool = vi.fn();

function createMockApi(config: {
  apiBaseUrl: string;
  gatewayToken: string;
  agents: Record<string, { tools: string[]; userId: string }>;
}) {
  return {
    id: "pinchy-context",
    name: "Pinchy Context",
    source: "test",
    config: {},
    pluginConfig: config,
    runtime: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerTool: mockRegisterTool,
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    on: vi.fn(),
  };
}

const defaultConfig = {
  apiBaseUrl: "http://pinchy:7777",
  gatewayToken: "test-token-abc",
  agents: {
    "agent-1": { tools: ["save_user_context"], userId: "user-1" },
    "agent-2": {
      tools: ["save_user_context", "save_org_context"],
      userId: "admin-1",
    },
  },
};

describe("pinchy-context plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers save_user_context and save_org_context as tool factories", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    expect(mockRegisterTool).toHaveBeenCalledTimes(2);
  });

  it("save_user_context factory returns tool for configured agent", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_save_user_context"
    )?.[0];
    expect(factory).toBeDefined();

    const tool = factory({ agentId: "agent-1" });
    expect(tool).not.toBeNull();
    expect(tool.name).toBe("pinchy_save_user_context");
  });

  it("save_user_context factory returns null for unconfigured agent", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_save_user_context"
    )?.[0];

    const tool = factory({ agentId: "unknown-agent" });
    expect(tool).toBeNull();
  });

  it("save_org_context factory returns tool only when agent has that tool", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (call: any[]) => call[1]?.name === "pinchy_save_org_context"
    )?.[0];
    expect(factory).toBeDefined();

    // agent-2 has save_org_context
    const tool = factory({ agentId: "agent-2" });
    expect(tool).not.toBeNull();
    expect(tool.name).toBe("pinchy_save_org_context");

    // agent-1 does NOT have save_org_context
    const tool2 = factory({ agentId: "agent-1" });
    expect(tool2).toBeNull();
  });

  it("exports plugin definition with id and configSchema", async () => {
    const { default: plugin } = await import("./index");
    expect(plugin.id).toBe("pinchy-context");
    expect(plugin.name).toBe("Pinchy Context");
    expect(plugin.configSchema).toBeDefined();
  });
});
```

**Step 5:** Implement `packages/plugins/pinchy-context/index.ts`:

```typescript
import { unlinkSync } from "fs";
import { join } from "path";

interface PluginToolContext {
  agentId?: string;
}

interface AgentContextConfig {
  tools: string[];
  userId: string;
}

interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
  agents: Record<string, AgentContextConfig>;
}

interface PluginApi {
  pluginConfig?: PluginConfig;
  registerTool: (
    factory: (ctx: PluginToolContext) => AgentTool | null,
    opts?: { name?: string }
  ) => void;
}

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: unknown;
  }>;
}

function getAgentConfig(
  agents: Record<string, AgentContextConfig>,
  agentId: string
): AgentContextConfig | null {
  return agents[agentId] ?? null;
}

function deleteOnboardingFile(agentId: string): void {
  try {
    const workspacePath = `/root/.openclaw/workspaces/${agentId}`;
    unlinkSync(join(workspacePath, "ONBOARDING.md"));
  } catch {
    // File may not exist, that's fine
  }
}

const plugin = {
  id: "pinchy-context",
  name: "Pinchy Context",
  description:
    "Allows agents to save user and organization context during onboarding.",
  configSchema: {
    validate: (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "agents" in value &&
        "apiBaseUrl" in value &&
        "gatewayToken" in value
      ) {
        return { ok: true as const, value };
      }
      return {
        ok: false as const,
        errors: ["Missing required keys in config"],
      };
    },
  },

  register(api: PluginApi) {
    const config = api.pluginConfig;
    if (!config) return;

    const { apiBaseUrl, gatewayToken, agents: agentConfigs } = config;

    // save_user_context tool
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;

        const agentConfig = getAgentConfig(agentConfigs, agentId);
        if (!agentConfig || !agentConfig.tools.includes("save_user_context"))
          return null;

        return {
          name: "pinchy_save_user_context",
          label: "Save User Context",
          description:
            "Save a structured summary of the user's personal context (name, role, preferences, work style). Use this after learning enough about the user through conversation.",
          parameters: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description:
                  "Markdown-formatted summary of the user's context",
              },
            },
            required: ["content"],
          },
          async execute(
            _toolCallId: string,
            params: Record<string, unknown>
          ) {
            try {
              const content = params.content as string;
              const res = await fetch(
                `${apiBaseUrl}/api/internal/users/${agentConfig.userId}/context`,
                {
                  method: "PUT",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${gatewayToken}`,
                  },
                  body: JSON.stringify({ content }),
                }
              );

              if (!res.ok) {
                const data = await res.json();
                return {
                  content: [
                    {
                      type: "text",
                      text: `Failed to save: ${data.error || "Unknown error"}`,
                    },
                  ],
                };
              }

              const data = await res.json();

              if (data.onboardingComplete) {
                deleteOnboardingFile(agentId);
              }

              return {
                content: [
                  {
                    type: "text",
                    text: data.onboardingComplete
                      ? "User context saved. Onboarding complete."
                      : "User context saved. Now ask about the organization.",
                  },
                ],
              };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Unknown error";
              return { content: [{ type: "text", text: message }] };
            }
          },
        };
      },
      { name: "pinchy_save_user_context" }
    ),
      // save_org_context tool
      api.registerTool(
        (ctx: PluginToolContext) => {
          const agentId = ctx.agentId;
          if (!agentId) return null;

          const agentConfig = getAgentConfig(agentConfigs, agentId);
          if (!agentConfig || !agentConfig.tools.includes("save_org_context"))
            return null;

          return {
            name: "pinchy_save_org_context",
            label: "Save Organization Context",
            description:
              "Save a structured summary of the organization's context (company name, team structure, conventions, domain knowledge). Use this after learning enough about the organization.",
            parameters: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  description:
                    "Markdown-formatted summary of the organization context",
                },
              },
              required: ["content"],
            },
            async execute(
              _toolCallId: string,
              params: Record<string, unknown>
            ) {
              try {
                const content = params.content as string;
                const res = await fetch(
                  `${apiBaseUrl}/api/internal/settings/context`,
                  {
                    method: "PUT",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${gatewayToken}`,
                    },
                    body: JSON.stringify({ content }),
                  }
                );

                if (!res.ok) {
                  const data = await res.json();
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Failed to save: ${data.error || "Unknown error"}`,
                      },
                    ],
                  };
                }

                const data = await res.json();

                if (data.onboardingComplete) {
                  deleteOnboardingFile(agentId);
                }

                return {
                  content: [
                    {
                      type: "text",
                      text: "Organization context saved. Onboarding complete.",
                    },
                  ],
                };
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : "Unknown error";
                return { content: [{ type: "text", text: message }] };
              }
            },
          };
        },
        { name: "pinchy_save_org_context" }
      );
  },
};

export default plugin;
```

**Step 6:** Install dependencies and run tests:
```bash
cd packages/plugins/pinchy-context && pnpm install && pnpm test
```

**Step 7:** Commit: `feat: add pinchy-context plugin with save_user_context and save_org_context tools`

---

### Task 2: Create internal API for Gateway-Token auth

These are internal endpoints called by the OpenClaw plugin, authenticated with the Gateway-Token instead of browser cookies.

**Files:**
- Create: `packages/web/src/lib/gateway-auth.ts`
- Test: `packages/web/src/__tests__/lib/gateway-auth.test.ts`
- Create: `packages/web/src/app/api/internal/users/[userId]/context/route.ts`
- Test: `packages/web/src/__tests__/api/internal-user-context.test.ts`
- Create: `packages/web/src/app/api/internal/settings/context/route.ts`
- Test: `packages/web/src/__tests__/api/internal-settings-context.test.ts`

**Step 1:** Write tests for `gateway-auth.ts` in `packages/web/src/__tests__/lib/gateway-auth.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: { ...actual, readFileSync: vi.fn() },
    readFileSync: vi.fn(),
  };
});

import { readFileSync } from "fs";

describe("validateGatewayToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when Authorization header matches gateway token", async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ gateway: { auth: { token: "secret-token-123" } } })
    );

    const { validateGatewayToken } = await import("@/lib/gateway-auth");

    const headers = new Headers({ Authorization: "Bearer secret-token-123" });
    expect(validateGatewayToken(headers)).toBe(true);
  });

  it("returns false when token does not match", async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ gateway: { auth: { token: "secret-token-123" } } })
    );

    const { validateGatewayToken } = await import("@/lib/gateway-auth");

    const headers = new Headers({ Authorization: "Bearer wrong-token" });
    expect(validateGatewayToken(headers)).toBe(false);
  });

  it("returns false when Authorization header is missing", async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ gateway: { auth: { token: "secret-token-123" } } })
    );

    const { validateGatewayToken } = await import("@/lib/gateway-auth");

    const headers = new Headers();
    expect(validateGatewayToken(headers)).toBe(false);
  });

  it("returns false when config file cannot be read", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { validateGatewayToken } = await import("@/lib/gateway-auth");

    const headers = new Headers({ Authorization: "Bearer some-token" });
    expect(validateGatewayToken(headers)).toBe(false);
  });
});
```

**Step 2:** Implement `packages/web/src/lib/gateway-auth.ts`:

```typescript
import { readFileSync } from "fs";

const CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";

function readGatewayToken(): string | null {
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return config?.gateway?.auth?.token ?? null;
  } catch {
    return null;
  }
}

export function validateGatewayToken(headers: Headers): boolean {
  const authHeader = headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const token = authHeader.slice(7);
  const gatewayToken = readGatewayToken();
  if (!gatewayToken) return false;

  return token === gatewayToken;
}
```

**Step 3:** Write tests for internal user context API in `packages/web/src/__tests__/api/internal-user-context.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn().mockReturnValue(true),
}));

vi.mock("@/db", () => ({
  db: {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({ id: "user-1", role: "user", context: null }),
      },
    },
  },
}));

vi.mock("@/lib/context-sync", () => ({
  syncUserContextToWorkspaces: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

import { validateGatewayToken } from "@/lib/gateway-auth";
import { syncUserContextToWorkspaces } from "@/lib/context-sync";
import { restartState } from "@/server/restart-state";
import { db } from "@/db";
import { PUT } from "@/app/api/internal/users/[userId]/context/route";

function makePutRequest(userId: string, body: Record<string, unknown>) {
  return new NextRequest(
    `http://localhost/api/internal/users/${userId}/context`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify(body),
    }
  );
}

function makeParams(userId: string) {
  return { params: Promise.resolve({ userId }) };
}

describe("PUT /api/internal/users/:userId/context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateGatewayToken).mockReturnValue(true);
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "user-1",
      role: "user",
      context: null,
    } as any);
  });

  it("returns 401 when gateway token is invalid", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(false);

    const res = await PUT(makePutRequest("user-1", { content: "test" }), makeParams("user-1"));
    expect(res.status).toBe(401);
  });

  it("saves user context and triggers sync", async () => {
    const res = await PUT(
      makePutRequest("user-1", { content: "# My Context" }),
      makeParams("user-1")
    );

    expect(res.status).toBe(200);
    expect(syncUserContextToWorkspaces).toHaveBeenCalledWith("user-1");
    expect(restartState.notifyRestart).toHaveBeenCalled();
  });

  it("returns onboardingComplete: true for non-admin users", async () => {
    const res = await PUT(
      makePutRequest("user-1", { content: "# My Context" }),
      makeParams("user-1")
    );

    const data = await res.json();
    expect(data.onboardingComplete).toBe(true);
  });

  it("returns onboardingComplete: false for admin when org_context is not set", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "admin-1",
      role: "admin",
      context: null,
    } as any);

    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(null);

    const res = await PUT(
      makePutRequest("admin-1", { content: "# Admin Context" }),
      makeParams("admin-1")
    );

    const data = await res.json();
    expect(data.onboardingComplete).toBe(false);
  });

  it("returns onboardingComplete: true for admin when org_context is already set", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "admin-1",
      role: "admin",
      context: null,
    } as any);

    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue("Some org context");

    const res = await PUT(
      makePutRequest("admin-1", { content: "# Admin Context" }),
      makeParams("admin-1")
    );

    const data = await res.json();
    expect(data.onboardingComplete).toBe(true);
  });

  it("returns 400 when content is not a string", async () => {
    const res = await PUT(
      makePutRequest("user-1", { content: 123 }),
      makeParams("user-1")
    );
    expect(res.status).toBe(400);
  });
});
```

**Step 4:** Implement `packages/web/src/app/api/internal/users/[userId]/context/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { syncUserContextToWorkspaces } from "@/lib/context-sync";
import { getSetting } from "@/lib/settings";
import { restartState } from "@/server/restart-state";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { userId } = await params;
  const { content } = await request.json();

  if (typeof content !== "string") {
    return NextResponse.json(
      { error: "content must be a string" },
      { status: 400 }
    );
  }

  await db.update(users).set({ context: content }).where(eq(users.id, userId));
  await syncUserContextToWorkspaces(userId);
  restartState.notifyRestart();

  // Determine if onboarding is complete
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  let onboardingComplete = true;
  if (user?.role === "admin") {
    const orgContext = await getSetting("org_context");
    onboardingComplete = orgContext !== null;
  }

  return NextResponse.json({ success: true, onboardingComplete });
}
```

**Step 5:** Write tests for internal org context API in `packages/web/src/__tests__/api/internal-settings-context.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/settings", () => ({
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/context-sync", () => ({
  syncOrgContextToWorkspaces: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

import { validateGatewayToken } from "@/lib/gateway-auth";
import { setSetting } from "@/lib/settings";
import { syncOrgContextToWorkspaces } from "@/lib/context-sync";
import { restartState } from "@/server/restart-state";
import { PUT } from "@/app/api/internal/settings/context/route";

function makePutRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/internal/settings/context", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
    body: JSON.stringify(body),
  });
}

describe("PUT /api/internal/settings/context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateGatewayToken).mockReturnValue(true);
  });

  it("returns 401 when gateway token is invalid", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(false);

    const res = await PUT(makePutRequest({ content: "test" }));
    expect(res.status).toBe(401);
  });

  it("saves org context and triggers sync", async () => {
    const res = await PUT(makePutRequest({ content: "# Org Info" }));

    expect(res.status).toBe(200);
    expect(setSetting).toHaveBeenCalledWith("org_context", "# Org Info");
    expect(syncOrgContextToWorkspaces).toHaveBeenCalled();
    expect(restartState.notifyRestart).toHaveBeenCalled();
  });

  it("returns onboardingComplete: true", async () => {
    const res = await PUT(makePutRequest({ content: "# Org Info" }));

    const data = await res.json();
    expect(data.onboardingComplete).toBe(true);
  });

  it("returns 400 when content is not a string", async () => {
    const res = await PUT(makePutRequest({ content: 42 }));
    expect(res.status).toBe(400);
  });
});
```

**Step 6:** Implement `packages/web/src/app/api/internal/settings/context/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { setSetting } from "@/lib/settings";
import { syncOrgContextToWorkspaces } from "@/lib/context-sync";
import { restartState } from "@/server/restart-state";

export async function PUT(request: NextRequest) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { content } = await request.json();

  if (typeof content !== "string") {
    return NextResponse.json(
      { error: "content must be a string" },
      { status: 400 }
    );
  }

  await setSetting("org_context", content);
  await syncOrgContextToWorkspaces();
  restartState.notifyRestart();

  return NextResponse.json({ success: true, onboardingComplete: true });
}
```

**Step 7:** Run all tests:
```bash
cd packages/web && pnpm test
cd packages/plugins/pinchy-context && pnpm test
```

**Step 8:** Commit: `feat: add internal API endpoints for plugin-based context saving`

---

### Task 3: Register context tools in tool-registry + config generation

**Files:**
- Modify: `packages/web/src/lib/tool-registry.ts`
- Modify: `packages/web/src/lib/openclaw-config.ts`
- Test: `packages/web/src/__tests__/lib/openclaw-config.test.ts`

**Step 1:** Add context tools to `tool-registry.ts`. Add after the existing safe tools (after line 25):

```typescript
  // Context tools — agent saves user/org context via plugin
  {
    id: "pinchy_save_user_context",
    label: "Save user context",
    description: "Save personal context about the user",
    category: "safe",
  },
  {
    id: "pinchy_save_org_context",
    label: "Save organization context",
    description: "Save context about the organization",
    category: "safe",
  },
```

**Step 2:** Modify `regenerateOpenClawConfig()` in `openclaw-config.ts` to build the `pinchy-context` plugin config. The existing code at lines 136-143 collects plugin configs for agents with `pinchy_` tools. We need to also collect context tool configs separately.

In `regenerateOpenClawConfig()`, after the existing `pluginConfigs` collection (line 143), add context plugin config collection. Replace the plugin config collection block (lines 136-143) with:

```typescript
    // Collect plugin config for agents that have safe file tools (pinchy_ls, pinchy_read)
    const hasFileTools = allowedTools.some((t: string) =>
      t === "pinchy_ls" || t === "pinchy_read"
    );
    if (hasFileTools && agent.pluginConfig) {
      if (!pluginConfigs["pinchy-files"]) {
        pluginConfigs["pinchy-files"] = {};
      }
      pluginConfigs["pinchy-files"][agent.id] = agent.pluginConfig as Record<string, unknown>;
    }

    // Collect plugin config for agents that have context tools (pinchy_save_*)
    const contextTools = allowedTools.filter((t: string) =>
      t.startsWith("pinchy_save_")
    );
    if (contextTools.length > 0 && agent.ownerId) {
      if (!contextPluginAgents) {
        contextPluginAgents = {};
      }
      contextPluginAgents[agent.id] = {
        tools: contextTools.map((t: string) => t.replace("pinchy_", "")),
        userId: agent.ownerId,
      };
    }
```

Before the loop (after line 119), declare:
```typescript
  let contextPluginAgents: Record<string, { tools: string[]; userId: string }> | undefined;
```

After the plugin config assembly (around line 168), add the context plugin:
```typescript
  if (contextPluginAgents) {
    // Read gateway token from existing config
    const gatewayAuth = (gateway as Record<string, unknown>).auth as Record<string, unknown> | undefined;
    const gatewayToken = (gatewayAuth?.token as string) || "";

    if (!config.plugins) config.plugins = { entries: {} };
    const entries = (config.plugins as Record<string, unknown>).entries as Record<string, unknown>;
    entries["pinchy-context"] = {
      enabled: true,
      config: {
        apiBaseUrl: process.env.PINCHY_INTERNAL_URL || "http://pinchy:7777",
        gatewayToken,
        agents: contextPluginAgents,
      },
    };
  }
```

**Step 3:** Add test to `__tests__/lib/openclaw-config.test.ts` for context plugin config:

```typescript
  it("should include pinchy-context plugin config for agents with context tools", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "smithers-1",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-20250514",
          pluginConfig: null,
          allowedTools: ["pinchy_save_user_context"],
          ownerId: "user-1",
          isPersonal: true,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-context"]).toBeDefined();
    expect(config.plugins.entries["pinchy-context"].enabled).toBe(true);
    expect(config.plugins.entries["pinchy-context"].config.apiBaseUrl).toBe("http://pinchy:7777");
    expect(config.plugins.entries["pinchy-context"].config.gatewayToken).toBe("gw-token-123");
    expect(config.plugins.entries["pinchy-context"].config.agents["smithers-1"]).toEqual({
      tools: ["save_user_context"],
      userId: "user-1",
    });
  });

  it("should include both pinchy-files and pinchy-context when agents use both", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "smithers-1",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-20250514",
          pluginConfig: null,
          allowedTools: ["pinchy_save_user_context"],
          ownerId: "user-1",
          isPersonal: true,
          createdAt: new Date(),
        },
        {
          id: "kb-agent",
          name: "KB Agent",
          model: "anthropic/claude-sonnet-4-20250514",
          pluginConfig: { allowed_paths: ["/data/docs/"] },
          allowedTools: ["pinchy_ls", "pinchy_read"],
          ownerId: null,
          isPersonal: false,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-files"]).toBeDefined();
    expect(config.plugins.entries["pinchy-context"]).toBeDefined();
  });
```

**Step 4:** Run tests: `cd packages/web && pnpm test`

**Step 5:** Commit: `feat: register context tools and generate pinchy-context plugin config`

---

## Batch 2: Smithers Setup + ONBOARDING.md

### Task 4: Create onboarding prompt content

**Files:**
- Create: `packages/web/src/lib/onboarding-prompt.ts`
- Test: `packages/web/src/__tests__/lib/onboarding-prompt.test.ts`

**Step 1:** Write tests in `packages/web/src/__tests__/lib/onboarding-prompt.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getOnboardingPrompt } from "@/lib/onboarding-prompt";

describe("getOnboardingPrompt", () => {
  it("returns user-only prompt for non-admin", () => {
    const prompt = getOnboardingPrompt(false);

    expect(prompt).toContain("save_user_context");
    expect(prompt).not.toContain("save_org_context");
    expect(prompt).not.toContain("organization");
  });

  it("returns user + org prompt for admin", () => {
    const prompt = getOnboardingPrompt(true);

    expect(prompt).toContain("save_user_context");
    expect(prompt).toContain("save_org_context");
    expect(prompt).toContain("organization");
  });
});
```

**Step 2:** Implement `packages/web/src/lib/onboarding-prompt.ts`:

```typescript
const USER_ONBOARDING = `## Onboarding

The user hasn't shared any context about themselves yet. Your job is to
get to know them through natural conversation.

Find out: their name, their role, what they work on, how they prefer to
communicate, and anything else that helps you be a better assistant.

Be conversational, not robotic. Don't fire off a list of questions —
weave them into the conversation naturally. If the user wants to talk
about something else first, help them with it — but always steer back to
learning about them when there's a natural opening. Be persistent but
not annoying.

Once you have their name, role, and at least 2-3 other useful details,
use the save_user_context tool to save a structured summary in Markdown.`;

const ORG_ONBOARDING = `

After saving the user's personal context, learn about their organization:
company name, what they do, team structure, domain-specific terminology,
conventions. Again, be conversational — don't interrogate. Once you have
enough, use the save_org_context tool to save an organization summary in Markdown.`;

export function getOnboardingPrompt(isAdmin: boolean): string {
  return isAdmin ? USER_ONBOARDING + ORG_ONBOARDING : USER_ONBOARDING;
}
```

**Step 3:** Run tests: `cd packages/web && npx vitest run src/__tests__/lib/onboarding-prompt.test.ts`

**Step 4:** Commit: `feat: add onboarding prompt content for user and admin`

---

### Task 5: Wire onboarding into Smithers creation

Smithers gets `allowedTools` and `ONBOARDING.md` when user context is null.

**Files:**
- Modify: `packages/web/src/lib/personal-agent.ts`
- Test: `packages/web/src/__tests__/lib/personal-agent.test.ts`

**Step 1:** Add mock for `onboarding-prompt` to the test file (after the existing mocks):

```typescript
vi.mock("@/lib/onboarding-prompt", () => ({
  getOnboardingPrompt: vi.fn().mockReturnValue("## Onboarding\n\nTest onboarding content"),
}));
```

Add import:
```typescript
import { getOnboardingPrompt } from "@/lib/onboarding-prompt";
```

**Step 2:** Add tests to `personal-agent.test.ts`:

```typescript
  it("sets allowedTools with save_user_context for non-admin user", async () => {
    getContextForAgentMock.mockResolvedValueOnce("");
    const fakeAgent = {
      id: "agent-tools-1",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { createSmithersAgent } = await import("@/lib/personal-agent");
    await createSmithersAgent({
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      isAdmin: false,
    });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: ["pinchy_save_user_context"],
      })
    );
  });

  it("sets allowedTools with both context tools for admin user", async () => {
    getContextForAgentMock.mockResolvedValueOnce("");
    const fakeAgent = {
      id: "agent-tools-2",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "admin-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { createSmithersAgent } = await import("@/lib/personal-agent");
    await createSmithersAgent({
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "admin-1",
      isPersonal: true,
      isAdmin: true,
    });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: ["pinchy_save_user_context", "pinchy_save_org_context"],
      })
    );
  });

  it("writes ONBOARDING.md to workspace", async () => {
    getContextForAgentMock.mockResolvedValueOnce("");
    const fakeAgent = {
      id: "agent-onboard-1",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    returningMock.mockResolvedValue([fakeAgent]);

    const { createSmithersAgent } = await import("@/lib/personal-agent");
    await createSmithersAgent({
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      isAdmin: false,
    });

    expect(writeWorkspaceFileInternal).toHaveBeenCalledWith(
      "agent-onboard-1",
      "ONBOARDING.md",
      expect.stringContaining("Onboarding")
    );
  });
```

**Step 3:** Modify `personal-agent.ts`:

Add import:
```typescript
import { getOnboardingPrompt } from "@/lib/onboarding-prompt";
```

Update `CreateSmithersOptions` interface:
```typescript
interface CreateSmithersOptions {
  model: string;
  ownerId: string | null;
  isPersonal: boolean;
  isAdmin?: boolean;
}
```

Update `createSmithersAgent` to accept `isAdmin` and set tools + onboarding:
```typescript
export async function createSmithersAgent({
  model,
  ownerId,
  isPersonal,
  isAdmin = false,
}: CreateSmithersOptions) {
  const preset = PERSONALITY_PRESETS["the-butler"];

  const allowedTools = isAdmin
    ? ["pinchy_save_user_context", "pinchy_save_org_context"]
    : ["pinchy_save_user_context"];

  const [agent] = await db
    .insert(agents)
    .values({
      name: "Smithers",
      model,
      ownerId,
      isPersonal,
      tagline: "Your reliable personal assistant",
      avatarSeed: "__smithers__",
      personalityPresetId: "the-butler",
      greetingMessage: resolveGreetingMessage(preset.greetingMessage, "Smithers"),
      allowedTools,
    })
    .returning();

  ensureWorkspace(agent.id);
  writeWorkspaceFile(agent.id, "SOUL.md", SMITHERS_SOUL_MD);
  writeIdentityFile(agent.id, { name: agent.name, tagline: agent.tagline });

  const context = await getContextForAgent({
    isPersonal: agent.isPersonal,
    ownerId: agent.ownerId,
  });
  writeWorkspaceFileInternal(agent.id, "USER.md", context);

  // Write onboarding prompt if user has no context yet
  if (!context) {
    writeWorkspaceFileInternal(
      agent.id,
      "ONBOARDING.md",
      getOnboardingPrompt(isAdmin)
    );
  }

  return agent;
}
```

**Step 4:** Update callers of `createSmithersAgent` to pass `isAdmin`:
- In `seedPersonalAgent()` — needs to know if user is admin. Add `isAdmin` parameter:

```typescript
export async function seedPersonalAgent(userId: string, isAdmin = false) {
  const defaultProvider = (await getSetting("default_provider")) as ProviderName | null;
  const model = defaultProvider
    ? PROVIDERS[defaultProvider].defaultModel
    : "anthropic/claude-sonnet-4-20250514";

  return createSmithersAgent({ model, ownerId: userId, isPersonal: true, isAdmin });
}
```

- Find all callers of `seedPersonalAgent` and pass the role info. These are:
  - `src/app/api/setup/route.ts` — first admin setup, pass `isAdmin: true`
  - `src/app/api/invite/claim/route.ts` — invited users, pass `isAdmin: role === "admin"`

**Step 5:** Run tests: `cd packages/web && pnpm test`

**Step 6:** Commit: `feat: assign context tools and onboarding prompt to Smithers`

---

### Task 6: Mount pinchy-context plugin in Docker

**Files:**
- Modify: `docker-compose.dev.yml`

**Step 1:** Add the plugin volume mount for the openclaw service. In `docker-compose.dev.yml`, add under `openclaw.volumes`:

```yaml
      - ./packages/plugins/pinchy-context:/root/.openclaw/extensions/pinchy-context
```

**Step 2:** Rebuild and restart:
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d
```

**Step 3:** Commit: `feat: mount pinchy-context plugin in Docker dev environment`

---

## Batch 3: Migration for Existing Users + Verification

### Task 7: Migrate existing Smithers agents

Existing Smithers agents need `allowedTools` set and `ONBOARDING.md` written to their workspaces.

**Files:**
- Create: `packages/web/src/lib/migrate-onboarding.ts`
- Test: `packages/web/src/__tests__/lib/migrate-onboarding.test.ts`

**Step 1:** Write tests:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => ({
  db: {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    query: {
      agents: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      users: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
  },
}));

vi.mock("@/lib/workspace", () => ({
  writeWorkspaceFileInternal: vi.fn(),
}));

vi.mock("@/lib/onboarding-prompt", () => ({
  getOnboardingPrompt: vi.fn().mockReturnValue("## Onboarding\n\nTest"),
}));

import { db } from "@/db";
import { writeWorkspaceFileInternal } from "@/lib/workspace";

describe("migrateExistingSmithers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets allowedTools and writes ONBOARDING.md for Smithers with null context", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "smithers-1", ownerId: "user-1", isPersonal: true, allowedTools: [] },
    ] as any);
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "user-1",
      role: "user",
      context: null,
    } as any);

    const { migrateExistingSmithers } = await import("@/lib/migrate-onboarding");
    await migrateExistingSmithers();

    expect(writeWorkspaceFileInternal).toHaveBeenCalledWith(
      "smithers-1",
      "ONBOARDING.md",
      expect.any(String)
    );
  });

  it("skips Smithers where user already has context", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "smithers-2", ownerId: "user-2", isPersonal: true, allowedTools: [] },
    ] as any);
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "user-2",
      role: "user",
      context: "I am a developer",
    } as any);

    const { migrateExistingSmithers } = await import("@/lib/migrate-onboarding");
    await migrateExistingSmithers();

    expect(writeWorkspaceFileInternal).not.toHaveBeenCalled();
  });
});
```

**Step 2:** Implement `packages/web/src/lib/migrate-onboarding.ts`:

```typescript
import { db } from "@/db";
import { agents, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { writeWorkspaceFileInternal } from "@/lib/workspace";
import { getOnboardingPrompt } from "@/lib/onboarding-prompt";

export async function migrateExistingSmithers(): Promise<void> {
  const personalAgents = await db.query.agents.findMany({
    where: eq(agents.isPersonal, true),
  });

  for (const agent of personalAgents) {
    if (!agent.ownerId) continue;

    const user = await db.query.users.findFirst({
      where: eq(users.id, agent.ownerId),
    });

    if (!user || user.context !== null) continue;

    const isAdmin = user.role === "admin";
    const allowedTools = isAdmin
      ? ["pinchy_save_user_context", "pinchy_save_org_context"]
      : ["pinchy_save_user_context"];

    await db
      .update(agents)
      .set({ allowedTools })
      .where(eq(agents.id, agent.id));

    writeWorkspaceFileInternal(
      agent.id,
      "ONBOARDING.md",
      getOnboardingPrompt(isAdmin)
    );
  }
}
```

**Step 3:** Call `migrateExistingSmithers()` at startup. Add to `packages/web/server.ts` or create a Drizzle migration script. The simplest approach is to call it once during the first config regeneration. Add to the end of `regenerateOpenClawConfig()` or call it from a startup hook.

Alternatively, create a one-time migration by adding a call in `server-preload.cjs` or as part of the `pnpm db:migrate` step. The pragmatic approach: call it at the end of `regenerateOpenClawConfig()` — it's idempotent (skips agents that already have tools or context).

**Step 4:** Run tests: `cd packages/web && pnpm test`

**Step 5:** Commit: `feat: migrate existing Smithers agents for onboarding`

---

### Task 8: Update Smithers platform knowledge

**Files:**
- Modify: `packages/web/src/lib/smithers-soul.ts`

**Step 1:** Add onboarding awareness to the Platform Knowledge section. After the "### Context" section, add:

```markdown
### Onboarding
- When you first meet a user, you'll have onboarding instructions that ask you
  to learn about them through conversation
- Be persistent about getting to know the user, but don't block them from doing
  other things — help first, then steer back
- Once you've saved their context, the onboarding instructions go away and you
  have their info for all future conversations
```

**Step 2:** Run tests: `cd packages/web && npx vitest run src/__tests__/lib/smithers-soul.test.ts`

**Step 3:** Commit: `feat: update Smithers platform knowledge for onboarding`

---

### Task 9: Full verification

**Step 1:** Run all tests: `pnpm test`
**Step 2:** Run plugin tests: `cd packages/plugins/pinchy-context && pnpm test`
**Step 3:** Build: `pnpm build`
**Step 4:** Lint: `pnpm lint && pnpm format:check`
**Step 5:** Rebuild Docker and test manually:
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d
```

---

## Key Files

| File | Change |
|------|--------|
| `packages/plugins/pinchy-context/` | NEW: Plugin with save_user_context and save_org_context tools |
| `packages/web/src/lib/gateway-auth.ts` | NEW: Gateway-Token validation for internal API auth |
| `packages/web/src/app/api/internal/users/[userId]/context/route.ts` | NEW: Internal user context endpoint |
| `packages/web/src/app/api/internal/settings/context/route.ts` | NEW: Internal org context endpoint |
| `packages/web/src/lib/onboarding-prompt.ts` | NEW: Onboarding prompt content |
| `packages/web/src/lib/migrate-onboarding.ts` | NEW: Migration for existing Smithers agents |
| `packages/web/src/lib/tool-registry.ts` | Add pinchy_save_user_context and pinchy_save_org_context |
| `packages/web/src/lib/openclaw-config.ts` | Generate pinchy-context plugin config |
| `packages/web/src/lib/personal-agent.ts` | Set allowedTools + write ONBOARDING.md on Smithers creation |
| `packages/web/src/lib/smithers-soul.ts` | Add onboarding to platform knowledge |
| `docker-compose.dev.yml` | Mount pinchy-context plugin |
