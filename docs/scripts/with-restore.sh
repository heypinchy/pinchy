#!/bin/sh
# Runs a command, then restores the %%PINCHY_VERSION%% placeholders whether the
# command succeeded or not, and forwards the command's exit code.
#
# The build used to be `inject && astro build && restore`, which short-circuits:
# a failed or interrupted build never restores, leaving vX.Y.Z baked into the
# six committed docs source files inject-version.sh touched — where the next
# `git commit -a` picks them up. Both halves happened while building #769's
# anchor check: one build failed on an MDX syntax error, one was killed. The
# state is also sticky, because the next run finds no placeholders left to
# inject, so it registers nothing for the next restore to undo.
#
# Usage: sh scripts/with-restore.sh astro build

set -u

"$@"
status=$?

if ! sh "$(dirname "$0")/restore-placeholders.sh"; then
  # A restore that failed leaves vX.Y.Z in the source tree — the exact state
  # this wrapper exists to prevent. Never let it hide behind a green build.
  echo "[docs] restore-placeholders.sh FAILED — the source tree may still" \
    "carry an injected version." >&2
  if [ "$status" -eq 0 ]; then
    status=1
  fi
fi

exit $status
