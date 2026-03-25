#!/bin/sh
# Reads the Pinchy version and replaces %%PINCHY_VERSION%% placeholders
# in docs source files and public assets (e.g., cloud-init.yml).
# Called automatically by the build/dev scripts — no manual step needed.
#
# Version sources (in priority order):
# 1. PINCHY_VERSION env var (set by CI)
# 2. Git tag on current commit (e.g., v0.2.1)
# 3. packages/web/package.json

set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOCS_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Try env var first (CI sets this)
TAG="$PINCHY_VERSION"

# Try git tag
if [ -z "$TAG" ]; then
  TAG=$(git -C "$REPO_ROOT" describe --tags --exact-match 2>/dev/null || true)
fi

# Fall back to package.json
if [ -z "$TAG" ]; then
  VERSION=$(node -p "require('$REPO_ROOT/packages/web/package.json').version" 2>/dev/null || true)
  if [ -n "$VERSION" ]; then
    TAG="v$VERSION"
  fi
fi

if [ -z "$TAG" ]; then
  echo "WARNING: Could not determine Pinchy version — placeholders will remain" >&2
  exit 0
fi

# Count replacements for feedback
COUNT=$(grep -r '%%PINCHY_VERSION%%' "$DOCS_DIR/src" "$DOCS_DIR/public" --include='*.mdx' --include='*.md' --include='*.yml' -l 2>/dev/null | wc -l | tr -d ' ')

if [ "$COUNT" = "0" ]; then
  echo "[docs] No %%PINCHY_VERSION%% placeholders found (version: $TAG)"
  exit 0
fi

# Save the injected tag so restore-placeholders.sh can reverse it exactly
echo "$TAG" > "$DOCS_DIR/.injected-version"

# Replace in-place (works on both macOS and Linux)
find "$DOCS_DIR/src" "$DOCS_DIR/public" \( -name '*.mdx' -o -name '*.md' -o -name '*.yml' \) -exec sed -i.bak "s/%%PINCHY_VERSION%%/$TAG/g" {} +
find "$DOCS_DIR/src" "$DOCS_DIR/public" -name '*.bak' -delete

echo "[docs] Injected $TAG into $COUNT file(s)"
