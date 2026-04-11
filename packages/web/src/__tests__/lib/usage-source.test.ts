import { describe, it, expect } from "vitest";
import { classifyUsageSource } from "@/lib/usage-source";

describe("classifyUsageSource", () => {
  it("classifies direct chat sessions as 'chat'", () => {
    expect(classifyUsageSource("agent:smithers:direct:user-1")).toBe("chat");
  });

  it("classifies direct chat sessions with complex userIds as 'chat'", () => {
    expect(classifyUsageSource("agent:abc123:direct:user-with-dashes-42")).toBe("chat");
  });

  it("classifies plugin sessions as 'plugin'", () => {
    expect(classifyUsageSource("plugin:pinchy-files")).toBe("plugin");
  });

  it("classifies other plugin namespaces as 'plugin'", () => {
    expect(classifyUsageSource("plugin:pinchy-audit")).toBe("plugin");
  });

  it("classifies main sessions as 'system'", () => {
    expect(classifyUsageSource("agent:smithers:main")).toBe("system");
  });

  it("classifies cron sessions as 'system'", () => {
    expect(classifyUsageSource("agent:smithers:cron:job-1")).toBe("system");
  });

  it("classifies hook sessions as 'system'", () => {
    expect(classifyUsageSource("agent:smithers:hook:webhook-1")).toBe("system");
  });

  it("classifies unknown formats as 'system'", () => {
    expect(classifyUsageSource("something-else")).toBe("system");
  });

  it("classifies empty string as 'system'", () => {
    expect(classifyUsageSource("")).toBe("system");
  });

  it("does not match partial 'direct' segment in the middle of another word", () => {
    // e.g. a cron session whose job name happens to contain 'direct'
    expect(classifyUsageSource("agent:smithers:cron:direct-deposit")).toBe("system");
  });
});
