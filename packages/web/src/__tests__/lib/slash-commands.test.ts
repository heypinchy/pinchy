import { describe, it, expect } from "vitest";
import { parseSlashCommand, SLASH_COMMANDS, type SlashCommandName } from "@/lib/slash-commands";

describe("parseSlashCommand", () => {
  it("parses a bare known command", () => {
    expect(parseSlashCommand("/compact")).toEqual({ name: "compact" });
    expect(parseSlashCommand("/new")).toEqual({ name: "new" });
    expect(parseSlashCommand("/reset")).toEqual({ name: "reset" });
    expect(parseSlashCommand("/help")).toEqual({ name: "help" });
  });

  it("parses a command with an argument", () => {
    expect(parseSlashCommand("/compact now")).toEqual({ name: "compact", arg: "now" });
    expect(parseSlashCommand("/help me please")).toEqual({
      name: "help",
      arg: "me please",
    });
  });

  it("is case-insensitive on the command token", () => {
    expect(parseSlashCommand("/COMPACT")).toEqual({ name: "compact" });
    expect(parseSlashCommand("/Help")).toEqual({ name: "help" });
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseSlashCommand("   /compact   ")).toEqual({ name: "compact" });
    expect(parseSlashCommand("  /compact  now  ")).toEqual({
      name: "compact",
      arg: "now",
    });
  });

  it("returns null for text that does not start with /", () => {
    expect(parseSlashCommand("compact")).toBeNull();
    expect(parseSlashCommand("hello world")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
    expect(parseSlashCommand("   ")).toBeNull();
  });

  it("returns null for an unknown command (sent to the model as normal text)", () => {
    expect(parseSlashCommand("/comp")).toBeNull();
    expect(parseSlashCommand("/path/to/file")).toBeNull();
    expect(parseSlashCommand("/unknown thing")).toBeNull();
  });

  it("returns an empty-arg-less command when the arg is only whitespace", () => {
    expect(parseSlashCommand("/compact   ")).toEqual({ name: "compact" });
  });

  it("covers every command advertised in SLASH_COMMANDS", () => {
    // Guards drift between the parser's known set and the help listing.
    for (const cmd of SLASH_COMMANDS) {
      expect(parseSlashCommand(`/${cmd.name}`)).toEqual({ name: cmd.name });
    }
  });
});

describe("SLASH_COMMANDS", () => {
  it("lists exactly the supported commands", () => {
    const names = SLASH_COMMANDS.map((c) => c.name).sort();
    expect(names).toEqual<SlashCommandName[]>(["compact", "help", "new", "reset"]);
  });

  it("every entry has a non-empty description", () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });
});
