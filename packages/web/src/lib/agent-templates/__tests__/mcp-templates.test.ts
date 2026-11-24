/**
 * Tests for the Phase-1 MCP starter templates (GitHub PR Reviewer, Linear
 * Triage). notion-knowledge-keeper is intentionally NOT ported — Notion has
 * no connectable preset in mcp-presets.ts (OAuth-only, #339), so a template
 * that recommended it would be permanently ungated/uninstantiable.
 */

import { describe, it, expect } from "vitest";
import { githubPrReviewer } from "../mcp/github-pr-reviewer";
import { linearTriage } from "../mcp/linear-triage";
import type { AgentTemplate } from "../types";
import { PERSONALITY_PRESETS } from "@/lib/personality-presets";
import { TEMPLATE_ICON_COMPONENTS } from "@/lib/template-icons";
import { MCP_PRESET_IDS } from "@/lib/integrations/mcp-presets";

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

  // requiresMcpConnection: gates the template on a specific preset, not a
  // boolean — see agent-templates/types.ts for why.
  expect(template.requiresMcpConnection, `${name}: requiresMcpConnection`).toBeDefined();
  expect(MCP_PRESET_IDS, `${name}: requiresMcpConnection preset`).toContain(
    template.requiresMcpConnection
  );

  // recommendedTools present and non-empty
  expect(template.recommendedTools, `${name}: recommendedTools`).toBeDefined();
  expect(template.recommendedTools!.length, `${name}: recommendedTools length`).toBeGreaterThan(0);

  // Each entry has valid preset + tool, and matches requiresMcpConnection
  for (const rt of template.recommendedTools!) {
    expect(MCP_PRESET_IDS, `${name}: preset "${rt.preset}"`).toContain(rt.preset);
    expect(rt.preset, `${name}: recommendedTools preset must match requiresMcpConnection`).toBe(
      template.requiresMcpConnection
    );
    expect(typeof rt.tool, `${name}: tool must be string`).toBe("string");
    expect(rt.tool.length, `${name}: tool must be non-empty`).toBeGreaterThan(0);
  }

  // ── Prompt ⟷ recommendedTools drift guard (bidirectional) ───────────────
  //
  // The tool names in `recommendedTools` are the RAW names the MCP server
  // advertises: they're matched against `connection.data.tools` to mint the
  // grants. The prompt must use those same raw names. It must NOT decorate
  // them with a provider prefix: OpenClaw materializes an MCP tool as
  // `<serverKey>__<rawName>` (nativeMcpToolName), where serverKey is derived
  // per-connection at runtime — so a `github_`-style prefix matches nothing
  // the model can see, and a prompt naming it either gets ignored or invites
  // a hallucinated call. The serverKey is unknowable at template-authoring
  // time, which is exactly why the prompt sticks to the raw suffix; the
  // dynamic per-connection skill (T7) lists the fully materialized names.
  //
  // CONVENTION this guard enforces on MCP template prompts: a backticked bare
  // snake_case identifier means "tool name". Reference request FIELDS either
  // without backticks or inside a larger expression (e.g. `method: "get"`,
  // `owner`, `pullNumber`) so they aren't mistaken for tools.
  const backticked = [...template.defaultAgentsMd!.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  // Bare lower_snake_case with at least one underscore. Written without a
  // nested quantifier — the equivalent /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/ trips
  // eslint's detect-unsafe-regex heuristic (a false positive here, since
  // [a-z0-9]+ can't match "_" so the group partition is unambiguous, but this
  // form is both simpler and provably linear).
  const TOOL_NAME_SHAPE = /^[a-z][a-z0-9_]*_[a-z0-9]+$/;
  const grantedTools = new Set(template.recommendedTools!.map((rt) => rt.tool));

  // Direction 1 — prose ⊇ recommendedTools: every granted tool is named.
  // EXACT (backtick-delimited), not a substring: `.includes("pull_request_read")`
  // is satisfied by "github_pull_request_read", which is how the wrong prefix
  // shipped green in the first place.
  for (const rt of template.recommendedTools!) {
    expect(
      backticked.includes(rt.tool),
      `${name}: defaultAgentsMd must reference granted tool \`${rt.tool}\` exactly (backtick-delimited) — a substring match would also accept a prefixed variant the model can never call`
    ).toBe(true);
  }

  // Direction 2 — prose ⊆ recommendedTools: the prompt names NO tool we don't
  // grant. This is the direction that actually protects the user: telling the
  // model to call something it doesn't have produces a fake tool call in a
  // template that promises "works immediately".
  const promptTools = backticked.filter((t) => TOOL_NAME_SHAPE.test(t));
  const ungranted = [...new Set(promptTools)].filter((t) => !grantedTools.has(t));
  expect(
    ungranted,
    `${name}: defaultAgentsMd names tool-shaped identifiers that are not in recommendedTools: ${ungranted.join(", ")}. The prompt must only name tools the template actually grants (raw server names, no provider prefix).`
  ).toEqual([]);

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

  // defaultStarterPrompts (3-4, see #570 drift guard in agent-templates.test.ts)
  expect(template.defaultStarterPrompts, `${name}: defaultStarterPrompts`).toBeDefined();
  expect(template.defaultStarterPrompts!.length).toBeGreaterThanOrEqual(3);

  // MCP templates do not require Odoo or email connections
  expect(template.requiresOdooConnection, `${name}: requiresOdooConnection`).toBeFalsy();
  expect(template.requiresEmailConnection, `${name}: requiresEmailConnection`).toBeFalsy();

  // defaultSkills stays empty (D6) — dynamic per-connection skills (T7) hang
  // off the connection's granted permissions, not the template.
  expect(template.defaultSkills ?? [], `${name}: defaultSkills`).toEqual([]);
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

  it("requires a github MCP connection", () => {
    expect(githubPrReviewer.requiresMcpConnection).toBe("github");
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

  it("requires a linear MCP connection", () => {
    expect(linearTriage.requiresMcpConnection).toBe("linear");
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

// ---------------------------------------------------------------------------
// notion-knowledge-keeper must not exist
// ---------------------------------------------------------------------------

describe("notion-knowledge-keeper", () => {
  it("is not registered — Notion has no connectable preset in mcp-presets.ts (#339)", async () => {
    const { MCP_TEMPLATES } = await import("../data/mcp-agents");
    expect(Object.keys(MCP_TEMPLATES)).toEqual(["github-pr-reviewer", "linear-triage"]);
    expect(MCP_TEMPLATES["notion-knowledge-keeper"]).toBeUndefined();
  });

  it("'notion' is not a connectable MCP preset", () => {
    expect(MCP_PRESET_IDS).not.toContain("notion");
  });
});
