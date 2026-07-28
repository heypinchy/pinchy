import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  needsProductionBuild,
  isBuildIrrelevant,
  buildInputFingerprint,
  canTrustFingerprint,
} from "./prepush-build-gate.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("needsProductionBuild — the failure class the pre-push build protects", () => {
  // `next build` is the ONLY check in the local loop that sees the client/server
  // bundling boundary: a client component importing a lib module that transitively
  // pulls in `@/db` / `postgres` passes `tsc --noEmit` and the whole vitest suite,
  // then breaks the build. Every path that can reach that boundary must build.
  const buildRelevant = [
    "packages/web/src/app/(app)/chat/page.tsx",
    "packages/web/src/lib/oauth-providers.ts",
    "packages/web/src/components/ui/button.tsx",
    "packages/web/src/app/globals.css",
    "packages/web/next.config.ts",
    "packages/web/package.json",
    "packages/web/tsconfig.json",
    "packages/web/proxy.ts",
    "packages/web/server.ts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ];

  for (const path of buildRelevant) {
    test(`builds for ${path}`, () => {
      assert.equal(isBuildIrrelevant(path), false);
      assert.equal(needsProductionBuild([path]), true);
    });
  }

  // These cannot change a single byte of `next build`'s input, so building on
  // them is pure latency with no guarantee attached.
  const buildIrrelevant = [
    "docs/src/content/docs/guides/agents.mdx",
    "AGENTS.md",
    "packages/web/README.md",
    ".github/workflows/ci.yml",
    ".husky/pre-push",
    "scripts/lib/ci-path-filter.mjs",
    "config/telegram-mock/server.js",
    "sample-data/handbook.md",
    "marketplace/caprover/captain-definition",
    "packages/plugins/pinchy-odoo/index.ts",
    "packages/plugins/pinchy-files/pdf-extract.test.ts",
    "docker-compose.dev.yml",
    "Dockerfile.pinchy",
    ".claude/settings.json",
    "packages/web/public/icon-512.png",
    "packages/web/drizzle/0054_add_pgvector.sql",
    "packages/web/drizzle/meta/_journal.json",
  ];

  for (const path of buildIrrelevant) {
    test(`skips the build for ${path}`, () => {
      assert.equal(isBuildIrrelevant(path), true);
    });
  }

  test("skips the build when every changed file is irrelevant", () => {
    assert.equal(needsProductionBuild(buildIrrelevant), false);
  });

  test("one relevant file in a mixed push is enough to build", () => {
    assert.equal(
      needsProductionBuild([
        ...buildIrrelevant,
        "packages/web/src/lib/audit.ts",
      ]),
      true,
    );
  });

  test("an empty or unresolvable diff builds — fail open", () => {
    // Same contract as hasCodeChanges in ci-path-filter.mjs: an empty list means
    // "we could not tell what changed", not "nothing changed". A wasted build is
    // recoverable; a boundary error reaching main is not.
    assert.equal(needsProductionBuild([]), true);
    assert.equal(needsProductionBuild(["", "  ", "\n"]), true);
  });
});

describe("the exclusion set stays pinned to packages/web/tsconfig.json", () => {
  // `next build` type-checks everything tsconfig.json includes, which is
  // `**/*.ts(x)` under packages/web MINUS its `exclude` list. So a web test file
  // is only safe to skip the build for because tsconfig excludes it. If that
  // exclude list ever shrinks, these paths start being able to break the build
  // and this gate would be lying.
  const tsconfig = JSON.parse(
    readFileSync(join(REPO_ROOT, "packages/web/tsconfig.json"), "utf8"),
  );

  test("web unit tests are excluded from the build's typecheck", () => {
    assert.ok(tsconfig.exclude.includes("src/**/*.test.ts"));
    assert.ok(tsconfig.exclude.includes("src/**/*.test.tsx"));
    assert.equal(isBuildIrrelevant("packages/web/src/lib/audit.test.ts"), true);
    assert.equal(
      isBuildIrrelevant("packages/web/src/components/chat-switcher.test.tsx"),
      true,
    );
  });

  test("vitest.config.ts and test-setup.ts are excluded from the build's typecheck", () => {
    assert.ok(tsconfig.exclude.includes("vitest.config.ts"));
    assert.ok(tsconfig.exclude.includes("src/test-setup.ts"));
    assert.equal(isBuildIrrelevant("packages/web/vitest.config.ts"), true);
    assert.equal(isBuildIrrelevant("packages/web/src/test-setup.ts"), true);
  });

  test("files tsconfig does NOT exclude still build, even though they look test-shaped", () => {
    // e2e specs, the eval harness and src/test-helpers are all inside the
    // tsconfig include and are NOT in its exclude list, so a type error in them
    // genuinely fails `next build`. Treating them as "just tests" would be the
    // exact false-negative this gate must not have.
    assert.equal(
      isBuildIrrelevant("packages/web/e2e/telegram/chats.spec.ts"),
      false,
    );
    assert.equal(
      isBuildIrrelevant("packages/web/eval/export-scorecard.ts"),
      false,
    );
    assert.equal(
      isBuildIrrelevant("packages/web/src/test-helpers/auth.ts"),
      false,
    );
    assert.equal(
      isBuildIrrelevant(
        "packages/web/src/__tests__/lib/no-untracked-skips.test.ts",
      ),
      true, // …but a *.test.ts under src/ is excluded, so this one is safe.
    );
  });
});

