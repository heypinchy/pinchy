/**
 * The upgrade case: new code, pre-existing data.
 *
 * `PATCH /api/agents/[id]` accepted `pluginConfig` from any member who owns
 * the agent — and every user is seeded a personal agent they own — while
 * `pinchy-files.allowed_paths` inside it is the allowlist this route reads
 * files against. `pluginConfigSchema` confines that field now, but a schema
 * runs on WRITE. Rows already in the database were never checked, and the
 * install that fixes the hole is precisely an install that may be carrying
 * one, so the reader has to hold the line on its own.
 *
 * Deliberately a separate file from `agent-workspace-file.test.ts`: that one
 * moves `FILE_SERVE_ROOTS` to a temp directory so its fixtures can live on
 * disk. These cases are about the REAL ceiling, so nothing here is mocked
 * away, and the paths probed are the ones the exploit actually reached — the
 * secrets a `docker-compose.yml` volume puts inside this container.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({ getSession: (...args: unknown[]) => mockGetSession(...args) }));

const mockGetAgentWithAccess = vi.fn();
vi.mock("@/lib/agent-access", () => ({
  getAgentWithAccess: (...args: unknown[]) => mockGetAgentWithAccess(...args),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/audit-deferred", () => ({ deferAuditLog: vi.fn() }));

/** A grant of the kind only a pre-clamp write could have produced. */
function agentGrantedEverything() {
  mockGetAgentWithAccess.mockResolvedValue({
    id: "agent-1",
    name: "My Assistant",
    pluginConfig: { "pinchy-files": { allowed_paths: ["/"] } },
  });
}

async function callGET(requestedPath: string) {
  const { GET } = await import("@/app/api/agents/[agentId]/workspace-file/route");
  const url = new URL("http://localhost/api/agents/agent-1/workspace-file");
  url.searchParams.set("path", requestedPath);
  return GET(new NextRequest(url), { params: Promise.resolve({ agentId: "agent-1" }) }) as Promise<
    NextResponse | Response
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  // An ordinary member — the whole point is that no special role is needed.
  mockGetSession.mockResolvedValue({ user: { id: "user-1", role: "member" } });
});

describe("workspace-file — a pre-clamp allowed_paths grant of / buys nothing", () => {
  it.each([
    ["the AES master key", "/app/secrets/master.key"],
    ["the decrypted provider keys", "/openclaw-secrets/secrets.json"],
    ["openclaw.json, which carries the plaintext gateway token", "/openclaw-config/openclaw.json"],
    ["an arbitrary system file", "/etc/passwd"],
    ["the process environment", "/proc/self/environ"],
  ])("refuses %s", async (_label, path) => {
    agentGrantedEverything();

    const res = await callGET(path);

    expect(res.status).toBe(403);
    expect(await res.text()).not.toMatch(/BEGIN|apiKey|token|root:/);
  });

  it("refuses a traversal out of the data root under the same grant", async () => {
    agentGrantedEverything();

    const res = await callGET("/data/../etc/passwd");

    expect(res.status).toBe(403);
  });

  it("answers 403 rather than 404 for a non-existent path outside the ceiling", async () => {
    // A 404 would confirm which out-of-ceiling paths exist. The ceiling must
    // not become the oracle the allowlist check was careful not to be.
    agentGrantedEverything();

    const res = await callGET("/openclaw-secrets/does-not-exist.json");

    expect(res.status).toBe(403);
  });

  it("refuses even when the grant names the secrets directory outright", async () => {
    mockGetAgentWithAccess.mockResolvedValue({
      id: "agent-1",
      name: "My Assistant",
      pluginConfig: { "pinchy-files": { allowed_paths: ["/openclaw-secrets"] } },
    });

    const res = await callGET("/openclaw-secrets/secrets.json");

    expect(res.status).toBe(403);
  });
});
