import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const mockRegisterTool = vi.fn();

function createMockApi(config: {
  docsPath?: string;
  sources?: Array<{ id: string; label: string; path: string }>;
  agents: Record<string, Record<string, unknown>>;
}) {
  return {
    id: "pinchy-docs",
    name: "Pinchy Docs",
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

let docsRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  docsRoot = mkdtempSync(join(tmpdir(), "pinchy-docs-"));
});

afterEach(() => {
  rmSync(docsRoot, { recursive: true, force: true });
});

function writeMdx(relPath: string, frontmatter: Record<string, string>, body: string) {
  const fullPath = join(docsRoot, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  writeFileSync(fullPath, `---\n${fmLines}\n---\n${body}`, "utf-8");
}

describe("pinchy-docs plugin", () => {
  it("registers docs_list and docs_read as tool factories", async () => {
    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    expect(mockRegisterTool).toHaveBeenCalledTimes(2);
    const names = mockRegisterTool.mock.calls.map((c: any[]) => c[1]?.name);
    expect(names).toContain("docs_list");
    expect(names).toContain("docs_read");
  });

  it("docs_list factory returns tool for allowed agent", async () => {
    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_list"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    expect(tool).not.toBeNull();
    expect(tool.name).toBe("docs_list");
  });

  it("docs_list factory returns null for non-allowed agent", async () => {
    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_list"
    )?.[0];
    const tool = factory({ agentId: "other" });
    expect(tool).toBeNull();
  });

  it("docs_list execute returns JSON array of files with path, title, description", async () => {
    writeMdx("foo.mdx", { title: "Foo", description: "Foo description" }, "body");
    writeMdx("bar.mdx", { title: "Bar", description: "Bar description" }, "body");

    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_list"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    const foo = parsed.find((p: any) => p.path === "foo.mdx");
    expect(foo).toEqual({ path: "foo.mdx", title: "Foo", description: "Foo description" });
  });

  it("docs_list recurses into subdirectories", async () => {
    writeMdx("guides/setup.mdx", { title: "Setup", description: "Setup guide" }, "body");
    writeMdx("reference/api.mdx", { title: "API", description: "API reference" }, "body");

    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_list"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", {});
    const parsed = JSON.parse(result.content[0].text);
    const paths = parsed.map((p: any) => p.path).sort();
    expect(paths).toEqual(["guides/setup.mdx", "reference/api.mdx"]);
  });

  it("docs_list ignores non-mdx files", async () => {
    writeMdx("foo.mdx", { title: "Foo", description: "x" }, "body");
    writeFileSync(join(docsRoot, "ignored.txt"), "not mdx", "utf-8");
    writeFileSync(join(docsRoot, "ignored.md"), "not mdx", "utf-8");

    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_list"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe("foo.mdx");
  });

  it("docs_read returns file content for valid relative path", async () => {
    writeMdx("foo.mdx", { title: "Foo", description: "x" }, "Hello world");

    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_read"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", { path: "foo.mdx" });
    // Frontmatter is stripped — see "docs_read strips frontmatter" — so the
    // returned content should be the body only. Title/description live in
    // docs_list output.
    expect(result.content[0].text).toContain("Hello world");
  });

  it("docs_read rejects path traversal with ..", async () => {
    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_read"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", { path: "../etc/passwd" });
    expect(result.content[0].text.toLowerCase()).toContain("invalid");
    expect(result.isError).toBe(true);
  });

  it("docs_read rejects symlinks that escape the docs root", async () => {
    // Defense in depth: even if a symlink ends up inside the mounted docs
    // directory (mistake, attack, or future write-mount), the plugin must
    // refuse to follow it outside the docs root.
    const outside = mkdtempSync(join(tmpdir(), "pinchy-docs-outside-"));
    const secret = join(outside, "secret.mdx");
    writeFileSync(secret, "---\ntitle: secret\n---\nshould not leak", "utf-8");
    try {
      symlinkSync(secret, join(docsRoot, "leak.mdx"));
    } catch {
      // Some CI environments disallow symlinks; skip rather than fail
      rmSync(outside, { recursive: true, force: true });
      return;
    }

    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_read"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", { path: "leak.mdx" });

    expect(result.content[0].text.toLowerCase()).toContain("invalid");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("should not leak");

    rmSync(outside, { recursive: true, force: true });
  });

  it("docs_read rejects absolute paths", async () => {
    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_read"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", { path: "/etc/passwd" });
    expect(result.content[0].text.toLowerCase()).toContain("invalid");
    expect(result.isError).toBe(true);
  });

  it("docs_read marks directory-instead-of-file as error", async () => {
    mkdirSync(join(docsRoot, "subdir"), { recursive: true });

    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_read"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", { path: "subdir" });
    expect(result.content[0].text.toLowerCase()).toContain("not a file");
    expect(result.isError).toBe(true);
  });

  it("docs_read returns error for nonexistent file", async () => {
    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_read"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", { path: "nonexistent.mdx" });
    expect(result.content[0].text.toLowerCase()).toMatch(/not found|no such/);
    expect(result.isError).toBe(true);
  });

  it("docs_read factory returns null for non-allowed agent", async () => {
    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_read"
    )?.[0];
    const tool = factory({ agentId: "other" });
    expect(tool).toBeNull();
  });

  it("docs_read strips frontmatter from the returned content", async () => {
    writeMdx(
      "foo.mdx",
      { title: "Foo", description: "x" },
      "Hello world."
    );

    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_read"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", { path: "foo.mdx" });

    expect(result.content[0].text).toContain("Hello world.");
    expect(result.content[0].text).not.toContain("---");
    expect(result.content[0].text).not.toContain("title: Foo");
    expect(result.content[0].text).not.toContain("description: x");
  });

  it("docs_read strips MDX import statements", async () => {
    writeMdx(
      "foo.mdx",
      { title: "Foo" },
      [
        'import { Aside, Steps } from "@astrojs/starlight/components";',
        "import Foo from './foo';",
        "",
        "Real content here.",
      ].join("\n")
    );

    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_read"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", { path: "foo.mdx" });

    expect(result.content[0].text).toContain("Real content here.");
    expect(result.content[0].text).not.toContain("import {");
    expect(result.content[0].text).not.toContain("@astrojs/starlight");
  });

  it("docs_read unwraps MDX component tags but keeps their inner text", async () => {
    writeMdx(
      "foo.mdx",
      { title: "Foo" },
      [
        '<Aside type="caution">',
        "  Pinchy agents require models with tool calling support.",
        "</Aside>",
        "",
        "<Steps>",
        "  1. First step",
        "  2. Second step",
        "</Steps>",
      ].join("\n")
    );

    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_read"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", { path: "foo.mdx" });

    expect(result.content[0].text).toContain("Pinchy agents require models with tool calling support.");
    expect(result.content[0].text).toContain("First step");
    expect(result.content[0].text).toContain("Second step");
    expect(result.content[0].text).not.toContain("<Aside");
    expect(result.content[0].text).not.toContain("</Aside>");
    expect(result.content[0].text).not.toContain("<Steps>");
    expect(result.content[0].text).not.toContain("</Steps>");
  });

  it("docs_read preserves headings, lists, and code blocks intact", async () => {
    writeMdx(
      "foo.mdx",
      { title: "Foo" },
      [
        "## Setup",
        "",
        "Run the following:",
        "",
        "```bash",
        "ollama pull qwen3.5:9b",
        "```",
        "",
        "- one",
        "- two",
        "- three",
      ].join("\n")
    );

    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_read"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", { path: "foo.mdx" });

    expect(result.content[0].text).toContain("## Setup");
    expect(result.content[0].text).toContain("```bash");
    expect(result.content[0].text).toContain("ollama pull qwen3.5:9b");
    expect(result.content[0].text).toContain("- one");
    expect(result.content[0].text).toContain("- two");
    expect(result.content[0].text).toContain("- three");
  });

  it("docs_read does not strip angle brackets that look like JSX inside fenced code blocks", async () => {
    // Code samples may contain literal MDX/JSX that must be preserved.
    writeMdx(
      "foo.mdx",
      { title: "Foo" },
      [
        "Example component:",
        "",
        "```tsx",
        '<Aside type="note">Hello</Aside>',
        "```",
      ].join("\n")
    );

    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_read"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", { path: "foo.mdx" });

    expect(result.content[0].text).toContain('<Aside type="note">Hello</Aside>');
  });

  it("docs_read collapses runs of blank lines to a single blank line", async () => {
    writeMdx(
      "foo.mdx",
      { title: "Foo" },
      ["First.", "", "", "", "", "Second."].join("\n")
    );

    const api = createMockApi({ docsPath: docsRoot, agents: { "agent-1": {} } });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "docs_read"
    )?.[0];
    const tool = factory({ agentId: "agent-1" });
    const result = await tool.execute("call-1", { path: "foo.mdx" });

    expect(result.content[0].text).not.toMatch(/\n\n\n/);
    expect(result.content[0].text).toContain("First.");
    expect(result.content[0].text).toContain("Second.");
  });

  it("exports plugin definition with id and configSchema", async () => {
    const { default: plugin } = await import("./index");
    expect(plugin.id).toBe("pinchy-docs");
    expect(plugin.name).toBe("Pinchy Docs");
    expect(plugin.configSchema).toBeDefined();
  });

  it("registers tools with multi-source config", async () => {
    const api = createMockApi({
      sources: [
        { id: "pinchy", label: "Pinchy Docs", path: docsRoot },
      ],
      agents: { "agent-1": { sources: ["pinchy"] } },
    });
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    expect(mockRegisterTool).toHaveBeenCalledTimes(2);
    const names = mockRegisterTool.mock.calls.map((c: any[]) => c[1]?.name);
    expect(names).toContain("docs_list");
    expect(names).toContain("docs_read");
  });
});