describe("buildInputFingerprint — don't rebuild an input that already built", () => {
  // The relevance filter above only helps a push whose whole diff misses the
  // build. Measured against 200 commits of main that is ~2.5% of them. The cost
  // that actually dominates an agent's loop is re-pushing the SAME build input:
  // amend/rebase cycles, a follow-up docs commit, a test-only fix. The
  // fingerprint covers those — it is the content of every build-relevant file,
  // so an unchanged fingerprint means `next build` would consume byte-identical
  // input and can only reach the same verdict it already reached.
  const tree = [
    { path: "packages/web/src/lib/audit.ts", oid: "aaa" },
    { path: "packages/web/next.config.ts", oid: "bbb" },
    { path: "pnpm-lock.yaml", oid: "ccc" },
    { path: "docs/index.mdx", oid: "ddd" },
    { path: "packages/web/src/lib/audit.test.ts", oid: "eee" },
  ];

  test("is stable for the same tree", () => {
    assert.equal(buildInputFingerprint(tree), buildInputFingerprint(tree));
  });

  test("ignores the order git happens to list entries in", () => {
    assert.equal(
      buildInputFingerprint(tree),
      buildInputFingerprint([...tree].reverse()),
    );
  });

  test("does not move when only build-irrelevant files change", () => {
    const docsEdited = tree.map((e) =>
      e.path === "docs/index.mdx" ? { ...e, oid: "CHANGED" } : e,
    );
    const testEdited = tree.map((e) =>
      e.path === "packages/web/src/lib/audit.test.ts"
        ? { ...e, oid: "CHANGED" }
        : e,
    );
    assert.equal(
      buildInputFingerprint(docsEdited),
      buildInputFingerprint(tree),
    );
    assert.equal(
      buildInputFingerprint(testEdited),
      buildInputFingerprint(tree),
    );
  });

  test("moves when a build-relevant file changes", () => {
    const srcEdited = tree.map((e) =>
      e.path === "packages/web/src/lib/audit.ts" ? { ...e, oid: "CHANGED" } : e,
    );
    assert.notEqual(
      buildInputFingerprint(srcEdited),
      buildInputFingerprint(tree),
    );
  });

  test("moves when a build-relevant file is added or removed", () => {
    const added = [
      ...tree,
      { path: "packages/web/src/lib/new.ts", oid: "fff" },
    ];
    const removed = tree.filter(
      (e) => e.path !== "packages/web/next.config.ts",
    );
    assert.notEqual(buildInputFingerprint(added), buildInputFingerprint(tree));
    assert.notEqual(
      buildInputFingerprint(removed),
      buildInputFingerprint(tree),
    );
  });

  test("cannot be forged by a path containing the field separator", () => {
    // Naive `path + oid` concatenation lets a crafted filename collide with a
    // different (path, oid) pair, which would skip a build that should run.
    const a = [{ path: "packages/web/src/a", oid: "b/packages/web/src/c" }];
    const b = [
      { path: "packages/web/src/a", oid: "b" },
      { path: "packages/web/src/c", oid: "" },
    ];
    assert.notEqual(buildInputFingerprint(a), buildInputFingerprint(b));
  });
});

describe("canTrustFingerprint — the build compiles the working tree, not the commit", () => {
  // `next build` reads the working tree; the fingerprint describes a commit.
  // They only describe the same bytes when HEAD is the pushed tip and nothing
  // sits on top of it. Recording a success in any other state would credit a
  // commit with a build it never got.
  test("trusts a clean tree sitting exactly on the pushed tip", () => {
    assert.equal(
      canTrustFingerprint({
        workingTreeClean: true,
        headMatchesPushedTip: true,
      }),
      true,
    );
  });

  test("does not trust a dirty tree — including untracked files", () => {
    assert.equal(
      canTrustFingerprint({
        workingTreeClean: false,
        headMatchesPushedTip: true,
      }),
      false,
    );
  });

  test("does not trust a push of something other than HEAD", () => {
    // e.g. `git push origin <older-sha>:main`, or pushing a second branch.
    assert.equal(
      canTrustFingerprint({
        workingTreeClean: true,
        headMatchesPushedTip: false,
      }),
      false,
    );
  });

  test("treats an undetermined state as untrustworthy", () => {
    // A git call that failed leaves these undefined; that must not read as true.
    assert.equal(canTrustFingerprint({}), false);
  });
});

describe("the hook wiring stays honest", () => {
  const hook = readFileSync(join(REPO_ROOT, ".husky/pre-push"), "utf8");

  test("pre-push consults the gate instead of building unconditionally", () => {
    assert.match(hook, /should-run-prepush-build\.mjs/);
  });

  test("pre-push still runs the real build when the gate says so", () => {
    assert.match(hook, /pnpm build/);
  });

  test("a failing build still fails the push", () => {
    // `--record` runs after the build, so it — not the build — is the hook's
    // last command and would otherwise become its exit status, turning a broken
    // build into a green push. The explicit `|| exit 1` is what prevents that.
    assert.match(hook, /pnpm build \|\| exit 1/);
    assert.match(hook, /pnpm install --frozen-lockfile \|\| exit 1/);
  });

  test("the fingerprint is only recorded after the build succeeded", () => {
    const recordAt = hook.indexOf("--record");
    const buildAt = hook.indexOf("pnpm build");
    assert.ok(buildAt !== -1 && recordAt > buildAt);
  });
});
