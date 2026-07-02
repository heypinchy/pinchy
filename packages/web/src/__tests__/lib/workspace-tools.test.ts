import { describe, it, expect, vi, beforeEach } from "vitest";

// TOOLS.md mailbox context: email agents must know the identity (address) of
// the mailbox they operate on. generateToolsContent renders the bootstrap
// content from a LIST of mailbox entries (multi-integration-safe: correct for
// 0, 1, and N entries); writeToolsFile materializes it into the agent
// workspace and actively removes the file when there is nothing to say, so no
// stale mailbox identity survives a permission revocation.

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(false);
  const mkdirSyncMock = vi.fn();
  const rmSyncMock = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: writeFileSyncMock,
      readFileSync: readFileSyncMock,
      existsSync: existsSyncMock,
      mkdirSync: mkdirSyncMock,
      rmSync: rmSyncMock,
    },
    writeFileSync: writeFileSyncMock,
    readFileSync: readFileSyncMock,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    rmSync: rmSyncMock,
  };
});

import { writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { generateToolsContent, writeToolsFile } from "@/lib/workspace";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedRmSync = vi.mocked(rmSync);

describe("generateToolsContent", () => {
  it("returns empty content for an empty mailbox list (no stale section)", () => {
    expect(generateToolsContent([])).toBe("");
  });

  it("renders a connected-email section for a single mailbox", () => {
    const content = generateToolsContent([
      {
        address: "hermes@example.com",
        label: "Work Gmail",
        operations: ["read", "search"],
      },
    ]);

    // Heading-level section for connected email.
    expect(content).toContain("## Connected Email");
    // The mailbox address is the headline of its block.
    expect(content).toContain("### hermes@example.com");
    // The Pinchy connection label is shown because it differs from the address.
    expect(content).toContain("Pinchy connection label: Work Gmail");
    // Operations are rendered human-readable, in canonical order.
    expect(content).toContain("Granted operations: read messages, search the mailbox");
  });

  it("states that the mailbox identity is not necessarily the chatting user's address", () => {
    const content = generateToolsContent([
      { address: "shared@example.com", label: "shared@example.com", operations: ["read"] },
    ]);
    // Shared agents serve multiple users — the mailbox identity must not be
    // conflated with the identity of whoever is currently chatting.
    expect(content).toContain("not necessarily the personal address of the user");
  });

  it("omits the label line when the label equals the address (name defaults to address)", () => {
    const content = generateToolsContent([
      { address: "same@example.com", label: "same@example.com", operations: ["read"] },
    ]);
    expect(content).toContain("### same@example.com");
    expect(content).not.toContain("Pinchy connection label");
  });

  it("renders every entry when given multiple mailboxes (no single-entry assumption)", () => {
    const content = generateToolsContent([
      { address: "first@example.com", label: "First", operations: ["read"] },
      { address: "second@example.com", label: "second@example.com", operations: ["send"] },
      { address: "third@example.com", label: "Third Mailbox", operations: ["draft", "send"] },
    ]);

    expect(content).toContain("### first@example.com");
    expect(content).toContain("Pinchy connection label: First");
    expect(content).toContain("### second@example.com");
    expect(content).toContain("### third@example.com");
    expect(content).toContain("Granted operations: create drafts, send email");
    // Exactly one section heading — entries are blocks inside it.
    expect(content.match(/## Connected Email/g)).toHaveLength(1);
  });

  it("renders 'none' when a mailbox has no granted operations", () => {
    const content = generateToolsContent([
      { address: "idle@example.com", label: "idle@example.com", operations: [] },
    ]);
    expect(content).toContain("Granted operations: none");
  });
});

describe("writeToolsFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
  });

  it("writes TOOLS.md into the agent workspace when mailboxes exist", () => {
    writeToolsFile("agent-1", [
      { address: "hermes@example.com", label: "Work Gmail", operations: ["read"] },
    ]);

    expect(mockedMkdirSync).toHaveBeenCalledWith("/openclaw-config/workspaces/agent-1", {
      recursive: true,
    });
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
    const [path, content] = mockedWriteFileSync.mock.calls[0];
    expect(path).toBe("/openclaw-config/workspaces/agent-1/TOOLS.md");
    expect(String(content)).toContain("hermes@example.com");
    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  it("removes TOOLS.md when there are no mailboxes (no stale content)", () => {
    writeToolsFile("agent-1", []);

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(mockedRmSync).toHaveBeenCalledWith("/openclaw-config/workspaces/agent-1/TOOLS.md", {
      force: true,
    });
  });

  it("rejects path-traversal agent ids", () => {
    expect(() => writeToolsFile("../evil", [])).toThrow("Invalid agentId: ../evil");
  });
});
