// Real-DB access test for the knowledge folder status and file list (#1386).
//
// Unlike the other knowledge routes these are open to MEMBERS, because "why
// doesn't the agent know about X?" is a member's question first. The mocked
// route tests stub the agent gate; this one runs the real `getAgentWithAccess`
// and the real status read, so it proves the two halves of the claim: a member
// who can chat with a shared agent reads it, and a member asking about another
// user's personal agent gets the same 404 as an id nobody issued.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(false),
  getLicenseState: vi.fn().mockResolvedValue("community"),
}));

vi.mock("@/lib/groups", () => ({
  getUserGroupIds: vi.fn().mockResolvedValue([]),
  getAgentGroupIds: vi.fn().mockResolvedValue([]),
  getAllAgentGroupIds: vi.fn().mockResolvedValue(new Map<string, string[]>()),
}));

import { db } from "@/db";
import { agents, kbChunks, kbDocuments, users } from "@/db/schema";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import { GET as FOLDERS_GET } from "@/app/api/agents/[agentId]/knowledge/folders/route";
import { GET as FILES_GET } from "@/app/api/agents/[agentId]/knowledge/files/route";

const UNKNOWN_AGENT_ID = "00000000-0000-4000-8000-000000000000";

async function seedUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      name,
      email: `user-${crypto.randomUUID()}@example.com`,
      emailVerified: true,
      role: "member",
    })
    .returning();
  return row;
}

async function seedAgent(values: Partial<typeof agents.$inferInsert>) {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Docs",
      model: "test-model",
      greetingMessage: "Hi",
      allowedTools: ["knowledge_search"],
      pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr"] } },
      ...values,
    })
    .returning();
  return row;
}

const params = (agentId: string) => ({ params: Promise.resolve({ agentId }) });
const folders = (agentId: string) =>
  FOLDERS_GET(
    new NextRequest(`http://localhost/api/agents/${agentId}/knowledge/folders`),
    params(agentId)
  );
const files = (agentId: string) =>
  FILES_GET(
    new NextRequest(`http://localhost/api/agents/${agentId}/knowledge/files?folder=/data/hr`),
    params(agentId)
  );

let member: Awaited<ReturnType<typeof seedUser>>;

beforeEach(async () => {
  member = await seedUser("Member");
  mockGetSession.mockResolvedValue({ user: { id: member.id, role: "member" } });
});

describe("knowledge folder routes (real DB)", () => {
  it("let a member read the folder status of a shared agent", async () => {
    const agent = await seedAgent({ visibility: "all" });
    const [doc] = await db
      .insert(kbDocuments)
      .values({ orgId: DEFAULT_ORG_ID, contentHash: "h-1", sourcePath: "/data/hr/policy.pdf" })
      .returning();
    await db.insert(kbChunks).values({
      documentId: doc.id,
      orgId: DEFAULT_ORG_ID,
      sourcePath: "/data/hr/policy.pdf",
      chunkText: "Text.",
      locator: { kind: "page", page: 1 },
    });

    const res = await folders(agent.id);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.folders).toEqual([
      expect.objectContaining({ path: "/data/hr", indexed: 1, searchable: 1 }),
    ]);
  });

  it("answer another user's personal agent exactly like an unknown id", async () => {
    const owner = await seedUser("Owner");
    const foreign = await seedAgent({
      isPersonal: true,
      visibility: "restricted",
      ownerId: owner.id,
    });

    for (const call of [folders, files]) {
      const denied = await call(foreign.id);
      const unknown = await call(UNKNOWN_AGENT_ID);
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual(await unknown.json());
    }
  });
});
