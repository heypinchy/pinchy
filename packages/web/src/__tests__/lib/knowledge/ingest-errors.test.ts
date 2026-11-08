import { describe, expect, it } from "vitest";
import { EmbedderUnavailableError } from "@/lib/knowledge/embeddings";
import { systemicIngestError } from "@/lib/knowledge/ingest-errors";

function withCode(code: string, message = `failed with ${code}`) {
  return Object.assign(new Error(message), { code });
}

// #1380: everything that goes wrong with ONE file costs that file; only these
// stop the run, because they would fail every file after it the same way.
describe("systemicIngestError", () => {
  it.each([
    ["08006", "connection failure"],
    ["08001", "cannot connect"],
    ["57P01", "admin shutdown"],
    ["57014", "query canceled"],
    ["53100", "disk full"],
    ["53300", "too many connections"],
    ["58030", "I/O error"],
  ])("stops the run on SQLSTATE %s (%s)", (code) => {
    const err = withCode(code);
    expect(systemicIngestError(err)).toBe(err);
  });

  it.each([
    "CONNECTION_CLOSED",
    "CONNECTION_ENDED",
    "CONNECTION_DESTROYED",
    "CONNECT_TIMEOUT",
    "ECONNREFUSED",
    "ECONNRESET",
  ])("stops the run on %s", (code) => {
    const err = withCode(code);
    expect(systemicIngestError(err)).toBe(err);
  });

  it("finds the systemic error behind the query builder's wrapper", () => {
    const inner = withCode("08006");
    const wrapped = new Error("Failed query: insert … params: secret text", { cause: inner });
    expect(systemicIngestError(wrapped)).toBe(inner);
  });

  it("stops the run when the embedder is unavailable", () => {
    const err = new EmbedderUnavailableError("model failed to load");
    expect(systemicIngestError(err)).toBe(err);
  });

  it("stops the run when the job was aborted", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(systemicIngestError(err)).toBe(err);
  });

  it.each([
    ["an input the embedder refuses", new Error("Input is longer than the context size")],
    ["a value Postgres refuses", withCode("22021")],
    ["a row too large", withCode("54000")],
    ["a constraint violation", withCode("23505")],
    ["a staging copy that does not fit on the disk", withCode("ENOSPC")],
    ["a corrupt PDF", new Error("Invalid PDF structure")],
    ["a missing file", withCode("ENOENT")],
    ["a non-error", "boom"],
  ])("lets %s cost only its file", (_label, err) => {
    expect(systemicIngestError(err)).toBeNull();
  });

  it("does not loop on a cyclic cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(systemicIngestError(a)).toBeNull();
  });
});
