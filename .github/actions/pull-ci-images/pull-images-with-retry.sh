#!/usr/bin/env bash
# Pulls each given image ref, retrying transient registry failures.
#
# CI run 27339671342 (2026-06-11) lost two jobs to a brief ghcr.io outage
# ("context deadline exceeded" / "Client.Timeout exceeded while awaiting
# headers") before a single test ran. Same transient-5xx hardening family as
# the ollama-install and link-check retries from PR #471.
#
# PULL_RETRY_DELAY_SECONDS overrides the backoff so tests don't sleep.
# Covered by scripts/lib/pull-ci-images-retry.test.mjs against a stub docker.
set -euo pipefail

max_attempts=3
retry_delay="${PULL_RETRY_DELAY_SECONDS:-20}"

if [ "$#" -eq 0 ]; then
  echo "::error::pull-images-with-retry.sh was called without image refs"
  exit 1
fi

# Composite actions do NOT enforce `required: true` on inputs: a dropped
# `with:` field or a renamed build-image output arrives here as an empty
# string. Validate all refs up front so that fails with a wiring hint
# instead of burning retries on `docker pull ""`.
for image in "$@"; do
  if [ -z "$image" ]; then
    echo "::error::pull-images-with-retry.sh received an empty image ref — check the with: wiring of the calling step and the build-image job outputs"
    exit 1
  fi
done

pull_log="$(mktemp)"

for image in "$@"; do
  attempt=1
  until docker pull "$image" 2>&1 | tee "$pull_log"; do
    # Deterministic failures won't change on retry — fail immediately
    # instead of sitting through the backoff twice. Same classification
    # idea as the upgrade-sim compose pull in ci.yml. Errors that are
    # merely *probably* deterministic (denied/unauthorized) stay
    # retryable: GHCR hiccups have been seen wearing auth-shaped error
    # messages, and a wasted retry costs 40s while a wrongly skipped one
    # kills the job.
    if grep -qE "manifest unknown|not found|invalid reference format|name unknown" "$pull_log"; then
      echo "::error::docker pull ${image} failed for a non-transient reason (see output above) — retrying will not help."
      exit 1
    fi
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "::error::docker pull ${image} failed after ${max_attempts} attempts. GHCR is likely having an outage — re-run the job once it recovers."
      exit 1
    fi
    echo "::warning::docker pull ${image} failed (attempt ${attempt}/${max_attempts}). Retrying in ${retry_delay}s..."
    sleep "$retry_delay"
    attempt=$((attempt + 1))
  done
done
