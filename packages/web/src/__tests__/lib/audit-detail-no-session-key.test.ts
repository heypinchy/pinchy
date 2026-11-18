import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Drift guard for #824: an audit row's `detail` is stored verbatim in an
 * immutable, HMAC-chained row that GDPR crypto-erasure cannot reach, so it must
 * never carry the acting user's raw `users.id`. A web-chat session key is
 * `agent:<agentId>:direct:<users.id>[:<chatId>]`, so a `sessionKey` in `detail`
 * is exactly that leak (v0.11 staging: `chat.run_aborted`). Use
 * `auditChatId(sessionKey)` from `@/lib/session-key` for a chat identifier.
 *
 * Source-level and cheap on purpose: it finds each `detail: { ... }` literal,
 * strips the `auditChatId(...)` calls (the one sanctioned use of a session key),
 * and flags any `sessionKey` or `directSessionKey(` left in the body. That also
 * catches the value under a renamed key (`session: run.sessionKey`). (A
 * `user: { id }` naming the *target* of an admin action is fine; the acting user
 * is covered per event in unit tests.)
 *
 * What this does not catch: a detail object built in a variable and passed in
 * (the `Record` in `app/api/internal/audit/tool-use/route.ts`), a spread
 * (`auditPolicyRefusal(...extra)`), a template string that interpolates a key
 * into a value, and any file outside `packages/web/src` such as `server.ts`.
 * Those are covered, where at all, by per-event unit tests; review owns the rest.
 */

const SRC = join(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** The text of every `detail: { ... }` object literal in `source` (brace-matched). */
export function detailLiterals(source: string): string[] {
  const found: string[] = [];
  const re = /\bdetail\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    found.push(source.slice(re.lastIndex, i - 1));
  }
  return found;
}

/** Strips line and block comments so prose about the rule is not read as code. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Removes each `auditChatId(...)` call, parentheses matched, so its argument is not read as a leak. */
function stripAuditChatId(text: string): string {
  let out = "";
  let i = 0;
  const re = /\bauditChatId\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += text.slice(i, m.index);
    let depth = 1;
    let j = re.lastIndex;
    while (j < text.length && depth > 0) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")") depth--;
      j++;
    }
    i = j;
    re.lastIndex = j;
  }
  return out + text.slice(i);
}

export function leaksUserId(detailBody: string): string | null {
  const body = stripAuditChatId(stripComments(detailBody));
  if (/\bdirectSessionKey\s*\(/.test(body)) return "directSessionKey";
  if (/session_?key/i.test(body)) return "sessionKey";
  return null;
}

describe("audit detail names no session key (#824)", () => {
  it("scans a real corpus", () => {
    const files = walk(SRC);
    const withDetail = files.filter((f) => detailLiterals(readFileSync(f, "utf8")).length > 0);
    expect(withDetail.length).toBeGreaterThan(40);
  });

  it("no detail literal in src/ names a session key", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      for (const body of detailLiterals(readFileSync(file, "utf8"))) {
        const leak = leaksUserId(body);
        if (leak) offenders.push(`${relative(SRC, file)}: ${leak}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("recognises the leaking shapes (the guard itself is not a no-op)", () => {
    expect(leaksUserId("agent: { id }, sessionKey, runId")).toBe("sessionKey");
    expect(leaksUserId("agent,\n sessionKey: run.sessionKey,\n runId")).toBe("sessionKey");
    expect(leaksUserId("agent: { id }, chatId: auditChatId(sessionKey)")).toBeNull();
    expect(leaksUserId("agent,\n session: run.sessionKey,\n runId")).toBe("sessionKey");
    expect(leaksUserId("agent,\n key: directSessionKey(agentId, userId)")).toBe("directSessionKey");
    expect(leaksUserId("agent, chatId: auditChatId(run.sessionKey)")).toBeNull();
    expect(leaksUserId("agent, chatId: auditChatId(fn(sessionKey)), runId")).toBeNull();
    expect(leaksUserId("// never mirror sessionKey here\n runId")).toBeNull();
  });
});
