import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

// =============================================================================
// Agent on-disk layout — READ THIS before touching any code that resolves an
// agent's filesystem path (watchers, plugins, backup tooling, memory code).
// =============================================================================
//
// A Pinchy agent's files live under `workspaces/<agentId>/`, NOT under the
// OpenClaw-native `agents/<name>/` tree. This is deliberate and has bitten us
// before (see issue #345: the memory-audit watcher hardcoded `agents/<id>/`
// and silently watched the wrong subtree, so it never fired for real agents).
//
// Why `workspaces/<agentId>/`:
//
//   1. Separate Docker volume, separate lifecycle. The `pinchy-workspaces`
//      volume is mounted INTO the OpenClaw config tree at the `workspaces/`
//      subpath. Agent-owned content (SOUL.md, AGENTS.md, uploads/, workbench/,
//      MEMORY.md, memory/) can be backed up, migrated, or sized independently
//      of OpenClaw's core config (openclaw.json, secrets.json, sessions/, the
//      memory SQLite index). You can reset workspaces without touching the
//      OpenClaw trust root.
//
//   2. The SAME volume has two mount points, so paths differ per container:
//        - Pinchy container:   /openclaw-config/workspaces/<agentId>   (WORKSPACE_BASE_PATH)
//        - OpenClaw container:  /root/.openclaw/workspaces/<agentId>   (OPENCLAW_WORKSPACE_PREFIX)
//      `getWorkspacePath()` returns the Pinchy-side path (for code that reads/
//      writes files directly). `getOpenClawWorkspacePath()` returns the path we
//      write into openclaw.json's `agents[].workspace` field (what OpenClaw
//      itself sees). They point at the same bytes via the shared volume.
//
//   3. Namespacing away from OpenClaw-native agents. OpenClaw's own CLI
//      onboarding creates agents under `agents/<name>/`. Pinchy agents are
//      UUID-keyed and live under `workspaces/<uuid>/` so they never collide
//      with or get confused for OpenClaw-native agents.
//
// OpenClaw resolves an agent's MEMORY.md and memory/ files RELATIVE TO the
// `workspace` field — i.e. `workspaces/<agentId>/MEMORY.md`, NOT
// `agents/<agentId>/MEMORY.md`. Any code that needs an agent's on-disk
// location MUST derive it from `getWorkspacePath()` / `getOpenClawWorkspacePath()`.
// Never hardcode `agents/` or `workspaces/` elsewhere — that is exactly the
// drift that produced the dead-code watcher in #345.
// =============================================================================

export const ALLOWED_FILES = ["SOUL.md", "AGENTS.md"] as const;
export type WorkspaceFile = (typeof ALLOWED_FILES)[number];

const DEFAULT_WORKSPACE_BASE_PATH = "/openclaw-config/workspaces";
const DEFAULT_OPENCLAW_WORKSPACE_PREFIX = "/root/.openclaw/workspaces";

// Exported so the memory-audit watcher derives its watch root from the SAME
// source build.ts / ensureWorkspace use for agent file paths — see the layout
// note above and the #345 drift guard in
// __tests__/lib/memory-audit-watcher/watcher-path-drift.test.ts.
export function getWorkspaceBasePath(): string {
  return process.env.WORKSPACE_BASE_PATH || DEFAULT_WORKSPACE_BASE_PATH;
}

const PLACEHOLDER_CONTENT: Record<WorkspaceFile, string> = {
  "SOUL.md": `<!-- Describe your agent's personality here. For example:\nYou are a helpful project manager. You are structured, concise,\nand always keep track of deadlines and action items. -->`,
  "AGENTS.md": `<!-- Define your agent's instructions here. For example:\nYou answer questions about our company's HR policies.\nAlways cite the specific document and section number.\nIf unsure, say so rather than guessing. -->`,
};

function assertAllowedFile(filename: string): asserts filename is WorkspaceFile {
  if (!(ALLOWED_FILES as readonly string[]).includes(filename)) {
    throw new Error(`File not allowed: ${filename}`);
  }
}

function assertValidAgentId(agentId: string): void {
  if (!agentId || agentId.includes("/") || agentId.includes("\\") || agentId.includes("..")) {
    throw new Error(`Invalid agentId: ${agentId}`);
  }
}

export function getWorkspacePath(agentId: string): string {
  assertValidAgentId(agentId);
  return join(getWorkspaceBasePath(), agentId);
}

