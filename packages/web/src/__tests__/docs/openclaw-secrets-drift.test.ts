import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const repoRoot = resolve(__dirname, "../../../../..");
const composePath = resolve(repoRoot, "docker-compose.yml");
const upgradingPath = resolve(repoRoot, "docs/src/content/docs/guides/upgrading.mdx");
const secretsDocPath = resolve(repoRoot, "docs/src/content/docs/security/secrets.md");

const compose = readFileSync(composePath, "utf-8");
const upgrading = readFileSync(upgradingPath, "utf-8");
const secretsDoc = readFileSync(secretsDocPath, "utf-8");

function extractTmpfsOptions(): string {
  // Matches the `o:` line under the openclaw-secrets volume in docker-compose.yml.
  // Handles both quoted (`o: "mode=..."`) and unquoted (`o: mode=...`) YAML values.
  const match = compose.match(/openclaw-secrets:\s*\n[\s\S]*?o:\s*(?:"([^"]+)"|(\S+))/);
  const options = match?.[1] ?? match?.[2];
  if (!options) {
    throw new Error("Could not extract tmpfs options for openclaw-secrets from docker-compose.yml");
  }
  return options;
}

describe("openclaw-secrets tmpfs documentation drift", () => {
  it("upgrading.mdx custom-compose snippet matches docker-compose.yml options", () => {
    // Regression guard for #281: a custom-compose maintainer who copies the
    // snippet verbatim must end up with the same tmpfs options as the
    // canonical docker-compose.yml. Drift here breaks every agent request
    // with an EACCES on writeSecretsFile().
    const options = extractTmpfsOptions();
    expect(upgrading).toContain(options);
  });

  it("upgrading.mdx custom-compose snippet mounts the volume into both services", () => {
    // The named volume must be referenced under BOTH `pinchy:` and `openclaw:`
    // service blocks in the breaking-changes section. Mounting only into
    // openclaw is the exact failure mode #281 documents.
    const breakingChanges = upgrading
      .split(/^##\s+Upgrading from v0\.4\.4/m)[1]
      ?.split(/^##\s+Upgrading from v0\.4\.3/m)[0];
    expect(breakingChanges, "breaking-changes section not found").toBeDefined();
    expect(breakingChanges!).toMatch(/pinchy:[\s\S]*openclaw-secrets/);
    expect(breakingChanges!).toMatch(/openclaw:[\s\S]*openclaw-secrets/);
  });

  it("security/secrets.md yaml block matches docker-compose.yml options", () => {
    const options = extractTmpfsOptions();
    expect(secretsDoc).toContain(options);
  });

  it("security/secrets.md prose references the actual Pinchy uid", () => {
    // The descriptive paragraph claims a specific uid for the directory
    // owner. It must match the value baked into docker-compose.yml.
    const options = extractTmpfsOptions();
    const uidMatch = options.match(/uid=(\d+)/);
    expect(uidMatch?.[1], "uid not found in compose options").toBeDefined();
    const uid = uidMatch![1]!;
    expect(secretsDoc).toMatch(new RegExp(`uid[^\\d]*${uid}\\b`));
    // And must NOT mention the previous, drifted value.
    expect(secretsDoc).not.toMatch(/uid 1000\b/);
  });
});
