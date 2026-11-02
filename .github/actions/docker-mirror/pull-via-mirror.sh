#!/usr/bin/env bash
# Pulls each given Docker Hub image ref from mirror.gcr.io and retags it under
# its plain name, so `docker compose` finds it locally and never asks
# docker.io (which rate-limits CI).
#
#   caddy:2                -> mirror.gcr.io/library/caddy:2
#   pgvector/pgvector:pg17 -> mirror.gcr.io/pgvector/pgvector:pg17
#
# mirror.gcr.io has transient misses: three CI runs in one afternoon died on
# "could not fetch content descriptor sha256:… (application/vnd.in-toto+json)
# from remote: not found" (and the same for an image layer). So each mirror
# pull is retried with backoff. Every mirror failure is treated as transient,
# "not found" included — unlike pull-ci-images, where "not found" from GHCR
# means the ref is wrong, here it is exactly the miss that clears on retry.
#
# Only when every mirror attempt has failed do we pull from docker.io itself.
# That spends rate-limit quota, which is what the mirror exists to avoid — but
# a likely success beats a certain job failure, and the ::warning:: keeps the
# fallback visible instead of letting it become the quiet normal.
#
# MIRROR_PULL_BACKOFF_SECONDS lists the sleeps between attempts (one more
# attempt than entries); tests set it to "0 0" so they don't sleep.
# Covered by scripts/lib/docker-mirror-pull.test.mjs against a stub docker.
set -euo pipefail

read -r -a backoff <<< "${MIRROR_PULL_BACKOFF_SECONDS:-10 30}"
max_attempts=$((${#backoff[@]} + 1))

if [ "$#" -eq 0 ]; then
  echo "::error::pull-via-mirror.sh was called without image refs"
  exit 1
fi

for image in "$@"; do
  case "$image" in
    */*) mirror_ref="mirror.gcr.io/${image}" ;;
    *) mirror_ref="mirror.gcr.io/library/${image}" ;;
  esac

  pulled=false
  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    # Inside an `if` condition, a failing pull does not trip `set -e`, so a
    # failed attempt falls through to the retry instead of ending the step.
    if docker pull "$mirror_ref"; then
      pulled=true
      break
    fi
    if [ "$attempt" -lt "$max_attempts" ]; then
      delay="${backoff[$((attempt - 1))]}"
      echo "::warning::docker pull ${mirror_ref} failed (attempt ${attempt}/${max_attempts}). Retrying in ${delay}s..."
      sleep "$delay"
    fi
  done

  if [ "$pulled" = true ]; then
    docker tag "$mirror_ref" "$image"
    continue
  fi

  echo "::warning::mirror.gcr.io failed ${max_attempts} times for ${image} — falling back to docker.io, which consumes Docker Hub rate-limit quota."
  if ! docker pull "$image"; then
    echo "::error::Could not pull ${image} from mirror.gcr.io (${max_attempts} attempts) or from docker.io. Both registries are failing — re-run the job once they recover."
    exit 1
  fi
done
