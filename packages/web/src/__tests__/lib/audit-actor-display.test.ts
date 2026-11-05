import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  SYSTEM_ACTOR_LABELS,
  SYSTEM_ACTOR_PREFIX_LABELS,
  resolveActorDisplay,
  systemActorLabel,
  type ActorDisplayInput,
} from "@/lib/audit-actor-display";

function row(overrides: Partial<ActorDisplayInput>): ActorDisplayInput {
  return {
    actorType: "user",
    actorId: "x",
    detail: null,
    actorName: null,
    actorBanned: null,
    actorAgentName: null,
    actorAgentDeletedAt: null,
    ...overrides,
  };
}

describe("resolveActorDisplay (#1271)", () => {
  it("names a user from the joined user row and flags a banned one", () => {
    expect(resolveActorDisplay(row({ actorName: "Alice", actorBanned: true }))).toEqual({
      actorName: "Alice",
      actorDeleted: true,
    });
  });

  it("names an agent from the joined agent row", () => {
    expect(
      resolveActorDisplay(
        row({ actorType: "agent", actorId: "711ed709", actorAgentName: "Musterbau Wissen" })
      )
    ).toEqual({ actorName: "Musterbau Wissen", actorDeleted: false });
  });

  it("flags a soft-deleted agent as deleted but keeps its name", () => {
    expect(
      resolveActorDisplay(
        row({ actorType: "agent", actorAgentName: "Old", actorAgentDeletedAt: new Date() })
      )
    ).toEqual({ actorName: "Old", actorDeleted: true });
  });

  it("never names an agent row after a user that happens to share its id", () => {
    expect(
      resolveActorDisplay(row({ actorType: "agent", actorName: "Alice", actorBanned: true }))
    ).toEqual({ actorName: null, actorDeleted: false });
  });

  it("names an api_key actor from its detail snapshot", () => {
    expect(
      resolveActorDisplay(row({ actorType: "api_key", detail: { apiKey: { name: "CI Deploy" } } }))
        .actorName
    ).toBe("CI Deploy");
  });

  it("gives a known system job its label", () => {
    expect(
      resolveActorDisplay(row({ actorType: "system", actorId: "kb-index-scheduler" })).actorName
    ).toBe("Scheduled reindex");
  });
});

describe("systemActorLabel", () => {
  it("returns null for non-system actors", () => {
    expect(systemActorLabel("user", "upload-gc")).toBeNull();
  });

  it("falls back to the full id for an unknown job rather than nothing", () => {
    expect(systemActorLabel("system", "some-new-job")).toBe("some-new-job");
  });

  it("names a plugin-reported row after the plugin", () => {
    // report-auth-failure writes `plugin:<pluginId>` for an integration's 401s.
    expect(systemActorLabel("system", "plugin:pinchy-odoo")).toBe("Plugin pinchy-odoo");
  });

  it("does not read inherited object keys as labels", () => {
    expect(systemActorLabel("system", "constructor")).toBe("constructor");
  });
});

// Drift guard: every literal actorId a `actorType: "system"` row is written
// with must have a label. A hand-maintained map that mirrors code will be
// wrong (AGENTS.md); this reads the code instead.
describe("SYSTEM_ACTOR_LABELS covers every system actorId in the source", () => {
  const srcRoot = path.resolve(__dirname, "../..");
  // server.ts sits beside src/ and writes system rows of its own.
  const serverEntry = path.resolve(srcRoot, "../server.ts");
  const displaySource = readFileSync(path.join(srcRoot, "lib/audit-actor-display.ts"), "utf8");

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        return entry === "__tests__" || entry === "test-helpers" ? [] : walk(full);
      }
      return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
    });
  }

  // Every way a system actor id is spelled in the tree today: a string
  // literal, a SCREAMING_CASE constant, or a `prefix:${…}` template (the
  // `{ type: "system", id: … }` actor objects in lib/integrations).
  type Found = {
    literals: Map<string, string>;
    constants: Map<string, string>;
    prefixes: Map<string, string>;
  };

  function systemActorIds(): Found {
    const found: Found = { literals: new Map(), constants: new Map(), prefixes: new Map() };
    for (const file of [...walk(srcRoot), serverEntry]) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/(actorType|type):\s*"system"/.test(line)) return;
        const where = `${path.relative(srcRoot, file)}:${i + 1}`;
        // The id sits within a few lines of its type in every call.
        for (const near of lines.slice(Math.max(0, i - 6), i + 7)) {
          const literal = near.match(/(?:actorId|\bid):\s*"([^"]+)"/);
          if (literal) found.literals.set(literal[1], where);
          const constant = near.match(/actorId:\s*([A-Z][A-Z0-9_]+)\b/);
          if (constant) found.constants.set(constant[1], where);
          const prefix = near.match(/(?:actorId|\bid):\s*`([a-z-]+:)\$\{/);
          if (prefix) found.prefixes.set(prefix[1], where);
        }
      });
    }
    return found;
  }

  it("finds a real corpus in every spelling", () => {
    const found = systemActorIds();
    expect(found.literals.size).toBeGreaterThanOrEqual(8);
    expect(found.constants.size).toBeGreaterThanOrEqual(2);
    expect(found.prefixes.size).toBeGreaterThanOrEqual(1);
  });

  it("has a label for each literal id", () => {
    const missing = [...systemActorIds().literals]
      .filter(([id]) => !Object.hasOwn(SYSTEM_ACTOR_LABELS, id))
      .map(([id, where]) => `${id} (${where})`);
    expect(missing, "add these to SYSTEM_ACTOR_LABELS in lib/audit-actor-display.ts").toEqual([]);
  });

  it("has a label for each constant id (the label map imports the constant)", () => {
    const missing = [...systemActorIds().constants]
      .filter(([name]) => !new RegExp(`\\[${name}\\]:`).test(displaySource))
      .map(([name, where]) => `${name} (${where})`);
    expect(missing, "key SYSTEM_ACTOR_LABELS by these constants").toEqual([]);
  });

  it("has a label for each id prefix", () => {
    const missing = [...systemActorIds().prefixes]
      .filter(([prefix]) => !Object.hasOwn(SYSTEM_ACTOR_PREFIX_LABELS, prefix))
      .map(([prefix, where]) => `${prefix} (${where})`);
    expect(missing, "add these to SYSTEM_ACTOR_PREFIX_LABELS").toEqual([]);
  });
});
