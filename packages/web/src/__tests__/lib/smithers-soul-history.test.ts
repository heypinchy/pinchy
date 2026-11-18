import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMITHERS_SOUL_MD } from "@/lib/smithers-soul";
import {
  CURRENT_SOUL_HASH,
  SHIPPED_SOUL_HASHES,
  hashSoul,
  isPristineShippedSoul,
} from "@/lib/smithers-soul-history";
import { readWorkspaceFile, writeWorkspaceFile } from "@/lib/workspace";
import { PERSONALITY_PRESETS } from "@/lib/personality-presets";
import { SOUL_2026_04_09 } from "../fixtures/smithers-soul-2026-04-09";

describe("SHIPPED_SOUL_HASHES drift guard", () => {
  // THE guard. migrateSmithersSoul() only upgrades a SOUL.md whose hash is in
  // this list, so a soul that ships without its hash appended is invisible to
  // the migration forever: users who install that build get a file the next
  // migration cannot prove the provenance of, and it is skipped as "customized"
  // for the rest of time. Appending is not bookkeeping, it is the contract.
  it("pins the last entry to the soul this build ships", () => {
    const actual = hashSoul(SMITHERS_SOUL_MD);
    expect(
      SHIPPED_SOUL_HASHES.at(-1),
      `SMITHERS_SOUL_MD changed. Append this hash as the LAST entry of ` +
        `SHIPPED_SOUL_HASHES in lib/smithers-soul-history.ts:\n\n  "${actual}",\n`
    ).toBe(actual);
  });

  it("exposes the current hash as CURRENT_SOUL_HASH", () => {
    expect(CURRENT_SOUL_HASH).toBe(hashSoul(SMITHERS_SOUL_MD));
  });

  it("has no duplicate entries", () => {
    // A duplicate means the generator counted one soul twice; harmless at
    // runtime but a sign the list was hand-edited rather than appended to.
    expect(new Set(SHIPPED_SOUL_HASHES).size).toBe(SHIPPED_SOUL_HASHES.length);
  });

  it("stores every entry in the sha256:hex shape the diagnostics collector uses", () => {
    for (const h of SHIPPED_SOUL_HASHES) {
      expect(h).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  it("covers the whole shipped history, oldest first", () => {
    // 25 distinct souls between 2026-02-20 (fef013ef) and 2026-05-19 (806cbed1).
    // The count is asserted so that a rebase or bad merge dropping entries is
    // loud rather than silently shrinking the migration's reach.
    expect(SHIPPED_SOUL_HASHES.length).toBeGreaterThanOrEqual(25);
    // The first soul ever shipped — the one that opened with "You know the
    // Pinchy platform inside out".
    expect(SHIPPED_SOUL_HASHES[0]).toBe(
      "sha256:91fc60b2f9c0b2b5ad2dc774e69fd76e6628477aa3850ae73f1584f03019b766"
    );
  });
});

describe("isPristineShippedSoul", () => {
  it("recognizes the current soul", () => {
    expect(isPristineShippedSoul(SMITHERS_SOUL_MD)).toBe(true);
  });

  it("recognizes a real historical soul", () => {
    // The actual 2026-04-09 soul (e53fb7e4), byte-identical to what shipped —
    // not just its hash. This is the call the migration makes on a pre-April
    // install, so it is worth making it for real.
    expect(isPristineShippedSoul(SOUL_2026_04_09)).toBe(true);
  });

  it("covers the 2026-04-15 soul that live installs still carry", () => {
    // Verified by hash on staging and demo (2026-07-15): the Smithers on both
    // still runs e73a13f5's soul. No fixture for it — the hash IS what the
    // migration matches on, so pinning the hash is the whole assertion.
    expect(SHIPPED_SOUL_HASHES).toContain(
      "sha256:fac4cbf250a79bce3730438372bfbc331b42544338eac2387ed64a599e4066db"
    );
  });

  it("rejects a customized soul", () => {
    expect(isPristineShippedSoul(SMITHERS_SOUL_MD + "\nBe extra polite.\n")).toBe(false);
  });

  it("rejects a soul that differs by a single trailing newline", () => {
    // Documents the deliberate no-normalization choice: raw bytes only. A user
    // whose editor added a newline is treated as customized and skipped, which
    // is the safe direction — we never clobber an edit, we only miss a case.
    expect(isPristineShippedSoul(SMITHERS_SOUL_MD + "\n")).toBe(false);
  });

  it("rejects empty content", () => {
    expect(isPristineShippedSoul("")).toBe(false);
  });
});

describe("collision safety against the other souls Pinchy ships", () => {
  // migrateSmithersSoul() asks nothing about the agent row — it matches OUR
  // TEXT by hash, wherever it sits. That is only safe while no other soul
  // Pinchy ships can hash into SHIPPED_SOUL_HASHES.
  //
  // Personality presets are the one other shipped set, and the two are closer
  // than they look: `the-butler`'s soulMd already shares whole paragraphs with
  // Smithers' ("You are unfailingly polite, attentive, and eager to help..."),
  // and createSmithersAgent stamps `personalityPresetId: "the-butler"` onto
  // Smithers itself. They are maintained in different files and drift
  // independently.
  //
  // So the realistic break is mundane, not exotic: someone adds a preset by
  // starting from SMITHERS_SOUL_MD as a template, or edits one until it
  // converges. From the next boot on, every agent using that preset silently
  // has its SOUL.md replaced with Smithers' — with an audit row claiming a
  // "Pinchy-shipped soul upgraded". Nothing else in the suite would notice.
  it("never collides with a personality preset's soul", () => {
    for (const [id, preset] of Object.entries(PERSONALITY_PRESETS)) {
      expect(
        isPristineShippedSoul(preset.soulMd),
        `Preset "${id}" hashes into SHIPPED_SOUL_HASHES, so migrateSmithersSoul() ` +
          `would overwrite the SOUL.md of every agent using it on the next boot. ` +
          `Do not derive a preset from SMITHERS_SOUL_MD — give it its own text.`
      ).toBe(false);
    }
  });
});

describe("hash integrity across a real workspace round trip", () => {
  // migrateSmithersSoul's unit tests mock @/lib/workspace, so nothing else here
  // proves the load-bearing assumption of the whole design: that the bytes
  // writeWorkspaceFile puts on disk are the bytes readWorkspaceFile hands back,
  // unchanged. If either ever gained normalization — a trailing-newline fixer,
  // a CRLF pass — every shipped hash would stop matching and the migration
  // would silently classify every soul as customized and upgrade nothing, for
  // good. That failure is invisible: no error, no test failure, just a sweep
  // that quietly does nothing. Hence a real filesystem here.
  let base: string | undefined;
  const previousBase = process.env.WORKSPACE_BASE_PATH;

  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
    base = undefined;
    if (previousBase === undefined) delete process.env.WORKSPACE_BASE_PATH;
    else process.env.WORKSPACE_BASE_PATH = previousBase;
  });

  const roundTrip = (content: string): string => {
    base = mkdtempSync(join(tmpdir(), "pinchy-soul-"));
    process.env.WORKSPACE_BASE_PATH = base;
    writeWorkspaceFile("agent-1", "SOUL.md", content);
    return readWorkspaceFile("agent-1", "SOUL.md");
  };

  it("preserves the current soul byte-for-byte", () => {
    const read = roundTrip(SMITHERS_SOUL_MD);

    expect(read).toBe(SMITHERS_SOUL_MD);
    expect(hashSoul(read)).toBe(CURRENT_SOUL_HASH);
  });

  it("preserves a historical soul, non-ASCII and all", () => {
    // The souls carry em-dashes and typographic quotes. A round trip through a
    // wrong encoding would mangle exactly those and nothing else.
    expect(SOUL_2026_04_09).toMatch(/[—’]/);

    const read = roundTrip(SOUL_2026_04_09);

    expect(read).toBe(SOUL_2026_04_09);
    expect(isPristineShippedSoul(read)).toBe(true);
    expect(hashSoul(read)).toBe(
      "sha256:e56305f854afb99d5156a7529ad5cba6717a9fc68b15f29c02beaf6df5bb7950"
    );
  });
});
