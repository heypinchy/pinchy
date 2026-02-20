import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

export const ALLOWED_FILES = ["SOUL.md", "USER.md"] as const;

const DEFAULT_WORKSPACE_BASE_PATH = "/openclaw-config/workspaces";

function getWorkspaceBasePath(): string {
  return process.env.WORKSPACE_BASE_PATH || DEFAULT_WORKSPACE_BASE_PATH;
}

const PLACEHOLDER_CONTENT: Record<string, string> = {
  "SOUL.md": `<!-- Describe your agent's personality here. For example:\nYou are a helpful project manager. You are structured, concise,\nand always keep track of deadlines and action items. -->`,
  "USER.md": `<!-- Add context about your team or organization here. For example:\nWe are a 12-person software team based in Vienna, Austria.\nOur main product is an e-commerce platform built with React and Node.js. -->`,
};

function assertAllowedFile(filename: string): void {
  if (!(ALLOWED_FILES as readonly string[]).includes(filename)) {
    throw new Error(`File not allowed: ${filename}`);
  }
}

export function getWorkspacePath(agentId: string): string {
  return join(getWorkspaceBasePath(), agentId);
}

export function ensureWorkspace(agentId: string): void {
  const workspacePath = getWorkspacePath(agentId);

  mkdirSync(workspacePath, { recursive: true });

  for (const file of ALLOWED_FILES) {
    const filePath = join(workspacePath, file);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, PLACEHOLDER_CONTENT[file], "utf-8");
    }
  }
}

export function readWorkspaceFile(agentId: string, filename: string): string {
  assertAllowedFile(filename);

  const filePath = join(getWorkspacePath(agentId), filename);

  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

export function writeWorkspaceFile(agentId: string, filename: string, content: string): void {
  assertAllowedFile(filename);

  const workspacePath = getWorkspacePath(agentId);

  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }

  writeFileSync(join(workspacePath, filename), content, "utf-8");
}
