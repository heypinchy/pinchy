// The inbox run's result contract (#139): the agent ends its reply with one
// fenced JSON block { status, title, content, outcome? }. parseInboxReport is
// the pure extractor/validator the OpenClaw run adapter uses — it never
// throws; it returns a Result so the adapter can feed the error back to the
// model in a single correction turn before failing the run honestly.
import { describe, it, expect } from "vitest";

import { parseInboxReport } from "@/lib/email-workflows/report";

const validReport = {
  status: "done",
  title: "1 invoice filed",
  content: "Drafted supplier bill for Invoice 4711 in Odoo.",
};

function fenced(json: unknown, lang = "json"): string {
  return "```" + lang + "\n" + JSON.stringify(json, null, 2) + "\n```";
}

describe("parseInboxReport", () => {
  it("extracts a fenced json block after prose", () => {
    const text = `I read the email and filed the invoice.\n\n${fenced(validReport)}`;

    const result = parseInboxReport(text);

    expect(result).toEqual({
      ok: true,
      report: {
        status: "done",
        title: "1 invoice filed",
        content: "Drafted supplier bill for Invoice 4711 in Odoo.",
      },
    });
  });

  it("takes the LAST fenced block when several are present", () => {
    const first = fenced({ status: "no_action", title: "draft", content: "thinking out loud" });
    const last = fenced(validReport);
    const result = parseInboxReport(`${first}\n\nActually, I did file it:\n\n${last}`);

    expect(result.ok && result.report.status).toBe("done");
    expect(result.ok && result.report.title).toBe("1 invoice filed");
  });

  it("accepts a fence without a language tag", () => {
    const result = parseInboxReport(fenced(validReport, ""));
    expect(result.ok).toBe(true);
  });

  it("accepts a bare JSON reply with no fence (correction-turn shape)", () => {
    const result = parseInboxReport(`  ${JSON.stringify(validReport)}  `);
    expect(result.ok && result.report.title).toBe("1 invoice filed");
  });

  it("passes a valid outcome through and strips unknown keys", () => {
    const result = parseInboxReport(
      fenced({
        ...validReport,
        outcome: { odooModel: "account.move", odooId: 7, link: "https://odoo/x", note: "draft" },
        confidence: 0.9, // not part of the contract — must be stripped
      })
    );

    expect(result.ok && result.report.outcome).toEqual({
      odooModel: "account.move",
      odooId: 7,
      link: "https://odoo/x",
      note: "draft",
    });
    expect(result.ok && "confidence" in result.report).toBe(false);
  });

  it("reports no_action", () => {
    const result = parseInboxReport(
      fenced({ status: "no_action", title: "Nothing to file", content: "No invoice attached." })
    );
    expect(result.ok && result.report.status).toBe("no_action");
  });

  it("fails with a schema hint when status is not in the enum", () => {
    const result = parseInboxReport(fenced({ ...validReport, status: "finished" }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/status/);
  });

  it("fails when the title is empty after trimming", () => {
    const result = parseInboxReport(fenced({ ...validReport, title: "   " }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/title/);
  });

  it("fails when there is no JSON anywhere", () => {
    const result = parseInboxReport("I filed the invoice, all good!");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/JSON/i);
  });

  it("fails on malformed JSON inside the fence", () => {
    const result = parseInboxReport('```json\n{ "status": "done", \n```');
    expect(result.ok).toBe(false);
  });

  it("trims title and content", () => {
    const result = parseInboxReport(
      fenced({ status: "done", title: "  spaced  ", content: "  body  " })
    );
    expect(result.ok && result.report.title).toBe("spaced");
    expect(result.ok && result.report.content).toBe("body");
  });

  it("truncates a runaway title and content instead of failing the run", () => {
    const result = parseInboxReport(
      fenced({ status: "done", title: "t".repeat(500), content: "c".repeat(20000) })
    );

    expect(result.ok && result.report.title.length).toBe(200);
    expect(result.ok && result.report.content.length).toBe(8000);
  });
});
