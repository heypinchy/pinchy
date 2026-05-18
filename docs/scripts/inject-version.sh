#!/bin/sh
# Reads the Pinchy version and replaces %%PINCHY_VERSION%% placeholders
# in docs source files. Also generates public/cloud-init.yml from
# src/snippets/cloud-init.yml (the canonical source).
# Called automatically by the build/dev scripts — no manual step needed.
#
# Version sources (in priority order):
# 1. PINCHY_VERSION env var (set by CI)
# 2. Git tag on current commit (e.g., v0.2.1)
# 3. packages/web/package.json
#
# Each file we touch gets a sibling `.preinject` backup so that
# restore-placeholders.sh can revert byte-for-byte, including legitimate
# historical version strings (e.g. the heading "Upgrading from v0.5.3 to
# %%PINCHY_VERSION%%") that a naive sed-reverse would clobber.

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

# Find files that actually contain the placeholder — we only touch (and
# back up) those, so unrelated docs files are left alone.
PLACEHOLDER_FILES=$(grep -r '%%PINCHY_VERSION%%' "$DOCS_DIR/src" --include='*.mdx' --include='*.md' --include='*.yml' -l 2>/dev/null || true)

if [ -z "$PLACEHOLDER_FILES" ]; then
  echo "[docs] No %%PINCHY_VERSION%% placeholders found (version: $TAG)"
  exit 0
fi

COUNT=0
echo "$PLACEHOLDER_FILES" | while IFS= read -r f; do
  [ -z "$f" ] && continue
  cp "$f" "$f.preinject"
  # sed in-place with portable .bak suffix (works on both macOS and Linux)
  sed -i.bak "s/%%PINCHY_VERSION%%/$TAG/g" "$f"
  rm -f "$f.bak"
  COUNT=$((COUNT + 1))
done

# Track the tag and the touched file list so restore can revert exactly.
echo "$TAG" > "$DOCS_DIR/.injected-version"
echo "$PLACEHOLDER_FILES" > "$DOCS_DIR/.injected-files"

# Regenerate public/cloud-init.yml from the (now version-injected) source
cp "$DOCS_DIR/src/snippets/cloud-init.yml" "$DOCS_DIR/public/cloud-init.yml"

# Count outside the subshell pipe (which doesn't propagate the counter on POSIX sh)
COUNT=$(echo "$PLACEHOLDER_FILES" | grep -c '^' || true)
echo "[docs] Injected $TAG into $COUNT file(s)"
