import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";

const mockRegisterTool = vi.fn();

function createMockApi(config: {
  agents: Record<string, { tools: string[] }>;
}) {
  return {
    id: "pinchy-image",
    name: "Pinchy Image",
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
  agents: {
    "agent-all": { tools: ["image_crop", "image_resize", "image_rotate", "image_convert"] },
    "agent-crop-only": { tools: ["image_crop"] },
  },
};

let workspaceRoot: string;

async function seedImage(agentId: string, filename: string): Promise<void> {
  const uploadsDir = join(workspaceRoot, agentId, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const png = await sharp({
    create: { width: 200, height: 100, channels: 3, background: { r: 10, g: 200, b: 80 } },
  }).png().toBuffer();
  writeFileSync(join(uploadsDir, filename), png);
}

beforeEach(() => {
  vi.clearAllMocks();
  workspaceRoot = mkdtempSync(join(tmpdir(), "pinchy-image-test-"));
  process.env.PINCHY_IMAGE_WORKSPACE_ROOT = workspaceRoot;
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.PINCHY_IMAGE_WORKSPACE_ROOT;
  delete process.env.PINCHY_IMAGE_MAX_BYTES;
});

describe("pinchy-image plugin", () => {
  it("registers all four tools as factories", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const names = mockRegisterTool.mock.calls.map((c: any[]) => c[1]?.name);
    expect(names).toEqual(
      expect.arrayContaining(["image_crop", "image_resize", "image_rotate", "image_convert"])
    );
    expect(mockRegisterTool).toHaveBeenCalledTimes(4);
  });

  it("crop factory returns the tool only for agents that list image_crop", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "image_crop"
    )?.[0];

    expect(factory({ agentId: "agent-all" })).not.toBeNull();
    expect(factory({ agentId: "agent-crop-only" })).not.toBeNull();
    expect(factory({ agentId: "agent-resize-only" })).toBeNull();
    expect(factory({})).toBeNull();
  });

  it("resize factory returns null when the agent does not list image_resize", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "image_resize"
    )?.[0];

    expect(factory({ agentId: "agent-crop-only" })).toBeNull();
    expect(factory({ agentId: "agent-all" })).not.toBeNull();
  });

  it("image_crop writes a new file in the agent's uploads dir and returns its filename", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    await seedImage("agent-all", "receipt.png");

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "image_crop"
    )?.[0];
    const tool = factory({ agentId: "agent-all" });
    const result = await tool.execute("call-1", {
      source: "receipt.png",
      x: 10,
      y: 10,
      width: 80,
      height: 50,
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(typeof payload.id).toBe("string");
    expect(payload.id).toMatch(/\.png$/);
    expect(payload.id).not.toBe("receipt.png");

    const outPath = join(workspaceRoot, "agent-all", "uploads", payload.id);
    expect(existsSync(outPath)).toBe(true);
    const meta = await sharp(readFileSync(outPath)).metadata();
    expect(meta.width).toBe(80);
    expect(meta.height).toBe(50);
  });

  it("image_crop rejects unsafe filenames (path traversal)", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "image_crop"
    )?.[0];
    const tool = factory({ agentId: "agent-all" });
    const result = await tool.execute("call-1", {
      source: "../etc/passwd",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid|filename/i);
  });

  it("image_crop reports a clear error when the source file does not exist", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "image_crop"
    )?.[0];
    const tool = factory({ agentId: "agent-all" });
    const result = await tool.execute("call-1", {
      source: "missing.png",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  it("image_resize uses the requested width and keeps source extension", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    await seedImage("agent-all", "photo.png");

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "image_resize"
    )?.[0];
    const tool = factory({ agentId: "agent-all" });
    const result = await tool.execute("call-1", {
      source: "photo.png",
      width: 50,
    });
    const payload = JSON.parse(result.content[0].text);
    const meta = await sharp(readFileSync(join(workspaceRoot, "agent-all", "uploads", payload.id))).metadata();
    expect(meta.width).toBe(50);
    expect(payload.id).toMatch(/\.png$/);
  });

  it("image_rotate rotates the source image", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    await seedImage("agent-all", "rotated.png");

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "image_rotate"
    )?.[0];
    const tool = factory({ agentId: "agent-all" });
    const result = await tool.execute("call-1", { source: "rotated.png", angle: 90 });
    const payload = JSON.parse(result.content[0].text);
    const meta = await sharp(readFileSync(join(workspaceRoot, "agent-all", "uploads", payload.id))).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(200);
  });

  it("image_convert switches the file extension to match the target format", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    await seedImage("agent-all", "source.png");

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "image_convert"
    )?.[0];
    const tool = factory({ agentId: "agent-all" });
    const result = await tool.execute("call-1", { source: "source.png", format: "webp" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.id).toMatch(/\.webp$/);
    const meta = await sharp(readFileSync(join(workspaceRoot, "agent-all", "uploads", payload.id))).metadata();
    expect(meta.format).toBe("webp");
  });

  it("image_convert rejects unsupported formats", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    await seedImage("agent-all", "source.png");

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "image_convert"
    )?.[0];
    const tool = factory({ agentId: "agent-all" });
    const result = await tool.execute("call-1", { source: "source.png", format: "tiff" });
    expect(result.isError).toBe(true);
  });

  it("exports plugin definition with id and configSchema", async () => {
    const { default: plugin } = await import("./index");
    expect(plugin.id).toBe("pinchy-image");
    expect(plugin.name).toBe("Pinchy Image");
    expect(plugin.configSchema).toBeDefined();
  });

  it("configSchema.validate rejects when agents is not a plain object", async () => {
    const { default: plugin } = await import("./index");
    const validate = (plugin.configSchema as { validate: (v: unknown) => { ok: boolean } }).validate;
    expect(validate({ agents: null }).ok).toBe(false);
    expect(validate({ agents: [] }).ok).toBe(false);
    expect(validate({ agents: "nope" }).ok).toBe(false);
    expect(validate({ agents: {} }).ok).toBe(true);
  });

  it("rejects .gif source files (animation would be silently dropped)", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    // Seed a real PNG but name it .gif — extension check happens before read.
    await seedImage("agent-all", "anim.gif");

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "image_crop"
    )?.[0];
    const tool = factory({ agentId: "agent-all" });
    const result = await tool.execute("call-1", {
      source: "anim.gif",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unsupported|extension/i);
  });

  it("rejects filenames containing a NUL byte", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "image_crop"
    )?.[0];
    const tool = factory({ agentId: "agent-all" });
    const result = await tool.execute("call-1", {
      source: "evil\x00.png",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid|filename/i);
  });

  it("rejects when the source filename resolves to a symlink", async () => {
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);

    const uploadsDir = join(workspaceRoot, "agent-all", "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    // Real target outside the uploads dir — symlink defends against an attacker
    // who has write access to the uploads dir but wants to make us read e.g.
    // /etc/passwd through the workspace boundary.
    const realTarget = join(workspaceRoot, "outside-target.png");
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).png().toBuffer();
    writeFileSync(realTarget, png);
    symlinkSync(realTarget, join(uploadsDir, "link.png"));

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "image_crop"
    )?.[0];
    const tool = factory({ agentId: "agent-all" });
    const result = await tool.execute("call-1", {
      source: "link.png",
      x: 0,
      y: 0,
      width: 5,
      height: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/symlink|regular file/i);
  });

  it("PINCHY_IMAGE_MAX_BYTES env var overrides the default size cap", async () => {
    // Set a tiny cap; the seeded PNG (200x100, 3 channels) is several hundred
    // bytes, so a 100-byte cap forces a rejection.
    process.env.PINCHY_IMAGE_MAX_BYTES = "100";
    const api = createMockApi(defaultConfig);
    const { default: plugin } = await import("./index");
    plugin.register!(api as any);
    await seedImage("agent-all", "big.png");

    const factory = mockRegisterTool.mock.calls.find(
      (c: any[]) => c[1]?.name === "image_crop"
    )?.[0];
    const tool = factory({ agentId: "agent-all" });
    const result = await tool.execute("call-1", {
      source: "big.png",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/too large/i);
  });
});
