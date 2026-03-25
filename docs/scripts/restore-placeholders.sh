#!/bin/sh
# Restores %%PINCHY_VERSION%% placeholders after a dev session or build.
# Ensures source files stay clean with placeholders (not hardcoded versions).

set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOCS_DIR="$(cd "$(dirname "$0")/.." && pwd)"

VERSION=$(node -p "require('$REPO_ROOT/packages/web/package.json').version" 2>/dev/null || true)

if [ -z "$VERSION" ]; then
  echo "WARNING: Could not read version — skipping restore" >&2
  exit 0
fi

TAG="v$VERSION"

find "$DOCS_DIR/src" "$DOCS_DIR/public" \( -name '*.mdx' -o -name '*.md' -o -name '*.yml' \) -exec sed -i.bak "s/$TAG/%%PINCHY_VERSION%%/g" {} +
find "$DOCS_DIR/src" "$DOCS_DIR/public" -name '*.bak' -delete

echo "[docs] Restored %%PINCHY_VERSION%% placeholders"
