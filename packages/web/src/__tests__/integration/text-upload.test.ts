import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * End-to-end contract for text data attachments (issue #392).
 *
 * The chat upload adapter routes CSV / plain-text / Markdown / JSON / YAML to
 * the workspace path (not inline). This locks the server half of that path:
 * such files must validate, persist to `uploads/`, stay OUT of the inline
 * chatAttachments list, and get an upload hint pointing the agent at
 * `pinchy_read`. The adapter half lives in attachment-routing.test.ts and
 * binary-file-adapter.test.ts.
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-text-upload-integration-"));
  vi.stubEnv("WORKSPACE_BASE_PATH", tmpRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

const CSV_BASE64 = Buffer.from("name,amount\nwidget,42\n").toString("base64");
const YAML_BASE64 = Buffer.from("key: value\nlist:\n  - one\n  - two\n").toString("base64");

describe("text data upload contract — workspace via pinchy_read", () => {
  it("persists a CSV to the workspace, keeps it out of inline attachments, and hints pinchy_read", async () => {
    const { processIncomingAttachments, buildAttachmentBlock } =
      await import("@/server/attachment-pipeline");

    const result = await processIncomingAttachments({
      agentId: "agent-csv-contract",
      contentParts: [
        { type: "image_url", image_url: { url: `data:text/csv;base64,${CSV_BASE64}` } },
      ],
      claimedFilenames: ["data.csv"],
    });

    // Text files are NOT sent inline to the LLM — they live in the workspace.
    expect(result.chatAttachments).toHaveLength(0);

    expect(result.workspaceRefs).toHaveLength(1);
    const ref = result.workspaceRefs[0];
    expect(ref.relativePath).toBe("uploads/data.csv");
    expect(ref.mimeType).toBe("text/csv");

    const hint = buildAttachmentBlock(result.workspaceRefs);
    expect(hint).toMatch(/^<pinchy:attachments>/);
    expect(hint).toMatch(/<\/pinchy:attachments>$/);
    expect(hint).toContain("pinchy_read");
    expect(hint).toContain(ref.absolutePath);
  });

  it("persists a YAML file and maps it to pinchy_read", async () => {
    const { processIncomingAttachments, buildAttachmentBlock } =
      await import("@/server/attachment-pipeline");

    const result = await processIncomingAttachments({
      agentId: "agent-yaml-contract",
      contentParts: [
        { type: "image_url", image_url: { url: `data:text/yaml;base64,${YAML_BASE64}` } },
      ],
      claimedFilenames: ["config.yaml"],
    });

    expect(result.chatAttachments).toHaveLength(0);
    expect(result.workspaceRefs).toHaveLength(1);
    expect(result.workspaceRefs[0].mimeType).toBe("text/yaml");
    expect(buildAttachmentBlock(result.workspaceRefs)).toContain("pinchy_read");
  });

  it("rejects a file claimed as text but carrying binary (null-byte) content", async () => {
    const { processIncomingAttachments } = await import("@/server/attachment-pipeline");
    const binaryAsCsv = Buffer.from([0x61, 0x00, 0x62]).toString("base64");

    await expect(
      processIncomingAttachments({
        agentId: "agent-bad-csv-contract",
        contentParts: [
          { type: "image_url", image_url: { url: `data:text/csv;base64,${binaryAsCsv}` } },
        ],
        claimedFilenames: ["evil.csv"],
      })
    ).rejects.toThrow();
  });
});
