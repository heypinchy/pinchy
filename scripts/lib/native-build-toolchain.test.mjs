import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  analyzeDockerfiles,
  installsInStage,
  parseDockerfileStages,
  resolveStageChain,
  toolchainInChain,
  validateNativeBuildToolchain,
} from "./native-build-toolchain.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".claude",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
]);

/**
 * Every Dockerfile in the tree, found by walking rather than by listing the
 * two directories that hold them today. A hand-shaped walk is the same
 * hand-maintained list this guard exists to replace: it would silently skip
 * the next image someone adds somewhere new.
 */
function readRepoDockerfiles(dir = REPO_ROOT, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      readRepoDockerfiles(path, found);
      continue;
    }
    if (!entry.name.startsWith("Dockerfile")) continue;
    const file = relative(REPO_ROOT, path).split(sep).join("/");
    found.push({
      file,
      dir: relative(REPO_ROOT, dir).split(sep).join("/") || ".",
      text: readFileSync(path, "utf8"),
    });
  }
  return found;
}

function readRepoManifest(path) {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));
  } catch {
    return null;
  }
}

function realRepoInput() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  return {
    dockerfiles: readRepoDockerfiles(),
    onlyBuiltDependencies: pkg.pnpm?.onlyBuiltDependencies,
    readManifest: readRepoManifest,
  };
}

const TOOLCHAIN_APT =
  "RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential";

test("every Dockerfile stage that installs something compilable can compile it", () => {
  const errors = validateNativeBuildToolchain(realRepoInput());
  assert.deepEqual(errors, [], errors.join("\n\n"));
});

test("the real corpus covers all three images, classified from their manifests", () => {
  // A floor of "more than zero" is satisfied by one image. These are the three
  // that install something compilable, and the whole argument of this change is
  // that hand-checking three files does not work — so name them.
  const sites = analyzeDockerfiles(realRepoInput());
  const compiling = sites
    .filter((site) => site.compiles.length > 0)
    .map((site) => `${site.file}:${site.stage ?? "-"}`);

  assert.ok(
    compiling.includes("Dockerfile.pinchy:prod-deps"),
    `prod-deps missing from ${JSON.stringify(compiling)}`,
  );
  assert.ok(compiling.includes("Dockerfile.pinchy:build"));
  assert.ok(compiling.includes("Dockerfile.pinchy.dev:-"));
  // pinchy-files declares better-sqlite3 and openclaw installs it with npm.
  // The first draft of this guard matched `pnpm install` only and never looked
  // at this file at all — the one file it held up as having got it right.
  assert.ok(compiling.includes("Dockerfile.openclaw:builder"));

  // And the mocks are exempt because their manifests say so, not because a
  // comment claims they are pure JS.
  const mock = sites.find((site) => site.file.startsWith("config/imap-mock/"));
  assert.ok(mock, "config/imap-mock has no install site any more");
  assert.deepEqual(mock.compiles, []);
  assert.match(mock.why, /config\/imap-mock\/package\.json/);
});

test("an npm install of a workspace manifest with a native dep is in scope", () => {
  // Dockerfile.openclaw, reduced. `npm` rather than `pnpm`, a manifest COPYed
  // in from packages/plugins, and a `cd` that decides which directory the
  // install reads.
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "Dockerfile.openclaw",
        dir: ".",
        text: [
          "FROM node:22-slim AS builder",
          "COPY packages/plugins/pinchy-files/package.json /tmp/pinchy-files/package.json",
          "RUN cd /tmp/pinchy-files && npm install --omit=dev",
        ].join("\n"),
      },
    ],
    onlyBuiltDependencies: ["better-sqlite3"],
    readManifest: (path) =>
      path === "packages/plugins/pinchy-files/package.json"
        ? { dependencies: { "better-sqlite3": "^12.11.1" } }
        : null,
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Dockerfile\.openclaw/);
  assert.match(errors[0], /better-sqlite3/);
});

test("a manifest with no compilable dependency is out of scope", () => {
  // config/*-mock: WORKDIR + `COPY package.json ./` + npm install, against
  // express/imapflow/nodemailer. Demanding a 306 MB toolchain in seven mock
  // images to protect a dependency they do not have would be worse than the
  // gap it closes — but that must be READ from the manifest, not asserted.
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "config/imap-mock/Dockerfile",
        dir: "config/imap-mock",
        text: [
          "FROM node:22-slim",
          "WORKDIR /app",
          "COPY package.json ./",
          "RUN npm install --omit=dev",
        ].join("\n"),
      },
      // A compilable site has to be present, or the corpus check below fires
      // instead — which is the point of that check.
      {
        file: "Dockerfile.pinchy.dev",
        dir: ".",
        text: [
          "FROM node:22-slim",
          TOOLCHAIN_APT,
          "RUN pnpm install --frozen-lockfile",
        ].join("\n"),
      },
    ],
    onlyBuiltDependencies: ["better-sqlite3"],
    readManifest: (path) =>
      path === "config/imap-mock/package.json"
        ? { dependencies: { express: "^5.1.0", imapflow: "^1.4.6" } }
        : null,
  });
  assert.deepEqual(errors, []);
});

