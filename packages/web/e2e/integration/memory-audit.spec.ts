// packages/web/e2e/integration/memory-audit.spec.ts
//
// Proves the memory-audit watcher: writing to an agent's real workspace path
// `/openclaw-config/workspaces/<agentId>/MEMORY.md` inside the Pinchy container
// emits an `agent.memory_changed` audit entry with the expected detail shape.
//
// This path is the SAME place a real agent's pinchy_write lands: the
// `pinchy-workspaces` volume is mounted at `/openclaw-config/workspaces` in the
// Pinchy container and `/root/.openclaw/workspaces` in the OpenClaw container,
// so a write from either side is the same bytes. Writing to the OLD
// `/openclaw-config/agents/<id>/` path is exactly the #345 trap — that subtree
// is not where agents live, so the test would pass while production stayed
// broken. We deliberately exercise the production layout.
//
// Why `docker compose exec` instead of host-side file writes:
// Issue #196 moved the integration suite to run Pinchy in its production
// container. The container mounts the volumes as named Docker volumes (no
// host-visible path), so to feed the watcher we have to write the file from
// inside the running container. We use the same `composeExec` pattern the
// global-setup hook uses for OpenClaw config reads.

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import path from "path";
import { login, getSmithersAgentId } from "./helpers";

const COMPOSE_FILES =
  "-f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.integration.yml";
const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const COMPOSE_ENV = { ...process.env, PINCHY_VERSION: process.env.PINCHY_VERSION || "local" };

// Inside the Pinchy container the watcher walks the workspace base
// `/openclaw-config/workspaces/<id>/` (WORKSPACE_BASE_PATH default — see
// workspace.ts). In production and in the integration stack this is the
// `pinchy-workspaces` named volume mounted at that path.
const CONTAINER_WORKSPACE_BASE = "/openclaw-config/workspaces";

function pinchyExec(cmd: string): string {
  return execSync(`docker compose ${COMPOSE_FILES} exec -T pinchy ${cmd}`, {
    encoding: "utf8",
    cwd: PROJECT_ROOT,
    env: COMPOSE_ENV,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

test.describe("memory-audit watcher emits agent.memory_changed on MEMORY.md write", () => {
  let containerMemoryPath = "";

  test.afterEach(() => {
    if (containerMemoryPath) {
      try {
        pinchyExec(`rm -f ${containerMemoryPath}`);
      } catch {
        // best-effort cleanup; container may already be tearing down
      }
      containerMemoryPath = "";
    }
  });

  test("writes 3 new lines → audit log shows addedLines>=3 with full detail", async ({ page }) => {
    // 1. Login as the admin so we can query both /api/agents and /api/audit.
    await login(page);

    // 2. Find Smithers (auto-created during setup). Also fetch its display name
    //    dynamically so the assertion below works even if a future test variant
    //    customizes the name.
    const smithersId = await getSmithersAgentId(page);
    const agentsRes = await page.request.get("/api/agents");
    const agentsBody = (await agentsRes.json()) as Array<{ id: string; name: string }>;
    const smithers = agentsBody.find((a) => a.id === smithersId);
    expect(smithers, "Smithers row not present in /api/agents").toBeTruthy();
    const smithersName = smithers!.name;

    // 3. Compute the watched path inside the container. The watcher recognizes
    //    `<workspaceBase>/<agentId>/MEMORY.md` exactly (see parse-path.ts) —
    //    the real on-disk home of an agent's memory.
    containerMemoryPath = `${CONTAINER_WORKSPACE_BASE}/${smithersId}/MEMORY.md`;

    // 4. Write a unique, timestamped 3-line file via `docker exec`. The
    //    uniqueness defends against the case where a prior run left identical
    //    content on disk — that would make `addedLines === 0` and produce a
    //    false negative. We don't pre-delete an existing MEMORY.md and rewrite:
    //    that path is racy because the watcher's snapshot store after an
    //    unlink+add depends on event ordering. Instead we rely on
    //    `addedLines >= 3` which is robust to whatever the watcher's prior
    //    snapshot was.
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const lines = [
      `remembered fact 1 (run ${stamp})`,
      `remembered fact 2 (run ${stamp})`,
      `remembered fact 3 (run ${stamp})`,
    ];
    const content = lines.join("\n") + "\n";
    const expectedByteSize = Buffer.byteLength(content, "utf8");

    // mkdir -p the agent dir (OpenClaw creates it lazily; on a fresh stack
    // Smithers may not have memory writes yet) then write via base64 to avoid
    // any shell-quoting hazards around newlines or special characters.
    const base64 = Buffer.from(content, "utf8").toString("base64");
    pinchyExec(`mkdir -p ${path.posix.dirname(containerMemoryPath)}`);
    pinchyExec(`sh -c 'echo ${base64} | base64 -d > ${containerMemoryPath}'`);

    // 5. Poll the audit API. The watcher debounces writes through chokidar's
    //    awaitWriteFinish (200 ms stability + 50 ms poll), plus a 250 ms poll
    //    interval (usePolling) on the chokidar side, plus there's a
    //    fs → handler hop and a DB insert. 30 × 500 ms = 15 s is comfortably
    //    above the worst case under CI load.
    type AuditEntry = {
      eventType: string;
      resource: string;
      actorType: string;
      actorId: string;
      outcome: string;
      detail: {
        agent?: { id?: string; name?: string };
        file?: string;
        addedLines?: number;
        removedLines?: number;
        byteSize?: number;
      };
    };
    let entry: AuditEntry | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      const res = await page
        .context()
        .request.get(`/api/audit?eventType=agent.memory_changed&limit=50`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { entries: AuditEntry[] };
      entry = body.entries.find(
        (e) => e.detail?.agent?.id === smithersId && e.detail?.file === "MEMORY.md"
      );
      if (entry) break;
      await page.waitForTimeout(500);
    }

    expect(
      entry,
      `agent.memory_changed for ${smithersId}/MEMORY.md not found in audit log`
    ).toBeDefined();

    // 6. Core shape: actor identity and resource framing.
    expect(entry!.eventType).toBe("agent.memory_changed");
    expect(entry!.resource).toBe(`agent:${smithersId}`);
    expect(entry!.actorType).toBe("agent");
    expect(entry!.actorId).toBe(smithersId);
    expect(entry!.outcome).toBe("success");

    // 7. Detail: snapshotted agent + file id + byte size match exactly.
    expect(entry!.detail.agent).toEqual({ id: smithersId, name: smithersName });
    expect(entry!.detail.file).toBe("MEMORY.md");
    expect(entry!.detail.byteSize).toBe(expectedByteSize);

    // 8. Line diff: we wrote 3 lines and never removed any in this write.
    //    `>= 3` (rather than `=== 3`) is intentional — the watcher's prior
    //    snapshot at the moment of our write is non-deterministic (an earlier
    //    test or a stale on-disk MEMORY.md could have populated it). Three
    //    new fact lines are guaranteed to surface as "added" regardless.
    expect(entry!.detail.addedLines).toBeGreaterThanOrEqual(3);
    expect(entry!.detail.removedLines).toBeGreaterThanOrEqual(0);
  });
});
