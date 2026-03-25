#!/bin/sh
# Restores %%PINCHY_VERSION%% placeholders after a dev session or build.
# Ensures source files stay clean with placeholders (not hardcoded versions).
# Reads the injected version from .injected-version (written by inject-version.sh).

set -e

DOCS_DIR="$(cd "$(dirname "$0")/.." && pwd)"

INJECTED_VERSION_FILE="$DOCS_DIR/.injected-version"

if [ ! -f "$INJECTED_VERSION_FILE" ]; then
  echo "[docs] No .injected-version file — nothing to restore"
  exit 0
fi

TAG=$(cat "$INJECTED_VERSION_FILE")

if [ -z "$TAG" ]; then
  echo "WARNING: .injected-version is empty — skipping restore" >&2
  exit 0
fi

find "$DOCS_DIR/src" "$DOCS_DIR/public" \( -name '*.mdx' -o -name '*.md' -o -name '*.yml' \) -exec sed -i.bak "s/$TAG/%%PINCHY_VERSION%%/g" {} +
find "$DOCS_DIR/src" "$DOCS_DIR/public" -name '*.bak' -delete
rm -f "$INJECTED_VERSION_FILE"

echo "[docs] Restored %%PINCHY_VERSION%% placeholders (was: $TAG)"
