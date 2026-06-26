/**
 * Tests for Task 8.2: Phase-1 MCP starter templates
 * (GitHub PR Reviewer, Notion Knowledge Keeper, Linear Triage)
 */

import { describe, it, expect } from "vitest";
import { githubPrReviewer } from "../mcp/github-pr-reviewer";
import { notionKnowledgeKeeper } from "../mcp/notion-knowledge-keeper";
import { linearTriage } from "../mcp/linear-triage";
import type { AgentTemplate } from "../types";
import { PERSONALITY_PRESETS } from "@/lib/personality-presets";
import { TEMPLATE_ICON_COMPONENTS } from "@/lib/template-icons";
import { getMcpPreset } from "@/lib/integrations/mcp-presets";

// ---------------------------------------------------------------------------
// Shared invariant helper
// ---------------------------------------------------------------------------

function assertMcpTemplate(template: AgentTemplate, name: string): void {
  // Required fields
  expect(template.name, `${name}: name`).toBeTruthy();
  expect(template.description, `${name}: description`).toBeTruthy();
  expect(template.defaultAgentsMd, `${name}: defaultAgentsMd`).toBeTruthy();
  expect(template.defaultAgentsMd!.length, `${name}: defaultAgentsMd length`).toBeGreaterThan(100);

  // MCP templates have no Pinchy plugin (they use external MCP connections)
  expect(template.pluginId, `${name}: pluginId should be null`).toBeNull();

  // recommendedTools present and non-empty
  expect(template.recommendedTools, `${name}: recommendedTools`).toBeDefined();
  expect(template.recommendedTools!.length, `${name}: recommendedTools length`).toBeGreaterThan(0);

  // Each entry has valid preset + tool
  for (const rt of template.recommendedTools!) {
    expect(["github", "notion", "linear", "generic"], `${name}: preset "${rt.preset}"`).toContain(
      rt.preset
    );
    expect(typeof rt.tool, `${name}: tool must be string`).toBe("string");
    expect(rt.tool.length, `${name}: tool must be non-empty`).toBeGreaterThan(0);
  }

  // Drift guard: every recommended tool MUST be referenced in the agent's
  // instructions. The 2026-06 Merlin breakage shipped because the template's
  // tool names (and the prose telling the model to call them) had drifted from
  // the GitHub MCP server's renamed tools — the agent then improvised a fake
  // tool call. This is the cheap internal-consistency layer (prose ⊇
  // recommendedTools); the template↔live-server contract is verified by the
  // MCP E2E catalog check.
  for (const rt of template.recommendedTools!) {
    expect(
      template.defaultAgentsMd!.includes(rt.tool),
      `${name}: defaultAgentsMd must reference recommended tool "${rt.tool}" — instructions and recommendedTools must not drift`
    ).toBe(true);
  }

  // Exposed-name guard: OpenClaw registers MCP tools as `${preset.toolPrefix}${tool}`
  // (e.g. github_pull_request_read), so the AGENTS.md must name the PREFIXED tool.
  // Instructing the bare name makes the model call a tool that "isn't available"
  // (the 2026-06 incident: prose said pull_request_read, the model saw only
  // github_pull_request_read). Only checkable for presets in the registry; an
  // unregistered preset (notion is deferred) falls back to "generic" → skipped.
  for (const rt of template.recommendedTools!) {
    const preset = getMcpPreset(rt.preset);
    if (preset.id !== rt.preset) continue;
    const exposed = `${preset.toolPrefix}${rt.tool}`;
    expect(
      template.defaultAgentsMd!.includes(exposed),
      `${name}: defaultAgentsMd must reference the exposed tool name "${exposed}" (toolPrefix + tool) — the model can only call the prefixed name`
    ).toBe(true);
  }

  // modelHint present with valid tier
  expect(template.modelHint, `${name}: modelHint`).toBeDefined();
  expect(template.modelHint!.tier, `${name}: tier`).toMatch(/^(fast|balanced|reasoning)$/);

  // Personality references an existing preset
  expect(
    PERSONALITY_PRESETS[template.defaultPersonality],
    `${name}: defaultPersonality`
  ).toBeDefined();

  // iconName resolves to a real icon
  expect(template.iconName, `${name}: iconName`).toBeDefined();
  expect(TEMPLATE_ICON_COMPONENTS[template.iconName!], `${name}: iconName resolves`).toBeDefined();
  // Bot is the fallback — shipping templates must not use it
  expect(template.iconName, `${name}: iconName should not be Bot`).not.toBe("Bot");

  // suggestedNames (at least 5)
  expect(template.suggestedNames, `${name}: suggestedNames`).toBeDefined();
  expect(template.suggestedNames!.length, `${name}: suggestedNames length`).toBeGreaterThanOrEqual(
    5
  );

  // defaultTagline
  expect(template.defaultTagline, `${name}: defaultTagline`).toBeTruthy();

  // defaultGreetingMessage
  expect(template.defaultGreetingMessage, `${name}: defaultGreetingMessage`).toBeTruthy();

  // MCP templates do not require Odoo or email connections
  expect(template.requiresOdooConnection, `${name}: requiresOdooConnection`).toBeFalsy();
  expect(template.requiresEmailConnection, `${name}: requiresEmailConnection`).toBeFalsy();
}

