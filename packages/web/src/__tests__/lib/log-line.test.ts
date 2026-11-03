import { describe, expect, it } from "vitest";

import { errorLine, LOG_ERROR_MAX, oneLine } from "@/lib/log-line";

/** What turns one log line into two, or reorders one on a terminal. */
const BREAKS_A_LINE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

const PLANTED = "Bericht\n[kb-ingest] Lohnliste.pdf: not converted — FORGED.pdf";

describe("oneLine", () => {
  it("prints whatever would break or reorder a line as its escape", () => {
    expect(oneLine("a\nb\rc\td\u2028e\u202ef\u0085g", 100)).toBe(
      "a\\nb\\rc\\td\\u2028e\\u202ef\\u0085g"
    );
  });

  it("keeps ordinary text as it is, umlauts and quotes included", () => {
    expect(oneLine('Größe "Q3" \\ Bericht.pdf', 100)).toBe('Größe "Q3" \\ Bericht.pdf');
  });

  it("cuts at the bound and marks the cut", () => {
    const out = oneLine("x".repeat(50), 10);
    expect(out).toBe(`${"x".repeat(10)}…`);
  });

  it("never splits an escape at the cut", () => {
    // Nine characters, then an escape two wide: printing half of it would
    // leave a lone backslash that reads as part of the next character.
    expect(oneLine(`${"x".repeat(9)}\nmore`, 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("errorLine", () => {
  it("prints a file-system error naming a planted file as one line that still names it", () => {
    const err = Object.assign(new Error(`EACCES: permission denied, open '/data/hr/${PLANTED}'`), {
      code: "EACCES",
      syscall: "open",
      path: `/data/hr/${PLANTED}`,
    });

    const line = errorLine(err);

    expect(line).not.toMatch(BREAKS_A_LINE);
    expect(line).toContain("EACCES: permission denied");
    expect(line).toContain("Bericht\\n[kb-ingest] Lohnliste.pdf");
    expect(line).toContain("[EACCES]");
    // Where it failed stays for debugging, on the same line.
    expect(line).toMatch(/ — at .*log-line\.test\.ts/);
  });

  it("follows an error's cause, so the reason under a wrapper is kept", () => {
    const err = new Error("Cannot read spreadsheet /data/a.xlsx", {
      cause: new Error(`inner\n${PLANTED}`),
    });

    const line = errorLine(err);

    expect(line).not.toMatch(BREAKS_A_LINE);
    expect(line).toContain(
      "Cannot read spreadsheet /data/a.xlsx — caused by Error: inner\\nBericht"
    );
  });

  it("keeps the detail, hint and position a database error carries", () => {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "t_pkey"'), {
      name: "PostgresError",
      code: "23505",
      detail: "Key (id)=(1) already exists.",
      hint: "Use another id.",
      where: "line 1",
    });
    const line = errorLine(new Error("Failed query: insert into t values (1, 2)", { cause: pg }));
    expect(line).toContain("[23505]");
    expect(line).toContain("Key (id)=(1) already exists.");
    expect(line).toContain("Use another id.");
    expect(line).toContain("line 1");
  });

  it("names the cause before the frames, so a long stack cannot cut it off", () => {
    const err = new Error("outer", { cause: new Error("the cause") });
    err.stack = `Error: outer\n${"    at frame (/a/very/long/path.js:1:1)\n".repeat(200)}`;

    const line = errorLine(err);

    expect(line).toContain("caused by Error: the cause");
    expect(line.length).toBeLessThanOrEqual(LOG_ERROR_MAX + 1);
  });

  it("stays within its bound however long the error is", () => {
    const line = errorLine(new Error(`${"Q".repeat(10_000)}\n${PLANTED}`));
    expect(line.length).toBeLessThanOrEqual(LOG_ERROR_MAX + 1);
    expect(line).not.toMatch(BREAKS_A_LINE);
  });

  it("prints what was thrown when it is not an Error", () => {
    expect(errorLine(`plain\n${PLANTED}`)).not.toMatch(BREAKS_A_LINE);
    expect(errorLine(undefined)).toBe("undefined");
    expect(errorLine({ code: "ENOENT", path: PLANTED })).toContain("ENOENT");
    expect(errorLine({ code: "ENOENT", path: PLANTED })).not.toMatch(BREAKS_A_LINE);
  });
});
