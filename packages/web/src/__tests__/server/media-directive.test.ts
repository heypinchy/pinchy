import { describe, it, expect } from "vitest";
import { createMediaDirectiveFilter, stripMediaDirectives } from "@/server/media-directive";

const PATH = "/root/.openclaw/workspaces/agent-1/workbench/smoke.csv";

describe("stripMediaDirectives", () => {
  it("removes a MEDIA: line, the chip already stands for the file (#1298)", () => {
    expect(stripMediaDirectives(`Here is your file.\nMEDIA:${PATH}\nAnything else?`)).toBe(
      "Here is your file.\nAnything else?"
    );
  });

  it("removes a trailing MEDIA: line without a newline after it", () => {
    expect(stripMediaDirectives(`Here is your file.\n\nMEDIA:${PATH}`)).toBe(
      "Here is your file.\n\n"
    );
  });

  it("removes several directives and indented ones", () => {
    expect(stripMediaDirectives(`Two files:\n  MEDIA:/a.csv\nMEDIA: /b.xlsx\nDone.`)).toBe(
      "Two files:\nDone."
    );
  });

  it("returns an empty string when the reply was only the directive", () => {
    expect(stripMediaDirectives(`MEDIA:${PATH}`)).toBe("");
  });

  it("leaves a MEDIA: line inside a code fence alone", () => {
    const text = "Example:\n```\nMEDIA:/x.csv\n```\nEnd";
    expect(stripMediaDirectives(text)).toBe(text);
  });

  it("leaves prose alone: mid-line mentions and the title-case word", () => {
    const text = "Use the MEDIA:<path> directive.\nMedia: newspapers and radio.";
    expect(stripMediaDirectives(text)).toBe(text);
  });
});

describe("createMediaDirectiveFilter (streaming)", () => {
  function run(chunks: string[]): string {
    const filter = createMediaDirectiveFilter();
    return chunks.map((c) => filter.push(c)).join("") + filter.flush();
  }

  it("strips a directive split across chunks", () => {
    expect(run(["Here it is.\nME", "DIA:/root/.openclaw/", "workspaces/a/smoke.csv\nBye"])).toBe(
      "Here it is.\nBye"
    );
  });

  it("strips a directive that ends the stream", () => {
    expect(run(["Done.\n", "MEDIA:", PATH])).toBe("Done.\n");
  });

  it("emits ordinary text as it arrives instead of holding it", () => {
    const filter = createMediaDirectiveFilter();
    expect(filter.push("Hello")).toBe("Hello");
    expect(filter.push(" world")).toBe(" world");
    expect(filter.push("\nMe")).toBe("\nMe");
    expect(filter.flush()).toBe("");
  });

  it("holds back only a line that could still become a directive", () => {
    const filter = createMediaDirectiveFilter();
    expect(filter.push("Hi\nMED")).toBe("Hi\n");
    expect(filter.push("ICAL advice")).toBe("MEDICAL advice");
  });

  it("respects code fences opened in an earlier chunk", () => {
    expect(run(["```\n", "MEDIA:/x.csv\n", "```\n"])).toBe("```\nMEDIA:/x.csv\n```\n");
  });

  it("produces the same text as the whole-string strip, whatever the chunking", () => {
    const text = `Intro\nMEDIA:${PATH}\n\`\`\`\nMEDIA:/kept\n\`\`\`\nOutro\nMEDIA:/last.csv`;
    const whole = stripMediaDirectives(text);
    for (let size = 1; size <= 7; size++) {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
      expect(run(chunks)).toBe(whole);
    }
  });
});