// ---------------------------------------------------------------------------
// GitHub PR Reviewer
// ---------------------------------------------------------------------------

describe("githubPrReviewer template", () => {
  it("has the expected name and description", () => {
    expect(githubPrReviewer.name).toBe("GitHub PR Reviewer");
    expect(githubPrReviewer.description).toBeTruthy();
  });

  it("passes all MCP template invariants", () => {
    assertMcpTemplate(githubPrReviewer, "githubPrReviewer");
  });

  it("recommends GitHub tools only", () => {
    for (const rt of githubPrReviewer.recommendedTools!) {
      expect(rt.preset).toBe("github");
    }
  });

  it("recommends the current GitHub MCP PR tools (read, list, review-write)", () => {
    // The GitHub MCP server consolidated/renamed its PR tools: the old
    // get_pull_request / list_pull_request_files / create_review no longer
    // exist. Pin the current names so a future rename is caught here.
    const toolNames = githubPrReviewer.recommendedTools!.map((rt) => rt.tool);
    expect(toolNames).toContain("pull_request_read");
    expect(toolNames).toContain("list_pull_requests");
    expect(toolNames).toContain("pull_request_review_write");
  });

  it("defaultAgentsMd covers code review topics", () => {
    expect(githubPrReviewer.defaultAgentsMd).toMatch(/review|pull request|code/i);
  });

  it("modelHint requests tools capability", () => {
    expect(githubPrReviewer.modelHint!.capabilities).toContain("tools");
  });
});

// ---------------------------------------------------------------------------
// Notion Knowledge Keeper
// ---------------------------------------------------------------------------

describe("notionKnowledgeKeeper template", () => {
  it("has the expected name and description", () => {
    expect(notionKnowledgeKeeper.name).toBe("Notion Knowledge Keeper");
    expect(notionKnowledgeKeeper.description).toBeTruthy();
  });

  it("passes all MCP template invariants", () => {
    assertMcpTemplate(notionKnowledgeKeeper, "notionKnowledgeKeeper");
  });

  it("recommends Notion tools only", () => {
    for (const rt of notionKnowledgeKeeper.recommendedTools!) {
      expect(rt.preset).toBe("notion");
    }
  });

  it("includes search, get_page, and update_page", () => {
    const toolNames = notionKnowledgeKeeper.recommendedTools!.map((rt) => rt.tool);
    expect(toolNames).toContain("search");
    expect(toolNames).toContain("get_page");
    expect(toolNames).toContain("update_page");
  });

  it("defaultAgentsMd covers knowledge management topics", () => {
    expect(notionKnowledgeKeeper.defaultAgentsMd).toMatch(/knowledge|notion|page/i);
  });

  it("modelHint requests tools capability", () => {
    expect(notionKnowledgeKeeper.modelHint!.capabilities).toContain("tools");
  });
});

// ---------------------------------------------------------------------------
// Linear Triage
// ---------------------------------------------------------------------------

describe("linearTriage template", () => {
  it("has the expected name and description", () => {
    expect(linearTriage.name).toBe("Linear Triage");
    expect(linearTriage.description).toBeTruthy();
  });

  it("passes all MCP template invariants", () => {
    assertMcpTemplate(linearTriage, "linearTriage");
  });

  it("recommends Linear tools only", () => {
    for (const rt of linearTriage.recommendedTools!) {
      expect(rt.preset).toBe("linear");
    }
  });

  it("includes create_issue, update_issue, and list_issues", () => {
    const toolNames = linearTriage.recommendedTools!.map((rt) => rt.tool);
    expect(toolNames).toContain("create_issue");
    expect(toolNames).toContain("update_issue");
    expect(toolNames).toContain("list_issues");
  });

  it("defaultAgentsMd covers issue triage topics", () => {
    expect(linearTriage.defaultAgentsMd).toMatch(/triage|issue|priorit/i);
  });

  it("modelHint requests tools capability", () => {
    expect(linearTriage.modelHint!.capabilities).toContain("tools");
  });
});
