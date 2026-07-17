/**
 * Pins CI's two image-tag expressions together.
 *
 * ci.yml builds the Pinchy and OpenClaw images in a `build-images` MATRIX (one
 * runner each, so they build in parallel), and then fans them back in through a
 * tiny `build-image` job whose only product is the two tags the 11 downstream
 * Docker/E2E jobs pull. A matrix job cannot express per-entry outputs, so the
 * fan-in cannot read the tags out of the matrix — it RECOMPUTES them.
 *
 * That leaves two independent copies of the same expression, and nothing in
 * GitHub Actions would complain if they drifted: the matrix would push
 * `pinchy-ci:sha-abc`, the fan-in would export `pinchy-ci:abc`, and all 11
 * downstream jobs would fail at `docker pull` with a manifest-unknown error
 * that points at the pull, not at the typo. On a fork PR they'd be worse than
 * that — the local-build fallback would quietly paper over it.
 *
 * So: derive both sides textually and require them to be equal. Kept
 * dependency-free (no YAML parser) to match the other workflow sweeps in this
 * directory — the assertions only read literal tokens.
 */

import { splitWorkflowIntoJobs } from "./workflow-jobs.mjs";

/** The matrix job that actually builds and pushes the images. */
const BUILDER_JOB = "build-images";

/** The fan-in job whose outputs the downstream jobs consume. */
const FANIN_JOB = "build-image";

function jobBody(workflowPath, jobName) {
  const job = splitWorkflowIntoJobs(workflowPath).find((j) => j.jobName === jobName);
  if (!job) throw new Error(`ci.yml must define a "${jobName}" job`);
  return job.body;
}

/**
 * The concrete image tags `build-images` pushes, with the matrix resolved.
 *
 * Reads the single `tags:` template the build step passes to
 * docker/build-push-action and substitutes each matrix entry's `tag:` value for
 * `${{ matrix.tag }}`. `${{ github.sha }}` is left intact — it resolves
 * identically on both sides, so comparing the un-expanded expression is exactly
 * the comparison we want.
 *
 * @param {string} workflowPath absolute path to ci.yml
 * @returns {string[]} sorted, e.g. ["ghcr.io/…/pinchy-ci:sha-${{ github.sha }}", …]
 */
export function builtImageTags(workflowPath) {
  const body = jobBody(workflowPath, BUILDER_JOB);

  const template = /^\s+tags:\s*(\S.*?)\s*$/m.exec(body);
  if (!template) {
    throw new Error(`"${BUILDER_JOB}" must pass a \`tags:\` template to the build step`);
  }

  const entries = [...body.matchAll(/^\s+tag:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  if (entries.length === 0) {
    throw new Error(`"${BUILDER_JOB}" must define matrix entries carrying a \`tag:\``);
  }

  return entries.map((tag) => template[1].replaceAll("${{ matrix.tag }}", tag)).sort();
}

/**
 * The image tags `build-image` exports as job outputs.
 *
 * Reads the `echo "<key>=<value>" >> $GITHUB_OUTPUT` lines of its `tags` step.
 *
 * @param {string} workflowPath absolute path to ci.yml
 * @returns {string[]} sorted
 */
export function exportedImageTags(workflowPath) {
  const body = jobBody(workflowPath, FANIN_JOB);

  const tags = [...body.matchAll(/echo\s+"[A-Za-z0-9_-]+=([^"]+)"\s*>>\s*"?\$GITHUB_OUTPUT"?/g)].map(
    (m) => m[1]
  );
  if (tags.length === 0) {
    throw new Error(`"${FANIN_JOB}" must export image tags via $GITHUB_OUTPUT`);
  }

  return tags.sort();
}
