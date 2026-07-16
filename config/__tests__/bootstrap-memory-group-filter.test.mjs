import { test } from "node:test";
import assert from "node:assert/strict";

/** Runs `fn` with console.warn captured; returns the array of warning arg-lists. */
async function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

import {
  isGroupSessionKey,
  filterGroupBootstrap,
  default as bootstrapMemoryGroupFilterHook,
} from "../pinchy-hooks/bootstrap-memory-group-filter/handler.mjs";

/**
 * The hook exists to stop OpenClaw's automatic bootstrap push from injecting a
 * shared agent's `MEMORY.md` into a Telegram GROUP session, where members —
 * who may not even be Pinchy users — would receive knowledge the agent
 * persisted from another user's private DM. See heypinchy/pinchy#369 and the
 * upstream root cause openclaw/openclaw#108881 (filterBootstrapFilesForSession
 * special-cases subagent + cron but not channel-group sessions).
 *
 * DM sessions MUST keep MEMORY.md — the push is correct there. So the whole
 * behaviour is session-key conditional, which is why it lives in a bootstrap
 * hook and not in file layout or per-agent config.
 */

const file = (name) => ({ name, path: `/root/.openclaw/workspaces/a/${name}` });

// Real key shapes observed in production `agent:<id>:sessions` on 2026-07-15.
const GROUP_KEY = "agent:025449c8:telegram:group:-1001234567890";
const DM_KEY = "agent:025449c8:direct:th38ydxfpysofk6sxqyx7ptj3ev4iqib";
const DM_SUB_KEY =
  "agent:025449c8:direct:th38ydxfpysofk6sxqyx7ptj3ev4iqib:982dac45";
const CRON_KEY = "agent:025449c8:cron:a7006f53:run:1f2e";
const SUBAGENT_KEY = "agent:025449c8:subagent:xyz";

test("isGroupSessionKey: true only for a channel group session", () => {
  assert.equal(isGroupSessionKey(GROUP_KEY), true);
  assert.equal(isGroupSessionKey(DM_KEY), false);
  assert.equal(isGroupSessionKey(DM_SUB_KEY), false);
  assert.equal(isGroupSessionKey(CRON_KEY), false);
  assert.equal(isGroupSessionKey(SUBAGENT_KEY), false);
  assert.equal(isGroupSessionKey(undefined), false);
  assert.equal(isGroupSessionKey(""), false);
});

test("filterGroupBootstrap: strips MEMORY.md for a group session", () => {
  const files = [file("AGENTS.md"), file("MEMORY.md"), file("SOUL.md")];
  const out = filterGroupBootstrap(files, GROUP_KEY);
  assert.deepEqual(
    out.map((f) => f.name),
    ["AGENTS.md", "SOUL.md"],
  );
});

test("filterGroupBootstrap: keeps MEMORY.md for a DM session", () => {
  const files = [file("AGENTS.md"), file("MEMORY.md")];
  const out = filterGroupBootstrap(files, DM_KEY);
  assert.deepEqual(
    out.map((f) => f.name),
    ["AGENTS.md", "MEMORY.md"],
  );
});

test("filterGroupBootstrap: group session with no MEMORY.md is unchanged", () => {
  const files = [file("AGENTS.md"), file("SOUL.md")];
  const out = filterGroupBootstrap(files, GROUP_KEY);
  assert.deepEqual(
    out.map((f) => f.name),
    ["AGENTS.md", "SOUL.md"],
  );
});

test("hook handler: reassigns event.context.bootstrapFiles for a group session", async () => {
  const event = {
    context: {
      sessionKey: GROUP_KEY,
      bootstrapFiles: [file("AGENTS.md"), file("MEMORY.md")],
    },
  };
  await bootstrapMemoryGroupFilterHook(event);
  assert.deepEqual(
    event.context.bootstrapFiles.map((f) => f.name),
    ["AGENTS.md"],
  );
});

test("hook handler: leaves a DM session bootstrap untouched", async () => {
  const original = [file("AGENTS.md"), file("MEMORY.md")];
  const event = {
    context: { sessionKey: DM_KEY, bootstrapFiles: original },
  };
  await bootstrapMemoryGroupFilterHook(event);
  assert.deepEqual(
    event.context.bootstrapFiles.map((f) => f.name),
    ["AGENTS.md", "MEMORY.md"],
  );
});

test("hook handler: normal group/DM events run silently (no contract warning)", async () => {
  const groupWarnings = await captureWarnings(() =>
    bootstrapMemoryGroupFilterHook({
      context: {
        sessionKey: GROUP_KEY,
        bootstrapFiles: [file("AGENTS.md"), file("MEMORY.md")],
      },
    }),
  );
  const dmWarnings = await captureWarnings(() =>
    bootstrapMemoryGroupFilterHook({
      context: { sessionKey: DM_KEY, bootstrapFiles: [file("MEMORY.md")] },
    }),
  );
  assert.deepEqual(groupWarnings, []);
  assert.deepEqual(dmWarnings, []);
});

test("hook handler: warns instead of failing open when bootstrapFiles is missing", async () => {
  // We're wired to agent:bootstrap only, so a missing bootstrapFiles array means
  // the OpenClaw event contract changed. A silent no-op would re-open #369, so the
  // handler must surface the anomaly loudly — and still not throw.
  const warnings = await captureWarnings(() =>
    bootstrapMemoryGroupFilterHook({ context: { sessionKey: GROUP_KEY } }),
  );
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /bootstrap-memory-group-filter/);
});

test("hook handler: warns when sessionKey is missing (cannot classify session)", async () => {
  // Without a sessionKey we cannot tell a group from a DM, so we must not filter —
  // but a real bootstrap event always carries one, so its absence is a contract
  // anomaly that must warn rather than silently skip the filter.
  const files = [file("AGENTS.md"), file("MEMORY.md")];
  const event = { context: { bootstrapFiles: files } };
  const warnings = await captureWarnings(() =>
    bootstrapMemoryGroupFilterHook(event),
  );
  assert.equal(warnings.length, 1);
  // Files are left untouched — we cannot safely decide to strip without the key.
  assert.deepEqual(
    event.context.bootstrapFiles.map((f) => f.name),
    ["AGENTS.md", "MEMORY.md"],
  );
});

test("hook handler: stays silent and no-throws on context-less events", async () => {
  const warnings = await captureWarnings(async () => {
    await bootstrapMemoryGroupFilterHook({});
    await bootstrapMemoryGroupFilterHook(undefined);
    await bootstrapMemoryGroupFilterHook({ context: null });
  });
  assert.deepEqual(warnings, []);
});
