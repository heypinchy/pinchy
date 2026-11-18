// @vitest-environment node
/**
 * Unit tests for the shared pinned-target module.
 *
 * Duplicated byte-for-byte into pinchy-email; `plugin-pinned-target-drift.test.ts`
 * in packages/web fails if the copies differ. So this suite covers both copies
 * for as long as that guard passes.
 */
import { describe, it, expect } from "vitest";
import { checkedTarget, pinnedLookup, type PinnedTarget } from "../pinned-target";

describe("checkedTarget", () => {
  it("reads the addresses Pinchy checked for a field, in order, with their family", () => {
    const data = { checkedAddresses: { url: ["203.0.113.7", "2001:db8::7"] } };
    expect(checkedTarget(data, "url")).toEqual([
      { address: "203.0.113.7", family: 4 },
      { address: "2001:db8::7", family: 6 },
    ]);
  });

  it("returns undefined when Pinchy checked nothing for the field", () => {
    expect(checkedTarget({}, "url")).toBeUndefined();
    expect(checkedTarget({ checkedAddresses: {} }, "url")).toBeUndefined();
    expect(checkedTarget({ checkedAddresses: { url: [] } }, "url")).toBeUndefined();
  });

  it("refuses a name where an address belongs — a name would turn the pin back into a lookup", () => {
    expect(() => checkedTarget({ checkedAddresses: { url: ["odoo.example.com"] } }, "url")).toThrow(
      /checked address/
    );
  });

  it("refuses a malformed answer instead of reading it as 'nothing checked'", () => {
    expect(() => checkedTarget({ checkedAddresses: "203.0.113.7" }, "url")).toThrow();
    expect(() => checkedTarget({ checkedAddresses: { url: "203.0.113.7" } }, "url")).toThrow();
    expect(() => checkedTarget({ checkedAddresses: { url: [42] } }, "url")).toThrow();
  });
});

describe("pinnedLookup", () => {
  const target: PinnedTarget = [
    { address: "203.0.113.7", family: 4 },
    { address: "2001:db8::7", family: 6 },
  ];

  it("answers every pinned address when asked for all — the shape Happy Eyeballs needs", async () => {
    const answer = await new Promise((resolve, reject) =>
      pinnedLookup(target)("rebound.example.com", { all: true }, (err, address) =>
        err ? reject(err) : resolve(address)
      )
    );
    expect(answer).toEqual([
      { address: "203.0.113.7", family: 4 },
      { address: "2001:db8::7", family: 6 },
    ]);
  });

  it("answers the first pinned address in the flat form", async () => {
    const answer = await new Promise((resolve, reject) =>
      pinnedLookup(target)("rebound.example.com", {}, (err, address, family) =>
        err ? reject(err) : resolve({ address, family })
      )
    );
    expect(answer).toEqual({ address: "203.0.113.7", family: 4 });
  });

  it("honours a family filter, answering only the matching addresses", async () => {
    const answer = await new Promise((resolve, reject) =>
      pinnedLookup(target)("rebound.example.com", { all: true, family: 6 }, (err, address) =>
        err ? reject(err) : resolve(address)
      )
    );
    expect(answer).toEqual([{ address: "2001:db8::7", family: 6 }]);
  });

  it("fails like a resolver with no answer when the family filter leaves nothing", async () => {
    const v4only: PinnedTarget = [{ address: "203.0.113.7", family: 4 }];
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      pinnedLookup(v4only)("rebound.example.com", { family: 6 }, (e) => resolve(e))
    );
    expect(err?.code).toBe("ENOTFOUND");
  });
});
