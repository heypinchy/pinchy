import { test, expect } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForBraveMock,
  resetBraveMock,
  seedBraveResults,
  getBraveRequests,
  getAdminEmail,
  getAdminPassword,
  login,
  createWebSearchConnection,
  waitForOpenClawConnected,
  pinchyGet,
  pinchyPost,
  pinchyPatch,
  pinchyDelete,
} from "./helpers";
import {
  FAKE_OLLAMA_WEB_SEARCH_TOOL_TRIGGER,
  FAKE_OLLAMA_SKILL_READ_PROBE_TRIGGER,
  FAKE_OLLAMA_SKILL_READ_PROBE_DONE,
  FAKE_OLLAMA_SKILL_READ_PROBE_NO_SKILLS,
  FAKE_OLLAMA_PORT,
  startFakeOllama,
  stopFakeOllama,
} from "../shared/fake-ollama/fake-ollama-server";
import {
  loginViaUI,
  pollAuditForTool,
  seedDefaultProviderToOllama,
  waitForOpenClawStable,
  waitForAgentDispatchable,
} from "../shared/dispatch-probe";
import { stackDbUrl } from "../shared/stack-db";

test.describe("pinchy-web — Brave Search E2E", () => {
  let cookie: string;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(300000);
    await seedSetup();
    await waitForPinchy();
    await waitForBraveMock();
    await resetBraveMock();
    cookie = await login();

    // Wait for OpenClaw to settle after the setup wizard restart before running
    // tests. The setup wizard triggers a full gateway restart (plugins/agents
    // changed); granting tools in the tests triggers another. We wait here so
    // the test-body timeout only covers the second restart, not both.
    const settled = await waitForOpenClawConnected(cookie, 120000);
    if (!settled) throw new Error("OpenClaw did not reconnect after setup wizard");
  });

  test("pinchy-web plugin loads after web-search connection is configured (Sherlock regression)", async () => {
    // This test guards against the staging incident where Dockerfile.pinchy
    // did not COPY pinchy-web, so OpenClaw logged "plugin not found" and
    // the tool was never registered.
    //
    // Proof: if the plugin loaded, OpenClaw can generate config with
    // pinchy-web enabled and stays connected. We verify this by granting
    // the web search tool and confirming OpenClaw remains connected (i.e.
    // the regenerated config was accepted, not rejected with INVALID_CONFIG).

    // Create web-search connection
    const conn = await createWebSearchConnection(cookie);
    const connBody = await conn.text();
    expect(conn.status, connBody).toBe(201);
    const { id: connectionId } = JSON.parse(connBody) as { id: string };

    // Create a fresh shared agent (Smithers is personal — PATCH allowedTools is
    // refused for personal agents with 400. Custom shared agents accept it.)
    const createRes = await pinchyPost(
      "/api/agents",
      { name: `WebSearch-${Date.now()}`, templateId: "custom" },
      cookie
    );
    const createBody = await createRes.text();
    expect(createRes.status, createBody).toBeLessThan(300);
    const { id: agentId } = JSON.parse(createBody) as { id: string };

    // Grant the web search tool to the agent (triggers regenerateOpenClawConfig)
    const patchRes = await pinchyPatch(
      `/api/agents/${agentId}`,
      { allowedTools: ["pinchy_web_search"] },
      cookie
    );
    const patchBody = await patchRes.text();
    expect(patchRes.status, patchBody).toBe(200);

    // Poll OpenClaw until connected (config was hot-reloaded and accepted).
    // Granting pinchy-web adds a new plugin entry — OpenClaw does a full
    // restart. Give 120s to cover the restart + reconnect window.
    const connected = await waitForOpenClawConnected(cookie, 120000);
    expect(connected).toBe(true);

    // The web-search connection is visible in the integrations list
    const integrations = await pinchyGet("/api/integrations", cookie);
    expect(integrations.status).toBe(200);
    const list = (await integrations.json()) as Array<{ type: string; id: string }>;
    const webConn = list.find((c) => c.type === "web-search");
    expect(webConn).toBeDefined();
    expect(webConn!.id).toBe(connectionId);
  });

  test("creating an agent from the Market & News Monitor template succeeds (SKILL.md prod-bundle regression, PR #576)", async () => {
    // Regression guard for PR #576 (fix/skills-md-runtime-path).
    //
    // getSkillBody() in src/lib/skills/index.ts reads SKILL.md off disk to
    // materialize the workspace skill during regenerateOpenClawConfig(). It
    // used to anchor on __dirname — but the Next.js bundler rewrites __dirname
    // to a synthetic "/ROOT/…" path in compiled API routes, so in the
    // PRODUCTION image (this Dockerfile.pinchy E2E job — NOT a dev stack)
    // creating an agent from a skill-bearing template ENOENT'd inside
    // regenerateOpenClawConfig() and POST /api/agents 500'd:
    //   ENOENT … /ROOT/packages/web/src/lib/skills/web-search/SKILL.md
    // Dev/test never caught it (real __dirname there; vitest doesn't bundle).
    // PR #576 re-anchored on process.cwd(). This guard can only bite against
    // the bundled prod image, which is exactly what this job runs.
    //
    // "Market & News Monitor" (templateId "market-monitor") is the only
    // built-in template with defaultSkills: ["web-search"], so creating it is
    // what drives getSkillBody() through the bundled /api/agents route.
    //
    // Relies on this describe's anthropic seed: market-monitor's
    // modelHint (capabilities tools+vision) resolves via resolveAnthropic,
    // which maps tier→model statically and never throws. A seeded provider
    // without those caps would 422 (template_capability_unavailable) instead
    // of the 201/500 this guard checks — keep the seed anthropic.
    const createRes = await pinchyPost(
      "/api/agents",
      { name: `MarketMonitor-${Date.now()}`, templateId: "market-monitor" },
      cookie
    );
    const createBody = await createRes.text();
    // Pre-fix: 500 (ENOENT on the /ROOT/… SKILL.md). Post-fix: 201.
    expect(createRes.status, createBody).toBe(201);
    const agent = JSON.parse(createBody) as { id: string; skills: string[] };

    try {
      // The skill allowlist was seeded from the template — proof the
      // skill-bearing path (not just any create) was exercised.
      expect(agent.skills).toEqual(["web-search"]);

      // And the agent actually persisted (the create wasn't a phantom 201).
      const listRes = await pinchyGet("/api/agents", cookie);
      expect(listRes.status).toBe(200);
      const visible = (await listRes.json()) as Array<{ id: string }>;
      expect(visible.some((a) => a.id === agent.id)).toBe(true);
    } finally {
      // Clean up the shared agent so it doesn't leak into later tests in this
      // file. Note this delete itself regenerates OpenClaw config (deleteAgent
      // → regenerateOpenClawConfig), so it adds a config.apply rather than
      // saving one — the dispatch probe's 60s rate-limit drain below absorbs
      // the create+delete pair.
      await pinchyDelete(`/api/agents/${agent.id}`, cookie);
    }
  });
});

