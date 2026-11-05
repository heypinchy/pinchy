import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  SYSTEM_ACTOR_LABELS,
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

  it("does not read inherited object keys as labels", () => {
    expect(systemActorLabel("system", "constructor")).toBe("constructor");
  });
});

// Drift guard: every literal actorId a `actorType: "system"` row is written
// with must have a label. A hand-maintained map that mirrors code will be
// wrong (AGENTS.md); this reads the code instead.
describe("SYSTEM_ACTOR_LABELS covers every system actorId in the source", () => {
  const srcRoot = path.resolve(__dirname, "../..");

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        return entry === "__tests__" || entry === "test-helpers" ? [] : walk(full);
      }
      return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
    });
  }

  function systemActorIds(): Map<string, string> {
    const found = new Map<string, string>();
    for (const file of walk(srcRoot)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/actorType:\s*"system"/.test(line)) return;
        // The actorId sits within a few lines of its actorType in every call.
        for (const near of lines.slice(Math.max(0, i - 6), i + 7)) {
          const m = near.match(/actorId:\s*"([^"]+)"/);
          if (m) found.set(m[1], `${path.relative(srcRoot, file)}:${i + 1}`);
        }
      });
    }
    return found;
  }

  it("finds a real corpus", () => {
    expect(systemActorIds().size).toBeGreaterThanOrEqual(8);
  });

  it("has a label for each one", () => {
    const missing = [...systemActorIds()]
      .filter(([id]) => !Object.hasOwn(SYSTEM_ACTOR_LABELS, id))
      .map(([id, where]) => `${id} (${where})`);
    expect(missing, "add these to SYSTEM_ACTOR_LABELS in lib/audit-actor-display.ts").toEqual([]);
  });
});