test("an install whose manifest cannot be resolved counts as compilable", () => {
  // The safe direction: `npm install -g <anything>` may compile, and a stage
  // that genuinely installs nothing native can say so by having a manifest
  // this guard can find.
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "Dockerfile.mystery",
        dir: ".",
        text: ["FROM node:22-slim", "RUN npm install -g some-cli"].join("\n"),
      },
    ],
    onlyBuiltDependencies: ["better-sqlite3"],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /global install/);
});

test("a stage that installs without a toolchain is reported, with the line to add", () => {
  // The 2026-08-05 failure, reduced: Dockerfile.pinchy.dev as it was, one apt
  // line for LibreOffice and a pnpm install with no way to compile.
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "Dockerfile.pinchy.dev",
        dir: ".",
        text: [
          "FROM node:22-slim",
          "RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer",
          "RUN pnpm install --frozen-lockfile",
        ].join("\n"),
      },
    ],
    onlyBuiltDependencies: ["better-sqlite3"],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Dockerfile\.pinchy\.dev/);
  assert.match(errors[0], /python3 and a C\+\+ compiler and make/);
  assert.match(errors[0], /better-sqlite3/);
  // A failure that does not print the fix gets the next person guessing.
  assert.match(errors[0], /apt-get install -y --no-install-recommends/);
});

test("half a toolchain is the same dead end, one message later", () => {
  // python3 alone stops at `make: c++: No such file or directory`. Debian's
  // `gcc` is not a C++ compiler, and `g++` without `make` cannot run node-gyp
  // either — so none of these three may pass.
  for (const [packages, expected] of [
    ["python3", /a C\+\+ compiler and make/],
    ["python3 gcc", /a C\+\+ compiler and make/],
    ["python3 g++", /without make/],
  ]) {
    const errors = validateNativeBuildToolchain({
      dockerfiles: [
        {
          file: "Dockerfile.half",
          dir: ".",
          text: [
            "FROM node:22-slim",
            `RUN apt-get update && apt-get install -y --no-install-recommends ${packages}`,
            "RUN pnpm install --frozen-lockfile",
          ].join("\n"),
        },
      ],
      onlyBuiltDependencies: ["better-sqlite3"],
    });
    assert.equal(errors.length, 1, packages);
    assert.match(errors[0], expected, packages);
  }
});

test("g++ and make without build-essential is a real toolchain", () => {
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "Dockerfile.explicit",
        dir: ".",
        text: [
          "FROM node:22-slim",
          "RUN apt-get update && apt-get install -y --no-install-recommends python3 g++ make",
          "RUN pnpm install --frozen-lockfile",
        ].join("\n"),
      },
    ],
    onlyBuiltDependencies: ["better-sqlite3"],
  });
  assert.deepEqual(errors, []);
});

test("a toolchain in an ancestor stage counts — that is how Dockerfile.pinchy is built", () => {
  // The toolchain lives in `base`; the installs run in `prod-deps` and
  // `build`. A check that read only the installing stage would call the
  // correct file broken, and the obvious fix would be to duplicate the apt
  // line into the runtime stage — shipping 306 MB nothing needs.
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "Dockerfile.pinchy",
        dir: ".",
        text: [
          "FROM node:22-slim AS base",
          TOOLCHAIN_APT,
          "FROM base AS prod-deps",
          "RUN pnpm install --prod --frozen-lockfile",
          "FROM base AS build",
          "RUN pnpm install --frozen-lockfile",
          "FROM node:22-slim AS runtime",
          "COPY --from=prod-deps /app/node_modules ./node_modules",
        ].join("\n"),
      },
    ],
    onlyBuiltDependencies: ["better-sqlite3"],
  });
  assert.deepEqual(errors, []);
});

test("a comment naming the packages is not the packages", () => {
  // These Dockerfiles explain their apt lines in prose directly above them.
  // A guard that matched text would read the explanation of a DELETED install
  // as the install — the same "reports on the presence of a string" failure
  // the skip and format guards were both bitten by.
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "Dockerfile.commented",
        dir: ".",
        text: [
          "FROM node:22-slim",
          "# python3 + build-essential are needed for native npm modules.",
          "RUN pnpm install --frozen-lockfile",
        ].join("\n"),
      },
    ],
    onlyBuiltDependencies: ["better-sqlite3"],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /without python3 and a C\+\+ compiler and make/);
});

