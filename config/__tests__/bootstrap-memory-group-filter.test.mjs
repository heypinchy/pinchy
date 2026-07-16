import { test } from "node:test";
import assert from "node:assert/strict";

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

test("hook handler: tolerates a non-bootstrap event shape", async () => {
  // Not an agent:bootstrap event (no bootstrapFiles array) — must no-op, not throw.
  await bootstrapMemoryGroupFilterHook({ context: { sessionKey: GROUP_KEY } });
  await bootstrapMemoryGroupFilterHook({});
  await bootstrapMemoryGroupFilterHook(undefined);
});
