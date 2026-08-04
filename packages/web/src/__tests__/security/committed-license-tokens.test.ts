// @vitest-environment node
//
// packages/web/src/__tests__/security/committed-license-tokens.test.ts
//
// Guard for the license material this repository ships.
//
// Until v0.9 the dev stack was unlocked by a license signed with the
// PRODUCTION key (exp 2088), committed in two places. It was NODE_ENV-gated
// only at the route that installs it — the string itself was a working
// enterprise key, and pasting it into Settings → License unlocked paid
// features on any install (#1083). Nothing was red: the token was valid, so
// every test that used it passed, which is exactly the point.
//
// The fix is structural (a development keypair no production build trusts,
// plus a validator that never honours the dev subject under the production
// key). This guard is the tripwire that keeps it structural: the moment a
// production-signed token lands anywhere in the tracked tree again, CI fails
// here, naming the file.
//
// It asks jose directly rather than going through `validateLicense`, so it
// still fires on a token the validator's own policy would reject. The question
// is "did our production key sign this?", not "would we grant it today".
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as jose from "jose";
import { DEV_LICENSE_TOKEN, PRODUCTION_PUBLIC_KEY } from "@/lib/license-keys";

const REPO_ROOT = resolve(__dirname, "../../../../..");

/** Three base64url segments — the shape of a compact JWS. */
const JWT_RE = "eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+";

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function trackedFileCount(): number {
  return git(["ls-files"]).split("\n").filter(Boolean).length;
}

/**
 * Every JWT-shaped string in the tracked tree, with the file it came from.
 * `-I` skips binaries; `git grep` exits 1 on "no matches", which is a legal
 * (if, here, impossible) answer rather than a failure.
 */
function jwtCandidates(): Array<{ file: string; token: string }> {
  let out: string;
  try {
    out = git(["grep", "-I", "--no-color", "-o", "-E", JWT_RE, "--", "."]);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) return [];
    throw err;
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const sep = line.indexOf(":");
      return { file: line.slice(0, sep), token: line.slice(sep + 1) };
    });
}

/**
 * Did the production key sign this? jose verifies the signature BEFORE it
 * validates claims, so a claim-level rejection (expired, wrong issuer) still
 * proves authenticity — which is the property that matters for a token sitting
 * in a public repository.
 */
async function signedByProductionKey(token: string): Promise<boolean> {
  const key = await jose.importSPKI(PRODUCTION_PUBLIC_KEY, "ES256");
  try {
    await jose.jwtVerify(token, key);
    return true;
  } catch (err) {
    return (
      err instanceof jose.errors.JWTExpired || err instanceof jose.errors.JWTClaimValidationFailed
    );
  }
}

describe("no production-signed license is committed", () => {
  it("scans a real corpus", () => {
    // A walker that finds nothing passes in silence; assert it found the repo.
    expect(trackedFileCount()).toBeGreaterThan(500);
  });

  it("finds no token the production key signed", async () => {
    const offenders: string[] = [];
    for (const { file, token } of jwtCandidates()) {
      if (await signedByProductionKey(token)) offenders.push(file);
    }
    expect(
      offenders,
      "A license signed by the PRODUCTION key is committed. Anyone who can read " +
        "this repository can paste it into Settings → License and unlock paid " +
        "features on their own install — and it cannot be un-published. Sign " +
        "development licenses with the DEVELOPMENT key instead (see #1083 and " +
        "src/lib/license-keys.ts)."
    ).toEqual([]);
  });
});

describe("the development license", () => {
  it("is signed by the development key and not the production one", async () => {
    expect(await signedByProductionKey(DEV_LICENSE_TOKEN)).toBe(false);
  });

  it("is the same string docker-compose.dev.yml defaults to", () => {
    // Compose cannot import a TS constant, so the copy there is pinned here.
    // Drift is silent otherwise: the dev stack keeps booting, just without
    // enterprise features, and nothing says why.
    const compose = readFileSync(join(REPO_ROOT, "docker-compose.dev.yml"), "utf-8");
    const match = compose.match(/PINCHY_ENTERPRISE_KEY=\$\{PINCHY_ENTERPRISE_KEY-([^}]+)\}/);
    expect(match, "docker-compose.dev.yml no longer defaults PINCHY_ENTERPRISE_KEY").not.toBeNull();
    expect(match![1]).toBe(DEV_LICENSE_TOKEN);
  });
});
