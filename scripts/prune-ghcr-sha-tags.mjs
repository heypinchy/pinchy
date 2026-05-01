#!/usr/bin/env node
// Prune sha-* container tags from GHCR for a single package.
//
// Usage:
//   GH_TOKEN=... node scripts/prune-ghcr-sha-tags.mjs \
//     --org heypinchy --package pinchy [--keep 20] [--older-than-days 30] [--dry-run]
//
// In dry-run mode (default) it only prints what *would* be deleted. Pass
// --no-dry-run to actually delete. The companion logic in
// scripts/lib/prune-ghcr-logic.mjs is unit-tested with fixtures.

import { spawnSync } from "node:child_process";
import { selectVersionsToDelete } from "./lib/prune-ghcr-logic.mjs";

function parseArgs(argv) {
  const args = {
    org: null,
    pkg: null,
    keepCount: 20,
    olderThanDays: null,
    dryRun: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--org":
        args.org = next();
        break;
      case "--package":
        args.pkg = next();
        break;
      case "--keep":
        args.keepCount = Number.parseInt(next(), 10);
        break;
      case "--older-than-days":
        args.olderThanDays = Number.parseInt(next(), 10);
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--no-dry-run":
        args.dryRun = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.org || !args.pkg) {
    throw new Error("--org and --package are required");
  }
  if (!Number.isInteger(args.keepCount) || args.keepCount < 0) {
    throw new Error(
      `--keep must be a non-negative integer, got: ${args.keepCount}`,
    );
  }
  if (
    args.olderThanDays !== null &&
    (!Number.isInteger(args.olderThanDays) || args.olderThanDays < 0)
  ) {
    throw new Error(
      `--older-than-days must be a non-negative integer, got: ${args.olderThanDays}`,
    );
  }
  return args;
}

function ghApi(args) {
  const result = spawnSync("gh", ["api", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`gh api ${args.join(" ")} failed (exit ${result.status})`);
  }
  return result.stdout;
}

function listVersions({ org, pkg }) {
  // --jq '.[]' flattens each page's array into a stream of one JSON object
  // per line, sidestepping the "concatenated arrays" issue with --paginate
  // on array endpoints.
  const stdout = ghApi([
    "--paginate",
    `/orgs/${org}/packages/container/${pkg}/versions`,
    "--jq",
    ".[]",
  ]);
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function deleteVersion({ org, pkg, id }) {
  ghApi([
    "-X",
    "DELETE",
    `/orgs/${org}/packages/container/${pkg}/versions/${id}`,
  ]);
}

function summarise(version) {
  const tags = version?.metadata?.container?.tags ?? [];
  return `id=${version.id} created=${version.created_at} tags=[${tags.join(", ")}]`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const mode = args.dryRun ? "DRY RUN" : "LIVE";
  console.log(
    `[${mode}] Pruning ghcr.io/${args.org}/${args.pkg}: keep=${args.keepCount}` +
      (args.olderThanDays !== null
        ? ` olderThanDays=${args.olderThanDays}`
        : ""),
  );

  const versions = listVersions(args);
  console.log(`Fetched ${versions.length} versions from GHCR.`);

  const toDelete = selectVersionsToDelete(versions, {
    keepCount: args.keepCount,
    deleteOlderThanDays: args.olderThanDays,
    now: new Date(),
  });

  if (toDelete.length === 0) {
    console.log("Nothing to prune.");
    return;
  }

  console.log(`Selected ${toDelete.length} versions to delete:`);
  for (const version of toDelete) {
    console.log(`  - ${summarise(version)}`);
  }

  if (args.dryRun) {
    console.log("[DRY RUN] No deletions performed.");
    return;
  }

  let deleted = 0;
  let failed = 0;
  for (const version of toDelete) {
    try {
      deleteVersion({ org: args.org, pkg: args.pkg, id: version.id });
      deleted++;
    } catch (error) {
      failed++;
      console.error(`Failed to delete id=${version.id}: ${error.message}`);
    }
  }
  console.log(`Deleted ${deleted}/${toDelete.length} versions.`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
