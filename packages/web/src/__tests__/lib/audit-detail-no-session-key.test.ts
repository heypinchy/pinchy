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
 * Source-level and cheap on purpose: it finds each `detail: { ... }` literal and
 * flags a `sessionKey` key inside it. (A `user: { id }` naming the *target* of an
 * admin action is fine; the acting user is covered per event in unit tests.)
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

export function leaksUserId(detailBody: string): string | null {
  const body = stripComments(detailBody);
  if (/(^|[\s,{])sessionKey\s*[:,}]|(^|[\s,{])sessionKey\s*$/m.test(body)) return "sessionKey";
  return null;
}

describe("audit detail carries no raw user id (#824)", () => {
  it("scans a real corpus", () => {
    const files = walk(SRC);
    const withDetail = files.filter((f) => detailLiterals(readFileSync(f, "utf8")).length > 0);
    expect(withDetail.length).toBeGreaterThan(40);
  });

  it("no detail literal in src/ names a sessionKey", () => {
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
    expect(leaksUserId("// never mirror sessionKey here\n runId")).toBeNull();
  });
});
