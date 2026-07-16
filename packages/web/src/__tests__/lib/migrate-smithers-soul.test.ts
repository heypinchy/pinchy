import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @/db ────────────────────────────────────────────────────────────────
const findManyMock = vi.fn().mockResolvedValue([]);
vi.mock("@/db", () => ({
  db: {
    query: {
      agents: {
        findMany: (...args: unknown[]) => findManyMock(...args),
      },
    },
  },
}));

// ── Mock @/lib/workspace ─────────────────────────────────────────────────────
const readWorkspaceFileMock = vi.fn();
const writeWorkspaceFileMock = vi.fn();
vi.mock("@/lib/workspace", () => ({
  readWorkspaceFile: (...args: unknown[]) => readWorkspaceFileMock(...args),
  writeWorkspaceFile: (...args: unknown[]) => writeWorkspaceFileMock(...args),
}));

// ── Mock @/lib/audit + @/lib/audit-deferred ──────────────────────────────────
const appendAuditLogMock = vi.fn().mockResolvedValue({ id: 1, rowHmac: "x" });
vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => appendAuditLogMock(...args),
}));
const recordAuditFailureMock = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  recordAuditFailure: (...args: unknown[]) => recordAuditFailureMock(...args),
}));

// NOT mocked, deliberately: @/lib/smithers-soul and @/lib/smithers-soul-history.
// The whole point of this suite is that a REAL historical soul upgrades to the
// REAL current one. Stubbing either constant would turn the migration test into
// a tautology that passes no matter what the hash list says.
import { SMITHERS_SOUL_MD } from "@/lib/smithers-soul";
import { CURRENT_SOUL_HASH, hashSoul } from "@/lib/smithers-soul-history";
import { PERSONALITY_PRESETS } from "@/lib/personality-presets";
import { SOUL_2026_04_09 } from "../fixtures/smithers-soul-2026-04-09";

const agentRow = (id: string, name = "Smithers") => ({ id, name });

async function runMigration() {
  const { migrateSmithersSoul } = await import("@/lib/migrate-smithers-soul");
  return migrateSmithersSoul();
}

