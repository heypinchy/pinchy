import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

export const ALLOWED_FILES = ["SOUL.md", "USER.md", "AGENTS.md"] as const;
export type WorkspaceFile = (typeof ALLOWED_FILES)[number];

const DEFAULT_WORKSPACE_BASE_PATH = "/openclaw-config/workspaces";
const DEFAULT_OPENCLAW_WORKSPACE_PREFIX = "/root/.openclaw/workspaces";

function getWorkspaceBasePath(): string {
  return process.env.WORKSPACE_BASE_PATH || DEFAULT_WORKSPACE_BASE_PATH;
}

const PLACEHOLDER_CONTENT: Record<WorkspaceFile, string> = {
  "SOUL.md": `<!-- Describe your agent's personality here. For example:\nYou are a helpful project manager. You are structured, concise,\nand always keep track of deadlines and action items. -->`,
  "USER.md": `<!-- Add context about your team or organization here. For example:\nWe are a 12-person software team based in Vienna, Austria.\nOur main product is an e-commerce platform built with React and Node.js. -->`,
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

export function getOpenClawWorkspacePath(agentId: string): string {
  assertValidAgentId(agentId);
  const prefix = process.env.OPENCLAW_WORKSPACE_PREFIX || DEFAULT_OPENCLAW_WORKSPACE_PREFIX;
  return `${prefix}/${agentId}`;
}

export function ensureWorkspace(agentId: string): void {
  assertValidAgentId(agentId);
  const workspacePath = getWorkspacePath(agentId);

  mkdirSync(workspacePath, { recursive: true });

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
