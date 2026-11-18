/**
 * The integration reset looks up its ANN-indexed tables once per test file and
 * memoises the answer. Memoising the PROMISE is what makes that cheap, and also
 * what makes it dangerous: a rejected promise cached for the rest of the file
 * turns one transient DB error (a connection reset, a statement timeout under
 * load) into a failure of every later `beforeEach` in that file — dozens of
 * red tests pointing at the reset instead of at the one blip that caused them.
 */
import { describe, it, expect, vi } from "vitest";

// reset-db.ts builds its module-level lookup on the real client; a unit test
// must not open a pool against whatever DATABASE_URL happens to be set.
vi.mock("@/db", () => ({ db: { execute: vi.fn() } }));

import { annTableLookup } from "@/test-helpers/integration/reset-db";

describe("annTableLookup", () => {
  it("asks the database once and serves later calls from the memo", async () => {
    const execute = vi.fn().mockResolvedValue([{ rel: "kb_chunks" }]);
    const lookup = annTableLookup({ execute });

    expect(await lookup()).toEqual(["kb_chunks"]);
    expect(await lookup()).toEqual(["kb_chunks"]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not memoise a failed lookup: the next call asks again", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce([{ rel: "kb_chunks" }]);
    const lookup = annTableLookup({ execute });

    await expect(lookup()).rejects.toThrow("connection reset");
    expect(await lookup()).toEqual(["kb_chunks"]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
