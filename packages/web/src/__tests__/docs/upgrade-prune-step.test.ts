import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const repoRoot = resolve(__dirname, "../../../../..");
const upgradingPath = resolve(repoRoot, "docs/src/content/docs/guides/upgrading.mdx");
const vpsDeploymentPath = resolve(repoRoot, "docs/src/content/docs/guides/vps-deployment.mdx");
const hardeningPath = resolve(repoRoot, "docs/src/content/docs/guides/hardening.mdx");

const upgrading = readFileSync(upgradingPath, "utf-8");
const vpsDeployment = readFileSync(vpsDeploymentPath, "utf-8");
const hardening = readFileSync(hardeningPath, "utf-8");

function sectionBetween(source: string, startRegex: RegExp, endRegex: RegExp): string | undefined {
  const start = source.split(startRegex)[1];
  if (!start) return undefined;
  return start.split(endRegex)[0];
}

describe("upgrade flow includes Docker image disk-hygiene step (#370)", () => {
  it("Standard upgrade section in upgrading.mdx references `docker image prune`", () => {
    // Regression guard for #370: a long-running deployment that follows the
    // documented upgrade flow must not accumulate dangling <none>:<none>
    // layers across version bumps. The Standard upgrade section is the
    // canonical reference; if prune drops out of here, staging fills up again.
    const standardUpgrade = sectionBetween(upgrading, /^##\s+Standard upgrade\s*$/m, /^##\s+/m);
    expect(standardUpgrade, "Standard upgrade section not found").toBeDefined();
    expect(standardUpgrade!).toMatch(/docker image prune\b/);
  });

  it("Standard upgrade's fenced code blocks use dangling-only prune (`-f`), not aggressive `-a -f`", () => {
    // The default flow runs on a deployment that may have other tagged
    // images in use (e.g. user-pulled debug images). `-a -f` would remove
    // any image not associated with a running container, which is too
    // invasive for a documented happy path. The aggressive variant is
    // covered in its own opt-in prose note (which DOES mention `-a -f`
    // — that's fine; we only check the runnable code).
    const standardUpgrade = sectionBetween(upgrading, /^##\s+Standard upgrade\s*$/m, /^##\s+/m);
    expect(standardUpgrade, "Standard upgrade section not found").toBeDefined();
    const fencedBlocks = [...standardUpgrade!.matchAll(/```(?:bash|sh)?[\s\S]*?```/g)].map(
      (m) => m[0]
    );
    const pruneInvocations = fencedBlocks.flatMap(
      (block) => block.match(/docker image prune[^\n]*/g) ?? []
    );
    expect(pruneInvocations.length).toBeGreaterThan(0);
    for (const invocation of pruneInvocations) {
      expect(invocation).not.toMatch(/-a\b/);
    }
  });

  it("Upgrading guide documents when to escalate to `docker image prune -a -f`", () => {
    // Acceptance criterion: "Upgrading guide covers when manual `prune -a`
    // is appropriate vs. the default `prune`." We scope the rationale check
    // to the `<Aside>` block that actually contains the `-a -f` invocation,
    // so a refactor that empties the aside but leaves the keyword "version"
    // sitting in some unrelated section heading can't trick the test into
    // passing.
    //
    // We collapse whitespace before matching because prettier wraps long
    // prose lines — `docker image prune -a -f` typically gets broken as
    // `docker image\n     prune -a -f` across two lines, which a literal-
    // space regex misses. Normalizing keeps the assertion stable across
    // prettier re-flows.
    const collapse = (s: string) => s.replace(/\s+/g, " ");
    expect(collapse(upgrading)).toMatch(/docker image prune -a -f\b/);
    const asides = [...upgrading.matchAll(/<Aside\b[\s\S]*?<\/Aside>/g)].map((m) => m[0]);
    const escalationAside = asides.find((block) =>
      /docker image prune -a -f\b/.test(collapse(block))
    );
    expect(escalationAside, "escalation Aside block not found").toBeDefined();
    expect(collapse(escalationAside!).toLowerCase()).toMatch(
      /\b(tagged|pinned|rollback|roll back)\b/
    );
  });

  it("latest version-specific upgrade one-liner pipes through prune", () => {
    // The newest upgrade-notes section must show the same hygiene step as the
    // Standard upgrade flow so copy-paste deployments stay consistent. The
    // anchor is the FIRST `## Upgrading from …` heading — sections are listed
    // newest-first — whether it still carries the `%%PINCHY_VERSION%%`
    // placeholder (mid-development) or was frozen to a concrete version by the
    // release script's auto-finalize step (right after a release). Anchoring on
    // the placeholder alone broke on every release commit, when the current
    // section has just been frozen and no placeholder section exists yet.
    const currentSection = sectionBetween(
      upgrading,
      /^##\s+Upgrading from v[\d.]+ to (?:v[\d.]+|%%PINCHY_VERSION%%)\s*$/m,
      /^##\s+Upgrading from /m
    );
    expect(currentSection, "current-version upgrade section not found").toBeDefined();
    expect(currentSection!).toMatch(/docker image prune\b/);
  });

  it("VPS deployment guide's Updating section runs prune after `up -d`", () => {
    // vps-deployment.mdx duplicates the canonical upgrade snippet for users
    // who never click through to the upgrading guide. Same hygiene must apply.
    const updating = sectionBetween(vpsDeployment, /^##\s+Updating Pinchy\s*$/m, /^##\s+/m);
    expect(updating, "Updating Pinchy section not found").toBeDefined();
    expect(updating!).toMatch(/docker image prune\b/);
  });

  it("hardening guide's Docker image updates section runs prune", () => {
    // The hardening guide's "Update strategy" snippet is the one ops teams
    // crib from. Without prune here, hardened deployments still bloat.
    const updateStrategy = sectionBetween(
      hardening,
      /^###\s+Docker image updates\s*$/m,
      /^###\s+/m
    );
    expect(updateStrategy, "Docker image updates section not found").toBeDefined();
    expect(updateStrategy!).toMatch(/docker image prune\b/);
  });
});
