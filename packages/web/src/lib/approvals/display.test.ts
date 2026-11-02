import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { FULL_VIEW_KEYS, displayScalar, splitTruncation, truncationMarker } from "./display";

describe("displayScalar: one rendering per type, so no value passes for another", () => {
  it("renders non-string values as their JSON literal", () => {
    expect(displayScalar(false)).toBe("false");
    expect(displayScalar(1)).toBe("1");
    expect(displayScalar(null)).toBe("null");
  });

  // Odoo reads bool("false") as True, so on a write the two mean opposite
  // things. A string that would read as a literal is shown quoted.
  it.each([
    ["false", '"false"'],
    ["true", '"true"'],
    ["1", '"1"'],
    ["-2.5e3", '"-2.5e3"'],
    ["null", '"null"'],
    ["", '""'],
    ["   ", '"   "'],
    ['"quoted"', '"\\"quoted\\""'],
    ["[1, 2]", '"[1, 2]"'],
    ['{"a":1}', '"{\\"a\\":1}"'],
  ])("quotes the string %j", (value, shown) => {
    expect(displayScalar(value)).toBe(shown);
  });

  it("leaves ordinary text bare", () => {
    expect(displayScalar("Invoice")).toBe("Invoice");
    expect(displayScalar("AT61 1904")).toBe("AT61 1904");
    expect(displayScalar("(empty)")).toBe("(empty)");
  });
});

describe("splitTruncation", () => {
  it("separates the stored truncation marker from the text", () => {
    const text = `${"a".repeat(10)}${truncationMarker(812)}`;
    expect(splitTruncation(text)).toEqual({
      text: "a".repeat(10),
      marker: "… [truncated: 812 more characters not shown]",
    });
  });

  it("leaves text without a marker alone", () => {
    expect(splitTruncation("abc")).toEqual({ text: "abc", marker: null });
  });
});

/**
 * The card never preview-cuts the fields that say WHERE an action lands. Which
 * fields those are is read from the plugins' own tool schemas: every declared
 * parameter whose name says path, file, url, target or destination must be in
 * the set, so a new write tool with such a parameter cannot be shortened on the
 * card unnoticed.
 */
describe("FULL_VIEW_KEYS covers every path- or target-like tool parameter", () => {
  const pluginsDir = resolve(import.meta.dirname, "../../../../plugins");
  const declared = new Set<string>();
  for (const plugin of readdirSync(pluginsDir)) {
    const index = resolve(pluginsDir, plugin, "index.ts");
    if (!existsSync(index)) continue;
    const source = readFileSync(index, "utf8");
    for (const match of source.matchAll(/^\s+([A-Za-z_]+)\s*:\s*\{/gm)) declared.add(match[1]);
  }

  it("found a real corpus of declared parameters", () => {
    expect(declared.size).toBeGreaterThan(40);
    expect(declared).toContain("path");
  });

  it("includes each of them", () => {
    // Third review of #1242: `model` and `ids` decide which records an Odoo
    // write lands on, and were not in the set — the scan now catches id- and
    // model-like names too (`id`, `ids`, `model`, `messageId`, `res_id`, …).
    const targetLike = [...declared].filter(
      (name) =>
        /path|file|url|target|counterpart|destination|model/i.test(name) ||
        /^ids?$|_ids?$|[a-z]Ids?$/.test(name)
    );
    expect(targetLike.length).toBeGreaterThan(3);
    for (const name of targetLike) expect(FULL_VIEW_KEYS, name).toContain(name);
  });

  it("includes the keys that name which record an action lands on", () => {
    for (const key of ["model", "ids", "id", "res_id", "record_id"]) {
      expect(FULL_VIEW_KEYS).toContain(key);
    }
  });

  it("includes every recipient key", () => {
    for (const key of ["to", "cc", "bcc", "from", "reply_to", "recipients"]) {
      expect(FULL_VIEW_KEYS).toContain(key);
    }
  });
});