test("a comment inside a continuation does not truncate the statement", () => {
  // Docker strips comment lines inside a `\` continuation. A parser that
  // appends an empty string instead ends the statement early and loses every
  // package after the comment — the apt line reads as a bare `apt-get update`
  // and the stage looks like it has no toolchain at all.
  const stages = parseDockerfileStages(
    [
      "FROM node:22-slim",
      "RUN apt-get update \\",
      "    # the toolchain better-sqlite3 falls back to",
      "    && apt-get install -y python3 build-essential \\",
      "",
      "    && rm -rf /var/lib/apt/lists/*",
      "RUN pnpm install",
    ].join("\n"),
  );
  assert.equal(stages[0].runs.length, 2);
  assert.match(stages[0].runs[0].command, /python3 build-essential/);
  assert.deepEqual(toolchainInChain(stages), {
    python: true,
    cxx: true,
    make: true,
  });
});

test("finding no install stage fails instead of passing on an empty comparison", () => {
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      { file: "Dockerfile.none", dir: ".", text: "FROM node:22-slim" },
    ],
    onlyBuiltDependencies: ["better-sqlite3"],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /No Dockerfile stage running an install/);
});

test("finding installs but nothing compilable fails too", () => {
  // The quieter half of the same failure: a classifier that stops recognising
  // the workspace install waves every remaining site through as pure JS, and
  // reports a clean tree.
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "config/brave-mock/Dockerfile",
        dir: "config/brave-mock",
        text: [
          "FROM node:22-slim",
          "WORKDIR /app",
          "COPY package.json ./",
          "RUN npm install --omit=dev",
        ].join("\n"),
      },
    ],
    onlyBuiltDependencies: ["better-sqlite3"],
    readManifest: () => ({ dependencies: { express: "^5.1.0" } }),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not one of them installs better-sqlite3/);
});

test("an empty onlyBuiltDependencies removes the premise, and says so", () => {
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "Dockerfile.pinchy.dev",
        dir: ".",
        text: ["FROM node:22-slim", "RUN pnpm install"].join("\n"),
      },
    ],
    onlyBuiltDependencies: [],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /onlyBuiltDependencies is empty/);
});

test("parseDockerfileStages joins continuations and tracks WORKDIR per stage", () => {
  const stages = parseDockerfileStages(
    [
      "FROM node:22-slim AS base",
      "WORKDIR /app",
      "RUN apt-get update \\",
      "    && apt-get install -y --no-install-recommends \\",
      "       python3 build-essential \\",
      "    && rm -rf /var/lib/apt/lists/*",
      "FROM base AS build",
      "COPY package.json ./",
      "RUN pnpm install",
    ].join("\n"),
  );
  assert.equal(stages.length, 2);
  assert.equal(stages[0].name, "base");
  assert.equal(stages[1].parent, "base");
  assert.equal(stages[0].runs.length, 1);
  assert.match(stages[0].runs[0].command, /python3 build-essential/);
  // WORKDIR is inherited by a stage built FROM this one, which is how the mock
  // images' `COPY package.json ./` resolves to a real path.
  assert.equal(stages[1].workdir, "/app");
  assert.deepEqual(stages[1].copies, [
    { src: "package.json", dest: "./", workdir: "/app" },
  ]);
});

test("installsInStage follows a cd inside the same RUN", () => {
  const [stage] = parseDockerfileStages(
    [
      "FROM node:22-slim",
      "WORKDIR /app",
      "RUN cd /tmp/pinchy-files && npm install --omit=dev && cp -r node_modules /opt/",
    ].join("\n"),
  );
  assert.deepEqual(
    installsInStage(stage).map((site) => [site.tool, site.dir, site.global]),
    [["npm", "/tmp/pinchy-files", false]],
  );
});

test("resolveStageChain terminates on a self-referential FROM", () => {
  // A malformed Dockerfile must fail as a message, never as a hang.
  const stages = parseDockerfileStages(
    ["FROM loop AS loop", "RUN pnpm install"].join("\n"),
  );
  const chain = resolveStageChain(stages, 0);
  assert.equal(chain.length, 1);
  assert.deepEqual(toolchainInChain(chain), {
    python: false,
    cxx: false,
    make: false,
  });
});

test("the real Dockerfile.pinchy keeps the toolchain out of the runtime stage", () => {
  // The whole reason prod pays nothing for this. If a future edit moves the
  // apt line into `runtime`, the guard above still passes — so assert the
  // other half here.
  const stages = parseDockerfileStages(
    readFileSync(join(REPO_ROOT, "Dockerfile.pinchy"), "utf8"),
  );
  const runtime = stages.find((stage) => stage.name === "runtime");
  assert.ok(runtime, "Dockerfile.pinchy has no `runtime` stage any more");
  assert.deepEqual(toolchainInChain(resolveStageChain(stages, runtime.index)), {
    python: false,
    cxx: false,
    make: false,
  });
});
