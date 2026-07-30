import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  needsProductionBuild,
  isBuildIrrelevant,
  buildInputFingerprint,
  canTrustFingerprint,
  formatPendingRecord,
  parsePendingRecord,
  escapingImportTargets,
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

describe("the build graph is not the same thing as the web package", () => {
  // The exclusion set above reasons from packages/web/tsconfig.json, and that is
  // the right anchor for WHICH files are type-checked — but not for WHERE they
  // are. A relative import reaches out of packages/web and drags whatever it
  // finds into the build graph, tsconfig include globs notwithstanding:
  // src/lib/openclaw-config/plugin-manifest-loader.ts statically imports all
  // nine packages/plugins/pinchy-*/openclaw.plugin.json manifests, so an invalid
  // manifest — or one that loses a field the loader reads — fails `next build`.
  // "packages/plugins/ never reaches the build" was true of the plugin SOURCE
  // and false of the manifests, and the gate skipped on both.
  test("a plugin manifest the web build imports is build-relevant", () => {
    assert.equal(
      isBuildIrrelevant("packages/plugins/pinchy-files/openclaw.plugin.json"),
      false,
    );
    assert.equal(
      needsProductionBuild([
        "packages/plugins/pinchy-odoo/openclaw.plugin.json",
      ]),
      true,
    );
  });

  test("plugin source and plugin tests still skip the build", () => {
    // The carve-out is the manifests, not the whole package: nothing under
    // packages/plugins is imported by packages/web except those JSON files, and
    // `pnpm typecheck:plugins` is the gate for the rest.
    assert.equal(
      isBuildIrrelevant("packages/plugins/pinchy-odoo/index.ts"),
      true,
    );
    assert.equal(
      isBuildIrrelevant("packages/plugins/pinchy-files/pdf-extract.test.ts"),
      true,
    );
    assert.equal(
      isBuildIrrelevant("packages/plugins/pinchy-files/openclaw.plugin.md"),
      true,
    );
  });

  // The drift guard. Hard-coding "the manifests" would only pin today's one
  // escape; the next `import ... from "../../../../plugins/foo/bar"` would land
  // in the build graph with the gate still calling it irrelevant, and every
  // check would stay green. So derive the escapes from the source instead:
  // whatever a build-relevant web file imports from outside packages/web must
  // itself be build-relevant.
  test("every file the web build reaches outside packages/web is build-relevant", () => {
    const WEB = join(REPO_ROOT, "packages/web");
    const offenders = [];

    const walk = (absDir) => {
      for (const entry of readdirSync(absDir, { withFileTypes: true })) {
        const abs = join(absDir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".next") continue;
          walk(abs);
          continue;
        }
        if (!/\.(ts|tsx|mts)$/.test(entry.name)) continue;
        const repoPath = abs
          .slice(REPO_ROOT.length + 1)
          .split("\\")
          .join("/");
        // A file the build does not read cannot drag anything into the build.
        if (isBuildIrrelevant(repoPath)) continue;

        for (const target of escapingImportTargets(
          repoPath,
          readFileSync(abs, "utf8"),
        )) {
          // Extension-less specifiers: check what actually exists on disk, and
          // fall back to the bare path so an unresolvable import is still judged
          // rather than silently waved through.
          const candidates = [
            target,
            `${target}.ts`,
            `${target}.tsx`,
            `${target}.json`,
            `${target}/index.ts`,
          ].filter((c) => existsSync(join(REPO_ROOT, c)));
          for (const candidate of candidates.length ? candidates : [target]) {
            if (isBuildIrrelevant(candidate))
              offenders.push(`${repoPath} imports ${candidate}`);
          }
        }
      }
    };

    walk(WEB);

    assert.deepEqual(
      offenders,
      [],
      `these imports reach into the build from a path the gate calls irrelevant, ` +
        `so a change to them would skip the build that checks them:\n  ` +
        offenders.join("\n  "),
    );
  });

  test("the walk above actually reads the web tree", () => {
    // A guard that silently traverses nothing is the failure mode here: it stays
    // green forever. Pin the one import we know escapes today.
    const loader = join(
      REPO_ROOT,
      "packages/web/src/lib/openclaw-config/plugin-manifest-loader.ts",
    );
    // Read it directly rather than stat-then-read. The read IS the existence
    // proof and a stricter one: it throws ENOENT if the file moved and EISDIR if
    // the path became a directory, which is every case `statSync(…).isFile()`
    // caught. A separate check first only adds a window in which the answer can
    // change between the two calls (CodeQL js/file-system-race).
    const source = readFileSync(loader, "utf8");
    const targets = escapingImportTargets(
      "packages/web/src/lib/openclaw-config/plugin-manifest-loader.ts",
      source,
    );
    assert.ok(
      targets.includes("packages/plugins/pinchy-files/openclaw.plugin.json"),
      `expected the plugin manifest imports to be detected, got ${JSON.stringify(targets)}`,
    );
  });
});

