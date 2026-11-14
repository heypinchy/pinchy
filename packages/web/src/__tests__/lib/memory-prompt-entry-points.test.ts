// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import * as sessionKeys from "@/lib/session-key";
import { memoryPromptHook } from "../../../../plugins/pinchy-files/memory-prompt";

/**
 * Every way an agent turn starts must reach the `## Memory` block.
 *
 * It used to ride in the web chat's `extraSystemPrompt` alone, so an agent
 * reached over Telegram, through an email workflow or on a schedule had memory
 * tools and no instructions for them — including, since the 2026.9.2 memory
 * index change, the one not to relay the `openclaw` commands a mismatched
 * index makes `memory_search` print. The block now comes from pinchy-files'
 * `before_prompt_build` hook, which OpenClaw runs for every run whatever
 * started it. These tests pin that, and that nobody brings a per-entry-point
 * copy back.
 */

const AGENT = "a1";
const hook = memoryPromptHook({ [AGENT]: { memory: true } });

function blockFor(sessionKey: string): string | undefined {
  return hook({ prompt: "hi", messages: [] }, { agentId: AGENT, sessionKey })?.appendSystemContext;
}

/**
 * Session keys Pinchy builds itself, one per entry point. Each builder exported
 * from `@/lib/session-key` must be listed — a new builder is a new way of
 * starting a turn, and the guard below fails until someone has looked at it.
 */
const PINCHY_ENTRY_POINTS: Record<string, { entryPoint: string; sessionKey: string }[]> = {
  directSessionKey: [
    { entryPoint: "web chat", sessionKey: sessionKeys.directSessionKey(AGENT, "u1") },
    {
      entryPoint: "web chat, named conversation",
      sessionKey: sessionKeys.directSessionKey(AGENT, "u1", "c1"),
    },
  ],
  inboxSessionKey: [
    {
      entryPoint: "email workflow run",
      sessionKey: sessionKeys.inboxSessionKey(AGENT, "ledger-1"),
    },
  ],
};

/** Session keys OpenClaw builds for the turns it starts itself. */
const OPENCLAW_ENTRY_POINTS = [
  // dmScope "per-peer" with Pinchy's identity links folds a linked Telegram
  // user into their web conversation; an unlinked one keeps its own key.
  { entryPoint: "Telegram DM", sessionKey: `agent:${AGENT}:telegram:direct:42` },
  { entryPoint: "scheduled run (cron)", sessionKey: `agent:${AGENT}:cron:nightly` },
  { entryPoint: "main session / heartbeat", sessionKey: `agent:${AGENT}:main` },
];

describe("the memory block reaches every entry point", () => {
  const all = [...Object.values(PINCHY_ENTRY_POINTS).flat(), ...OPENCLAW_ENTRY_POINTS];

  it.each(all)("$entryPoint", ({ sessionKey }) => {
    const block = blockFor(sessionKey);
    expect(block).toContain("## Memory");
    expect(block).toContain("pinchy_write");
  });

  // A group chat gets the block too — the variant that keeps memory out of a
  // chat other people read, as OpenClaw keeps MEMORY.md out of it.
  it.each([{ entryPoint: "Telegram group", sessionKey: `agent:${AGENT}:telegram:group:-100123` }])(
    "$entryPoint (shared chat)",
    ({ sessionKey }) => {
      const block = blockFor(sessionKey);
      expect(block).toContain("## Memory");
      expect(block).toContain("Don't search or read your memory here");
      expect(block).not.toContain("pinchy_write");
    }
  );

  it("lists every session-key builder in @/lib/session-key", () => {
    const builders = Object.entries(sessionKeys)
      .filter(([name, value]) => typeof value === "function" && name.endsWith("SessionKey"))
      .map(([name]) => name)
      .sort();
    expect(builders.length).toBeGreaterThan(0);
    expect(Object.keys(PINCHY_ENTRY_POINTS).sort()).toEqual(builders);
  });
});

const WEB_SRC = join(import.meta.dirname, "..", "..");

/** Block and line comments out, so prose naming a thing is not the thing. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function productionSources(): { path: string; source: string }[] {
  return readdirSync(WEB_SRC, { recursive: true, encoding: "utf8" })
    .filter((p) => /\.(ts|tsx)$/.test(p))
    .filter((p) => !/(^|\/)(__tests__|test-helpers)\//.test(p) && !/\.test\.tsx?$/.test(p))
    .map((p) => ({
      path: relative(WEB_SRC, join(WEB_SRC, p)),
      source: code(readFileSync(join(WEB_SRC, p), "utf8")),
    }));
}

describe("no entry point carries its own copy", () => {
  const sources = productionSources();

  it("reads a real corpus", () => {
    // Every assertion below is an absence; an empty walk would pass them all.
    expect(sources.length).toBeGreaterThan(200);
  });

  it("the web app neither builds nor imports the memory block", () => {
    // A second copy goes into the same prompt twice on every turn the hook
    // also reaches — which is all of them.
    const offenders = sources
      .filter(
        ({ source }) =>
          /["'`]##\s*Memory\s*["'`\\]/.test(source) ||
          /(from\s+|import\()["'][^"']*memory-prompt["']/.test(source)
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  /**
   * The web app's own places that start an OpenClaw turn. None of them needs to
   * do anything for the memory block — the hook covers it — but a new one
   * should be added here by someone who has read why.
   */
  const TURN_STARTERS = ["lib/email-workflows/run-adapter.ts", "server/client-router.ts"];

  it("knows every place in the web app that starts an agent turn", () => {
    const starters = sources
      .filter(({ source }) => /[cC]lient\.chat\(/.test(source))
      .map(({ path }) => path)
      .sort();
    expect(starters).toEqual(TURN_STARTERS);
  });
});
