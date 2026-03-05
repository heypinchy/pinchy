import { describe, it, expect, beforeEach } from "vitest";
import { logCapture } from "@/lib/log-capture";

describe("logCapture", () => {
  beforeEach(() => {
    logCapture.clear();
  });

  it("should capture log entries", () => {
    logCapture.add("error", "Something failed");
    const entries = logCapture.getEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("error");
    expect(entries[0].message).toBe("Something failed");
  });

  it("should include a timestamp", () => {
    logCapture.add("warn", "Low disk space");
    const entries = logCapture.getEntries();

    expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("should respect the max entries limit", () => {
    for (let i = 0; i < 200; i++) {
      logCapture.add("error", `Entry ${i}`);
    }
    const entries = logCapture.getEntries();

    expect(entries.length).toBeLessThanOrEqual(100);
    // Should keep the most recent entries
    expect(entries[entries.length - 1].message).toBe("Entry 199");
  });

  it("should format entries as text", () => {
    logCapture.add("error", "DB connection failed");
    logCapture.add("warn", "Retrying in 5s");
    const text = logCapture.formatAsText();

    expect(text).toContain("[ERROR] DB connection failed");
    expect(text).toContain("[WARN] Retrying in 5s");
  });

  it("should return empty string when no entries", () => {
    expect(logCapture.formatAsText()).toBe("");
  });

  it("should clear all entries", () => {
    logCapture.add("error", "Something failed");
    logCapture.clear();

    expect(logCapture.getEntries()).toHaveLength(0);
  });

  it("should install console hooks", () => {
    const originalError = console.error;
    const originalWarn = console.warn;

    logCapture.install();

    console.error("Test error message");
    console.warn("Test warn message");

    const entries = logCapture.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].level).toBe("error");
    expect(entries[0].message).toContain("Test error message");
    expect(entries[1].level).toBe("warn");
    expect(entries[1].message).toContain("Test warn message");

    // Restore original console methods
    console.error = originalError;
    console.warn = originalWarn;
  });

  it("should not double-wrap console methods on repeated install calls", () => {
    const originalError = console.error;

    logCapture.install();
    logCapture.install();
    console.error("Once only");

    const entries = logCapture.getEntries();
    expect(entries.filter((e) => e.message === "Once only")).toHaveLength(1);

    // Restore
    console.error = originalError;
  });

  it("should still call original console methods after install", () => {
    const originalError = console.error;
    const calls: string[] = [];
    console.error = (...args: unknown[]) => calls.push(args.join(" "));

    logCapture.install();
    console.error("Forwarded message");

    expect(calls).toContain("Forwarded message");

    // Restore
    console.error = originalError;
  });
});