// ── Dispatch probe (pinchy-web plugin coverage) ──────────────────────────────
// Proves pinchy-web loaded correctly and registerTool() worked end-to-end.
// Switches the default provider to fake-Ollama for this describe block only,
// creates a disposable agent with pinchy_web_search allowed, and asserts that
// the fake-LLM trigger results in an audit entry for tool.pinchy_web_search.
test.describe("Web dispatch probe (pinchy-web plugin coverage)", () => {
  let dispatchCookie: string;
  let dispatchConnectionId: string;
  let dispatchAgentId: string;
  let skillAgentId: string;
  let reusedConnection = false;
  let restoreSettings: (() => Promise<void>) | null = null;

  test.beforeAll(async ({}, testInfo) => {
    // 240 s (was 180 s): waitForOpenClawStable now also waits for
    // configPushesPending=0, whose worst case (a config.apply parked across
    // rate-limit windows before the file fallback settles it) adds up to
    // ~100 s before the 30 s stable streak can begin.
    testInfo.setTimeout(240_000);

    // 1. Start fake-Ollama on the host (port 11435).
    await startFakeOllama();

    // 1b. Create the skill-bearing agent while the default provider is still
    //     anthropic. market-monitor (defaultSkills ["web-search"]) needs a
    //     tools+vision model; fake-Ollama advertises no vision, so the create
    //     would 422 after step 3. Its model is moved to fake-Ollama in step 6b.
    //     Created before the drain below, so its config.apply is absorbed too.
    dispatchCookie = await login();
    const skillRes = await pinchyPost(
      "/api/agents",
      { name: `E2E Skill Probe ${Date.now()}`, templateId: "market-monitor" },
      dispatchCookie
    );
    if (skillRes.status !== 201)
      throw new Error(`Skill agent creation failed: ${String(skillRes.status)}`);
    skillAgentId = ((await skillRes.json()) as { id: string }).id;

    // 2. Drain OC's config.apply rate-limit window. Same race the Odoo
    //    dispatch probe hit (see odoo-agent-chat.spec.ts step 2): OC 5.3 allows
    //    ~3 calls per 45 s per (device,IP); tests 1–2 of this suite each
    //    trigger one or two regens, and this probe's POST agent, PATCH
    //    allowedTools and the skill agent's model PATCH would push us past
    //    the cap. The rejected config.apply
    //    falls through to the inotify file-watcher fallback, but an earlier
    //    still-in-flight config.apply succeeds later and overwrites OC's
    //    in-memory state with stale content — agents.list silently loses the
    //    dispatch agent and the chat fires INVALID_REQUEST "unknown agent id".
    //    Run 25936887310 reproduced this exact failure mode at 19:26:54
    //    (rate-limited) → 19:27:27 (unknown agent id) for pinchy_web_search.
    //    Run 26038713754 hit the same race on the Odoo dispatch probe even
    //    with the original 45 s drain — OC's "retry after 9s" indicated the
    //    counter still held stale calls. Bumped to 60 s for a safer margin.
    await new Promise((r) => setTimeout(r, 60_000));

    // 3. Swap default_provider to ollama-local and seed ollama_local_url.
    const dbUrl = process.env.DATABASE_URL || stackDbUrl(5434);
    restoreSettings = await seedDefaultProviderToOllama(dbUrl, FAKE_OLLAMA_PORT);

    // 4. Login (API cookie).
    dispatchCookie = await login();

    // 4. Reuse the existing web-search connection if a previous test left one
    //    (web-search is a singleton — only one per org, see integrations/route.ts).
    //    The "pinchy-web plugin loads" regression test earlier in the file creates
    //    one without afterAll cleanup, so the probe inherits it. Otherwise create
    //    our own.
    const listRes = await pinchyGet("/api/integrations", dispatchCookie);
    if (!listRes.ok) throw new Error(`List integrations failed: ${String(listRes.status)}`);
    const existing = (await listRes.json()) as Array<{ id: string; type: string }>;
    const reusable = existing.find((c) => c.type === "web-search");
    if (reusable) {
      dispatchConnectionId = reusable.id;
      reusedConnection = true;
    } else {
      const connRes = await createWebSearchConnection(dispatchCookie, "E2E Web Dispatch");
      if (connRes.status !== 201)
        throw new Error(`Web connection creation failed: ${String(connRes.status)}`);
      dispatchConnectionId = ((await connRes.json()) as { id: string }).id;
    }

    // 5. Create the dispatch agent.
    const createRes = await pinchyPost(
      "/api/agents",
      { name: "E2E Web Dispatch Probe", templateId: "custom" },
      dispatchCookie
    );
    if (createRes.status !== 201)
      throw new Error(`Agent creation failed: ${String(createRes.status)}`);
    dispatchAgentId = ((await createRes.json()) as { id: string }).id;

    // 6. Allow pinchy_web_search — triggers regenerateOpenClawConfig() which now
    //    reads default_provider=ollama-local and emits the Ollama provider block.
    const patchRes = await pinchyPatch(
      `/api/agents/${dispatchAgentId}`,
      { allowedTools: ["pinchy_web_search"] },
      dispatchCookie
    );
    if (patchRes.status !== 200) throw new Error(`Agent patch failed: ${String(patchRes.status)}`);

    // 6b. Point the skill agent at the fake-Ollama model the dispatch agent
    //     was created with, so its turns reach the probe.
    const dispatchAgentRes = await pinchyGet(`/api/agents/${dispatchAgentId}`, dispatchCookie);
    const { model: ollamaModel } = (await dispatchAgentRes.json()) as { model: string };
    const skillPatchRes = await pinchyPatch(
      `/api/agents/${skillAgentId}`,
      { model: ollamaModel },
      dispatchCookie
    );
    if (skillPatchRes.status !== 200)
      throw new Error(`Skill agent patch failed: ${String(skillPatchRes.status)}`);

    // 7. Wait for OpenClaw to stabilise with the new Ollama config.
    await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", dispatchCookie));

    // 8. Gate on the dispatch agent actually being in OC's hot-loaded
    //    `agents.list` before any test dispatches to it. `waitForOpenClawStable`
    //    above only proves the gateway is connected — NOT that the
    //    fire-and-forget regenerate from the allowedTools PATCH (step 6) has
    //    landed. On a cold-start run the regeneration storm can push the
    //    agents.list apply past POST /api/agents' best-effort 5 s
    //    `waitForAgentInRuntime`, so the first dispatch raced the apply and hit
    //    `invalid agent params: unknown agent id` for longer than the chat
    //    dispatch-race retry budget (CI flake on the 2026.5.28 bump). Polling
    //    OC's live agents.list here closes that window deterministically — the
    //    same gate the Odoo dispatch probe uses.
    await waitForAgentDispatchable(
      (agentId) => pinchyGet(`/api/health/openclaw?agentId=${agentId}`, dispatchCookie),
      dispatchAgentId,
      { deadlineMs: 120_000 }
    );
    // Presence only: the skill agent has been in agents.list since step 1b.
    // Its model PATCH is covered by waitForOpenClawStable (no config push
    // pending), not by this gate.
    await waitForAgentDispatchable(
      (agentId) => pinchyGet(`/api/health/openclaw?agentId=${agentId}`, dispatchCookie),
      skillAgentId,
      { deadlineMs: 120_000 }
    );
  });

  test.afterAll(async () => {
    if (dispatchAgentId) {
      await pinchyDelete(`/api/agents/${dispatchAgentId}`, dispatchCookie);
    }
    if (skillAgentId) {
      await pinchyDelete(`/api/agents/${skillAgentId}`, dispatchCookie);
    }
    // Only delete the connection if we created it ourselves; reusing one left
    // by an earlier test means leaving it alone for any later test in the file.
    if (dispatchConnectionId && !reusedConnection) {
      await pinchyDelete(`/api/integrations/${dispatchConnectionId}`, dispatchCookie);
    }
    if (restoreSettings) await restoreSettings();
    await stopFakeOllama();
  });

  test("pinchy_web_search dispatches via fake-LLM and writes audit entry", async ({
    page,
  }, testInfo) => {
    // 160 s poll past the 150 s chatWithDispatchRaceRetry budget; 180 s per-test
    // timeout to outlast it. See odoo-agent-chat.spec.ts for the measured
    // ~104 s agent-apply delay this covers.
    testInfo.setTimeout(180_000);

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(`${FAKE_OLLAMA_WEB_SEARCH_TOOL_TRIGGER}: search the web`);
    await input.press("Enter");

    const found = await pollAuditForTool(page, {
      toolName: "pinchy_web_search",
      agentId: dispatchAgentId,
      deadlineMs: 160_000,
    });
    expect(found).toBe(true);
  });

  // Round-trip test: prove the plugin actually called brave-mock and used
  // the credentials it fetched through Pinchy's internal API (not a hard-
  // coded constant or an unresolved SecretRef baked into openclaw.json).
  //
  // Previously a `test.skip` with a TODO that said fake-ollama doesn't
  // support tool calls. fake-ollama gained WEB_SEARCH_TRIGGER long ago, so
  // the original blocker is gone — implementing the assertion now.
  test("brave-mock receives actual search request when tool is invoked via chat", async ({
    page,
  }) => {
    // Seed brave-mock with a deterministic result + clear its request log
    // before the chat send, so the assertion can attribute the request to
    // this test and not to anything left over from the dispatch test above.
    await resetBraveMock();
    await seedBraveResults([
      {
        title: "Pinchy probe result",
        url: "https://example.com/probe",
        description: "Seeded for E2E coverage.",
      },
    ]);

    await loginViaUI(page, getAdminEmail(), getAdminPassword());
    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    // Capture `since` BEFORE the dispatch — the previous test
    // ("pinchy_web_search dispatches via fake-LLM and writes audit entry")
    // already wrote a `tool.pinchy_web_search` audit entry on the same
    // agent. Without the filter, pollAuditForTool matches that stale entry
    // and returns true before the new dispatch has actually reached
    // brave-mock, then the request-log assertion races and fails. See
    // run 26289436861.
    const since = new Date().toISOString();
    await input.fill(`${FAKE_OLLAMA_WEB_SEARCH_TOOL_TRIGGER}: round-trip search`);
    await input.press("Enter");

    // Wait for the audit entry first — that confirms the tool was actually
    // dispatched, which means a brave-mock request must have already
    // happened (or imminently will). pollAuditForTool already retries.
    const dispatched = await pollAuditForTool(page, {
      toolName: "pinchy_web_search",
      agentId: dispatchAgentId,
      since,
    });
    expect(dispatched).toBe(true);

    // Now assert the brave-mock saw at least one request, with the apiKey
    // we configured on the connection. If the plugin had embedded a stale
    // placeholder, or — worse — failed to fetch from /api/internal/integ-
    // rations at all, the apiKey would either be empty or wrong.
    const reqs = await getBraveRequests();
    expect(reqs.length, "brave-mock did not receive any search request").toBeGreaterThan(0);
    // `createWebSearchConnection` seeds `apiKey: "test-brave-api-key"` —
    // the plugin must report exactly that value back, which only works if
    // it pulled the live credential through the Pinchy internal API.
    expect(reqs.some((r) => r.apiKey === "test-brave-api-key")).toBe(true);
  });

  // OpenClaw 2026.9 renders its skills section only when the built-in `read`
  // tool is visible, and no Pinchy agent has it — so after that bump no skill
  // reached any agent's prompt. pinchy-files now lists them
  // (skills-prompt.ts) and the agent loads a body with pinchy_read. This reads
  // what OpenClaw actually sent the model, which is the only place the
  // regression shows: nothing fails, the agent just never hears of its skills.
  test("a template agent's skill reaches the model's prompt and its body loads via pinchy_read", async ({
    page,
  }, testInfo) => {
    testInfo.setTimeout(180_000);

    await loginViaUI(page, getAdminEmail(), getAdminPassword());
    await page.goto(`/chat/${skillAgentId}`);
    await expect(page).toHaveURL(`/chat/${skillAgentId}`, { timeout: 10_000 });

    const since = new Date().toISOString();
    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(`${FAKE_OLLAMA_SKILL_READ_PROBE_TRIGGER}: which skills do you have?`);
    await input.press("Enter");

    // The fake model answers DONE once it found a <location> in the prompt and
    // a tool result came back — any result, so the body check below is what
    // proves the read succeeded. Without a skill in the prompt it answers
    // NO_SKILLS right away: wait for either, so that regression fails fast.
    const done = page.getByText(FAKE_OLLAMA_SKILL_READ_PROBE_DONE);
    await expect(done.or(page.getByText(FAKE_OLLAMA_SKILL_READ_PROBE_NO_SKILLS))).toBeVisible({
      timeout: 160_000,
    });
    await expect(done).toBeVisible();

    const res = await fetch(
      `http://127.0.0.1:${FAKE_OLLAMA_PORT}/__pinchy_fake_ollama/last-request-text`
    );
    expect(res.ok).toBe(true);
    const { text } = (await res.json()) as { text: string };
    // The index: exactly one catalog — OpenClaw's own would make two.
    expect(text.match(/<available_skills>/g)).toHaveLength(1);
    expect(text).toContain("<name>web-search</name>");
    expect(text).toContain(`/workspaces/${skillAgentId}/skills/web-search/SKILL.md</location>`);
    // The body, which only the pinchy_read tool result can have carried — a
    // line only web-search's SKILL.md has.
    expect(text).toContain("**Search first, fetch second.**");

    // And the read went through the governed, audited tool.
    const audited = await pollAuditForTool(page, {
      toolName: "pinchy_read",
      agentId: skillAgentId,
      since,
    });
    expect(audited).toBe(true);
  });
});