// Canonical OpenClaw-side path resolver — the path OpenClaw itself sees and
// the value written into openclaw.json's `agents[].workspace`. OpenClaw
// resolves MEMORY.md / memory/ relative to this. See the top-of-file layout
// note: anything that watches or derives agent memory paths MUST use this,
// never a hardcoded `agents/` prefix.
export function getOpenClawWorkspacePath(agentId: string): string {
  assertValidAgentId(agentId);
  const prefix = process.env.OPENCLAW_WORKSPACE_PREFIX || DEFAULT_OPENCLAW_WORKSPACE_PREFIX;
  return `${prefix}/${agentId}`;
}

export function ensureWorkspace(agentId: string): void {
  assertValidAgentId(agentId);
  const workspacePath = getWorkspacePath(agentId);

  mkdirSync(workspacePath, { recursive: true });
  // uploads/ is the user's zone (chat attachments); workbench/ is the
  // agent's writable zone (pinchy_write target). Both must exist on
  // workspace spawn — see #418: lazy creation by the upload endpoint
  // left pinchy_write ENOENT'ing on fresh workspaces.
  mkdirSync(join(workspacePath, "uploads"), { recursive: true });
  mkdirSync(join(workspacePath, "workbench"), { recursive: true });

  for (const file of ALLOWED_FILES) {
    const filePath = join(workspacePath, file);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, PLACEHOLDER_CONTENT[file], "utf-8");
    }
  }
}

export function deleteWorkspace(agentId: string): void {
  assertValidAgentId(agentId);
  const workspacePath = getWorkspacePath(agentId);
  try {
    rmSync(workspacePath, { recursive: true, force: true });
  } catch {
    // Workspace may not exist, that's fine
  }
}

export function readWorkspaceFile(agentId: string, filename: string): string {
  assertValidAgentId(agentId);
  assertAllowedFile(filename);

  const filePath = join(getWorkspacePath(agentId), filename);

  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

export function writeWorkspaceFile(agentId: string, filename: string, content: string): void {
  assertValidAgentId(agentId);
  assertAllowedFile(filename);

  const workspacePath = getWorkspacePath(agentId);

  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }

  writeFileSync(join(workspacePath, filename), content, "utf-8");
}

export function writeWorkspaceFileInternal(
  agentId: string,
  filename: string,
  content: string
): void {
  assertValidAgentId(agentId);

  const workspacePath = getWorkspacePath(agentId);

  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }

  writeFileSync(join(workspacePath, filename), content, "utf-8");
}

// The files OpenClaw loads as prompt-bootstrap context for an agent
// (loadWorkspaceBootstrapFiles in openclaw@2026.5.x). Each is subject to the
// per-file `bootstrapMaxChars` cap and the shared `bootstrapTotalMaxChars`
// budget. Pinchy writes AGENTS.md/SOUL.md/IDENTITY.md/USER.md; the rest are
// included so the sizing stays correct if a fork or future feature adds them.
const BOOTSTRAP_FILENAMES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
] as const;

/**
 * Character sizes of the agent's on-disk bootstrap files (Issue #373). Used by
 * build.ts to emit a per-agent `bootstrapMaxChars` large enough that OpenClaw
 * injects the agent's instructions in full instead of truncating them. Sizes are
 * trimmed char lengths to match OpenClaw's own `content.trimEnd().length`
 * measurement. Missing or empty files are skipped.
 */
export function getAgentBootstrapSizes(agentId: string): number[] {
  assertValidAgentId(agentId);
  const workspacePath = getWorkspacePath(agentId);
  const sizes: number[] = [];

  for (const name of BOOTSTRAP_FILENAMES) {
    const filePath = join(workspacePath, name);
    if (!existsSync(filePath)) continue;
    let content: unknown;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    if (typeof content !== "string") continue;
    const length = content.trimEnd().length;
    if (length > 0) sizes.push(length);
  }

  return sizes;
}

export function generateIdentityContent(agent: { name: string; tagline: string | null }): string {
  const lines = [`# ${agent.name}`];
  if (agent.tagline) lines.push(`> ${agent.tagline}`);
  return lines.join("\n");
}

export function writeIdentityFile(
  agentId: string,
  agent: { name: string; tagline: string | null }
): void {
  assertValidAgentId(agentId);
  const workspacePath = getWorkspacePath(agentId);
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }
  writeFileSync(join(workspacePath, "IDENTITY.md"), generateIdentityContent(agent), "utf-8");
}