describe("escapingImportTargets — which imports leave packages/web", () => {
  const FROM = "packages/web/src/lib/openclaw-config/build.ts";

  test("resolves a relative import that climbs out of packages/web", () => {
    assert.deepEqual(
      escapingImportTargets(
        FROM,
        `import x from "../../../../plugins/pinchy-web/openclaw.plugin.json";`,
      ),
      ["packages/plugins/pinchy-web/openclaw.plugin.json"],
    );
  });

  test("ignores imports that stay inside packages/web", () => {
    assert.deepEqual(
      escapingImportTargets(
        FROM,
        [
          `import a from "./sibling";`,
          `import b from "../parent";`,
          `import c from "@/lib/audit";`,
          `import d from "next/server";`,
        ].join("\n"),
      ),
      [],
    );
  });

  test("sees export-from, side-effect import, dynamic import and import-equals", () => {
    assert.deepEqual(
      escapingImportTargets(
        FROM,
        [
          `export { a } from "../../../../plugins/pinchy-files/a";`,
          `import "../../../../plugins/pinchy-files/b";`,
          `const c = await import("../../../../plugins/pinchy-files/c");`,
          `import d = require("../../../../plugins/pinchy-files/d");`,
          `import type { E } from "../../../../plugins/pinchy-files/e";`,
        ].join("\n"),
      ),
      [
        "packages/plugins/pinchy-files/a",
        "packages/plugins/pinchy-files/b",
        "packages/plugins/pinchy-files/c",
        "packages/plugins/pinchy-files/d",
        "packages/plugins/pinchy-files/e",
      ],
    );
  });

  test("does not report a createRequire runtime require", () => {
    // The distinction is what TypeScript RESOLVES. `createRequire`'s require
    // returns `any` and its call sites cast the result, so the module it loads
    // never enters the build graph — eval/__tests__/odoo-mock-eval-reset.test.ts
    // loads the odoo mock exactly this way and says so in its own comment. A
    // guard that reported it would demand a build for a file `next build` cannot
    // read, i.e. the mirror image of the hole it exists to close.
    assert.deepEqual(
      escapingImportTargets(
        "packages/web/eval/__tests__/odoo-mock-eval-reset.test.ts",
        [
          `const require = createRequire(import.meta.url);`,
          `const { start } = require("../../../../config/odoo-mock/server.js") as {`,
          `  start: () => void;`,
          `};`,
        ].join("\n"),
      ),
      [],
    );
  });

  test("does not report the same target twice", () => {
    assert.deepEqual(
      escapingImportTargets(
        FROM,
        [
          `import a from "../../../../plugins/p/m.json";`,
          `import b from "../../../../plugins/p/m.json";`,
        ].join("\n"),
      ),
      ["packages/plugins/p/m.json"],
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

describe("the pending record — what the gate staged must still be true when it is promoted", () => {
  // canTrustFingerprint runs when the gate DECIDES, minutes before the build
  // finishes. Editing files while a five-minute build runs is ordinary work,
  // not an exotic race, and those edits are exactly what `next build` compiled.
  // Promoting on the strength of the earlier check would credit the commit with
  // a build of different bytes — and the next push of that commit would skip on
  // a guarantee nobody established. So the record carries the HEAD it was
  // staged against, and re-checks it.
  test("round-trips a staged record", () => {
    const record = { fingerprint: "abc123", headOid: "deadbeef" };
    assert.deepEqual(parsePendingRecord(formatPendingRecord(record)), record);
  });

  test("tolerates the trailing newline a file write adds", () => {
    assert.deepEqual(parsePendingRecord("abc123\ndeadbeef\n"), {
      fingerprint: "abc123",
      headOid: "deadbeef",
    });
  });

  test("refuses a record that has lost half of itself", () => {
    // A bare fingerprint is what the FIRST version of this file wrote. Reading
    // it as valid would silently restore the unchecked promotion.
    assert.equal(parsePendingRecord("abc123"), null);
    assert.equal(parsePendingRecord("abc123\n"), null);
    assert.equal(parsePendingRecord(""), null);
    assert.equal(parsePendingRecord(null), null);
    assert.equal(parsePendingRecord("\ndeadbeef"), null);
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
