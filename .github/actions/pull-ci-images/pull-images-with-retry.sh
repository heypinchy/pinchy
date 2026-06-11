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

for image in "$@"; do
  attempt=1
  until docker pull "$image"; do
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "::error::docker pull ${image} failed after ${max_attempts} attempts. GHCR is likely having an outage — re-run the job once it recovers."
      exit 1
    fi
    echo "::warning::docker pull ${image} failed (attempt ${attempt}/${max_attempts}). Retrying in ${retry_delay}s..."
    sleep "$retry_delay"
    attempt=$((attempt + 1))
  done
done
