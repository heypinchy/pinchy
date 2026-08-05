import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #1095, the half that does not need root.
//
// The OpenClaw container repairs ownership on a 50 ms tick, but only root can
// chown — so that repair reaches a customer's instance only when they upgrade
// the OpenClaw image, and never through Pinchy alone. Pinchy can do better on
// its own, because of a POSIX detail we measured in the production container:
//
//   file owner: 0, dir owner: 999
//     overwrite: DENIED (EACCES — the production failure)
//     unlink:    OK
//     recreate:  OK (owner now 999)
//
// `unlink()` is authorized by write permission on the DIRECTORY, not on the
// file, and the workspace directory is Pinchy's. So every one of these writes
// can reclaim a file it no longer owns, at the moment the user hits Save,
// without root and without a container upgrade on the other side.
//
// This is safe for ALL bootstrap files, not just the generated ones, and the
// reason is worth stating precisely: the fallback only ever runs where Pinchy
// is already replacing the file's entire contents. Deleting first destroys
// nothing that the write itself would have kept. A file Pinchy merely reads
// (MEMORY.md, uploads) never reaches this path.

// Real filesystem, deliberately: the whole point is POSIX's split between
// "may write this file" and "may unlink it from this directory", which a
// mocked `fs` would model rather than exercise.
const TEST_ROOT = mkdtempSync(join(tmpdir(), "workspace-reclaim-"));
process.env.WORKSPACE_BASE_PATH = TEST_ROOT;

let workspace: typeof import("@/lib/workspace");
const AGENT_ID = "6f1c0f6e-9f7c-4f4e-9a1e-2f0d4b8c1a55";

beforeEach(async () => {
  vi.resetModules();
  workspace = await import("@/lib/workspace");
  mkdirSync(join(TEST_ROOT, AGENT_ID), { recursive: true });
});

afterEach(() => {
  rmSync(join(TEST_ROOT, AGENT_ID), { recursive: true, force: true });
});

/**
 * Reproduce the production shape without root: a file the process may not
 * write, inside a directory it may. Mode 0444 denies the owner the write too —
 * the kernel checks the mode bits for everyone except root, which is why this
 * block is skipped when the suite happens to run as root (a root process would
 * sail through the write and the assertion would prove nothing).
 */
function seedUnwritable(filename: string, content = "written by the other container\n"): string {
  const filePath = join(TEST_ROOT, AGENT_ID, filename);
  writeFileSync(filePath, content, "utf-8");
  chmodSync(filePath, 0o444);
  return filePath;
}

const runningAsRoot = process.getuid?.() === 0;

describe.skipIf(runningAsRoot)(
  "workspace writes reclaim a file they cannot overwrite (#1095)",
  () => {
    it("writeWorkspaceFile replaces an unwritable AGENTS.md", () => {
      const filePath = seedUnwritable("AGENTS.md");

      workspace.writeWorkspaceFile(AGENT_ID, "AGENTS.md", "# New instructions\n");

      expect(readFileSync(filePath, "utf-8")).toBe("# New instructions\n");
    });

    it("writeWorkspaceFile replaces an unwritable SOUL.md", () => {
      const filePath = seedUnwritable("SOUL.md");

      workspace.writeWorkspaceFile(AGENT_ID, "SOUL.md", "# New personality\n");

      expect(readFileSync(filePath, "utf-8")).toBe("# New personality\n");
    });

    it("writeToolsFile replaces the unwritable TOOLS.md that caused the incident", () => {
      // The exact production case: OpenClaw's bootstrap placeholder sits where
      // Pinchy needs to write the mailbox context.
      const filePath = seedUnwritable("TOOLS.md", "# TOOLS.md - Local Notes\n");

      workspace.writeToolsFile(AGENT_ID, [
        {
          address: "commercial@example.com",
          label: "commercial@example.com",
          operations: ["read"],
        },
      ]);

      const written = readFileSync(filePath, "utf-8");
      expect(written).toContain("commercial@example.com");
      expect(written).not.toContain("Local Notes");
    });

    it("writeIdentityFile replaces an unwritable IDENTITY.md", () => {
      const filePath = seedUnwritable("IDENTITY.md");

      workspace.writeIdentityFile(AGENT_ID, { name: "Penny", tagline: "Track invoices" });

      expect(readFileSync(filePath, "utf-8")).toContain("Penny");
    });

    it("writeWorkspaceFileInternal replaces an unwritable USER.md", () => {
      const filePath = seedUnwritable("USER.md");

      workspace.writeWorkspaceFileInternal(AGENT_ID, "USER.md", "# Context\n");

      expect(readFileSync(filePath, "utf-8")).toBe("# Context\n");
    });

    it("leaves the file writable afterwards, so the next save needs no reclaim", () => {
      // Reclaiming once must actually fix the state. If the new file inherited
      // the old mode, every subsequent save would pay the same dance — and in
      // production the ownership would never return to Pinchy.
      const filePath = seedUnwritable("TOOLS.md");

      workspace.writeToolsFile(AGENT_ID, [
        { address: "a@example.com", label: "a@example.com", operations: ["read"] },
      ]);
      workspace.writeToolsFile(AGENT_ID, [
        { address: "b@example.com", label: "b@example.com", operations: ["read"] },
      ]);

      expect(readFileSync(filePath, "utf-8")).toContain("b@example.com");
    });

    it("still throws when the DIRECTORY is the unwritable part", () => {
      // Reclaiming works because the directory is Pinchy's. When it is not,
      // unlink is denied too and there is nothing Pinchy can do without root —
      // that case belongs to the OpenClaw-side repair tick, and must surface as
      // an error rather than be swallowed into a silent no-op.
      const dir = join(TEST_ROOT, AGENT_ID);
      seedUnwritable("AGENTS.md");
      chmodSync(dir, 0o555);

      try {
        expect(() => workspace.writeWorkspaceFile(AGENT_ID, "AGENTS.md", "x")).toThrow();
      } finally {
        chmodSync(dir, 0o755);
      }
    });
  }
);