describe("migrateSmithersSoul", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findManyMock.mockResolvedValue([]);
    appendAuditLogMock.mockResolvedValue({ id: 1, rowHmac: "x" });
  });

  // ── The pre-existing-data test AGENTS.md § "Test Migrations Against
  //    Pre-Existing Data" mandates. Every other test here starts from a clean
  //    slate where the current soul was written on the first write, which proves
  //    nothing about the state an UPGRADE produces: old data, new code.
  it("upgrades a real pre-2026-04-15 soul that predates the docs-driven rewrite", async () => {
    findManyMock.mockResolvedValue([agentRow("smithers-1")]);
    readWorkspaceFileMock.mockReturnValue(SOUL_2026_04_09);

    await runMigration();

    expect(writeWorkspaceFileMock).toHaveBeenCalledWith("smithers-1", "SOUL.md", SMITHERS_SOUL_MD);
  });

  it("leaves the stale soul's hardcoded platform knowledge behind entirely", async () => {
    // The bug in one assertion: the old soul claims to know the platform from
    // memory, which is what makes a pre-April Smithers state stale facts with
    // confidence. After the migration that claim must be gone, replaced by the
    // docs_list/docs_read procedure.
    findManyMock.mockResolvedValue([agentRow("smithers-1")]);
    readWorkspaceFileMock.mockReturnValue(SOUL_2026_04_09);
    expect(SOUL_2026_04_09).toContain("You know the Pinchy platform inside out");

    await runMigration();

    const written = writeWorkspaceFileMock.mock.calls[0][2] as string;
    expect(written).not.toContain("You know the Pinchy platform inside out");
    expect(written).toContain("docs_list");
    expect(written).toContain("You do NOT know Pinchy's features from memory");
  });

  // ── The accepted limit of the hash selector, pinned so it stays a decision
  //    rather than a surprise. The migration matches OUR TEXT, wherever it
  //    sits — it asks nothing about the agent row. Both cases below are
  //    therefore upgrades, not skips, and docs/guides/upgrading.mdx is worded
  //    to match ("we only replace a SOUL.md that still matches one we
  //    shipped") rather than promising that everything typed in Agent Settings
  //    survives. Change this behavior only with the collision guard in
  //    smithers-soul-history.test.ts in view.
  it("upgrades an unrelated agent whose SOUL.md was copied from Smithers", async () => {
    // Someone builds a second assistant and pastes Smithers' soul in as a
    // starting point, unchanged. The bytes are ours, so the sweep takes it.
    findManyMock.mockResolvedValue([agentRow("copycat-1", "Research Buddy")]);
    readWorkspaceFileMock.mockReturnValue(SOUL_2026_04_09);

    await runMigration();

    expect(writeWorkspaceFileMock).toHaveBeenCalledWith("copycat-1", "SOUL.md", SMITHERS_SOUL_MD);
    // findMany is mocked, so the assertion above would stay green if someone
    // narrowed the query to `where: eq(agents.isPersonal, true)` — the sweep
    // would simply never see this agent in production. Pin the absence of a
    // row filter here, where the reason for it is written down.
    expect(findManyMock.mock.calls[0][0]).not.toHaveProperty("where");
  });

  it("upgrades a soul the user deliberately pasted back from an older release", async () => {
    // The user preferred the old behavior and restored the file by hand. A
    // byte match cannot distinguish that from a file we wrote ourselves, so
    // they get upgraded anyway. Documented, not fixable by hashing alone.
    findManyMock.mockResolvedValue([agentRow("smithers-1")]);
    readWorkspaceFileMock.mockReturnValue(SOUL_2026_04_09);

    await runMigration();

    expect(writeWorkspaceFileMock).toHaveBeenCalledOnce();
  });

  it("never touches a soul the user has customized", async () => {
    findManyMock.mockResolvedValue([agentRow("custom-1")]);
    readWorkspaceFileMock.mockReturnValue(SMITHERS_SOUL_MD + "\n\nAlways answer in haiku.\n");

    await runMigration();

    expect(writeWorkspaceFileMock).not.toHaveBeenCalled();
    expect(appendAuditLogMock).not.toHaveBeenCalled();
  });

  it.each(Object.entries(PERSONALITY_PRESETS))(
    "never touches an agent created from the %s preset",
    async (id, preset) => {
      // The REAL preset soul, not a stand-in string: preset souls are the one
      // other set Pinchy ships, and `the-butler`'s already shares paragraphs
      // with Smithers'. An invented string would only re-test the "customized"
      // case above and prove nothing about the actual collision risk.
      //
      // This is the behavioral half. The structural half — "no preset may ever
      // hash into SHIPPED_SOUL_HASHES" — is guarded in
      // smithers-soul-history.test.ts, which fails loudly and names the preset.
      findManyMock.mockResolvedValue([agentRow(`preset-${id}`, preset.name)]);
      readWorkspaceFileMock.mockReturnValue(preset.soulMd);

      await runMigration();

      expect(writeWorkspaceFileMock).not.toHaveBeenCalled();
      expect(appendAuditLogMock).not.toHaveBeenCalled();
    }
  );

  it("is a no-op when the soul is already current", async () => {
    findManyMock.mockResolvedValue([agentRow("smithers-1")]);
    readWorkspaceFileMock.mockReturnValue(SMITHERS_SOUL_MD);

    await runMigration();

    expect(writeWorkspaceFileMock).not.toHaveBeenCalled();
    expect(appendAuditLogMock).not.toHaveBeenCalled();
  });

  it("skips an agent with no SOUL.md on disk", async () => {
    // readWorkspaceFile returns "" for a missing file rather than throwing. No
    // file means no hash means no proof of provenance, so there is nothing to
    // upgrade — and we must not conjure a Smithers soul into an unrelated agent.
    findManyMock.mockResolvedValue([agentRow("no-soul-1")]);
    readWorkspaceFileMock.mockReturnValue("");

    await runMigration();

    expect(writeWorkspaceFileMock).not.toHaveBeenCalled();
  });

  it("handles an install with no agents", async () => {
    findManyMock.mockResolvedValue([]);

    await expect(runMigration()).resolves.not.toThrow();

    expect(writeWorkspaceFileMock).not.toHaveBeenCalled();
  });

  // ── Audit ──────────────────────────────────────────────────────────────────
  it("writes an agent.updated row recording the hash change, not the prompt", async () => {
    findManyMock.mockResolvedValue([agentRow("smithers-1", "Smithers")]);
    readWorkspaceFileMock.mockReturnValue(SOUL_2026_04_09);

    await runMigration();

    expect(appendAuditLogMock).toHaveBeenCalledTimes(1);
    const entry = appendAuditLogMock.mock.calls[0][0];
    expect(entry).toMatchObject({
      actorType: "system",
      actorId: "system",
      eventType: "agent.updated",
      resource: "agent:smithers-1",
      outcome: "success",
    });
    expect(entry.detail.changes["SOUL.md"]).toEqual({
      from: hashSoul(SOUL_2026_04_09),
      to: CURRENT_SOUL_HASH,
    });
    expect(entry.detail.agent).toEqual({ id: "smithers-1", name: "Smithers" });
    expect(entry.detail.sweepId).toMatch(/^[0-9a-f-]{36}$/);

    // The prompt itself must never enter the audit trail — same rule the
    // diagnostics collector follows for instructionsHash.
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("You know the Pinchy platform inside out");
    expect(serialized).not.toContain("## Personality");
  });

  it("shares one sweepId across every agent upgraded in the same run", async () => {
    findManyMock.mockResolvedValue([agentRow("smithers-1"), agentRow("smithers-2")]);
    readWorkspaceFileMock.mockReturnValue(SOUL_2026_04_09);

    await runMigration();

    expect(appendAuditLogMock).toHaveBeenCalledTimes(2);
    const [a, b] = appendAuditLogMock.mock.calls.map((c) => c[0].detail.sweepId);
    expect(a).toBe(b);
  });

  it("keeps the sweep going when one agent's audit write fails", async () => {
    // The soul is already on disk by the time the audit runs — a non-rollbackable
    // side effect, so the failure is recorded rather than thrown (AGENTS.md's
    // non-request-context pattern).
    findManyMock.mockResolvedValue([agentRow("smithers-1"), agentRow("smithers-2")]);
    readWorkspaceFileMock.mockReturnValue(SOUL_2026_04_09);
    appendAuditLogMock.mockRejectedValueOnce(new Error("audit down"));

    await expect(runMigration()).resolves.not.toThrow();

    expect(recordAuditFailureMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceFileMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the sweep going when one agent's workspace is unwritable", async () => {
    findManyMock.mockResolvedValue([agentRow("broken-1"), agentRow("smithers-2")]);
    readWorkspaceFileMock.mockReturnValue(SOUL_2026_04_09);
    writeWorkspaceFileMock.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });

    await expect(runMigration()).resolves.not.toThrow();

    expect(writeWorkspaceFileMock).toHaveBeenCalledTimes(2);
    // No audit row for the agent whose soul never changed.
    expect(appendAuditLogMock).toHaveBeenCalledTimes(1);
    expect(appendAuditLogMock.mock.calls[0][0].resource).toBe("agent:smithers-2");
  });

  it("keeps the sweep going when one agent's SOUL.md is unreadable", async () => {
    // Guards the catch, not a reachable production path: the real
    // readWorkspaceFile swallows fs errors and returns "" (covered by the
    // missing-SOUL.md test above), so nothing but its agentId assertion can
    // throw. This pins the loop's structure — one bad agent must not strand
    // the rest — against a future readWorkspaceFile that propagates EIO.
    findManyMock.mockResolvedValue([agentRow("broken-1"), agentRow("smithers-2")]);
    readWorkspaceFileMock.mockImplementationOnce(() => {
      throw new Error("EIO");
    });
    readWorkspaceFileMock.mockReturnValue(SOUL_2026_04_09);

    await expect(runMigration()).resolves.not.toThrow();

    expect(writeWorkspaceFileMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceFileMock).toHaveBeenCalledWith("smithers-2", "SOUL.md", SMITHERS_SOUL_MD);
  });
});
