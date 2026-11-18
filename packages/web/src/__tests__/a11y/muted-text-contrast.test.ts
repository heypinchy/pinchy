import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * `--muted-foreground` is sized to clear WCAG AA (4.5:1) on every surface it
 * sits on — background, card, sidebar, and the muted/accent fills of a hovered
 * or selected row (#1300). Fading it with an opacity modifier
 * (`text-muted-foreground/70`) blends it toward the background and undoes that:
 * the sidebar taglines measured below 4.5:1 on every signed-in page.
 *
 * Text that should read as "quieter than muted" has no compliant colour left,
 * so the rule is simply: muted text is never faded. Borders, fills and icons
 * (`border-muted-foreground/20`, `bg-muted-foreground/15`) are not text and
 * are not covered by the contrast rule, so they stay allowed.
 */
const SRC = path.resolve(__dirname, "../..");
const FADED_MUTED_TEXT = /(?<![\w-])text-muted-foreground\/\d+/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("muted text contrast (#1300)", () => {
  const files = walk(SRC);

  it("reads a real corpus", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("never fades text-muted-foreground with an opacity modifier", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(FADED_MUTED_TEXT)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1} ${m[0]}`);
        }
      });
    }
    expect(
      offenders,
      "use plain text-muted-foreground — it is the faintest AA-compliant text colour"
    ).toEqual([]);
  });

  it("matches the class with a modifier prefix too", () => {
    expect("hover:text-muted-foreground/60".match(FADED_MUTED_TEXT)).toEqual([
      "text-muted-foreground/60",
    ]);
    expect("border-muted-foreground/20".match(FADED_MUTED_TEXT)).toBeNull();
  });
});
