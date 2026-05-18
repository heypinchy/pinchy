#!/bin/sh
# Restores %%PINCHY_VERSION%% placeholders after a dev session or build.
# Ensures source files stay clean with placeholders (not hardcoded versions).
#
# Reverts by moving the .preinject backup written by inject-version.sh back
# in place, so legitimate historical version strings in the source (e.g. the
# heading "Upgrading from v0.5.3 to %%PINCHY_VERSION%%") survive unmodified.

set -e

DOCS_DIR="$(cd "$(dirname "$0")/.." && pwd)"

INJECTED_VERSION_FILE="$DOCS_DIR/.injected-version"
INJECTED_FILES_LIST="$DOCS_DIR/.injected-files"

if [ ! -f "$INJECTED_VERSION_FILE" ]; then
  echo "[docs] No .injected-version file — nothing to restore"
  exit 0
fi

TAG=$(cat "$INJECTED_VERSION_FILE")

if [ -z "$TAG" ]; then
  echo "WARNING: .injected-version is empty — skipping restore" >&2
  exit 0
fi

if [ -f "$INJECTED_FILES_LIST" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if [ -f "$f.preinject" ]; then
      mv "$f.preinject" "$f"
    fi
  done < "$INJECTED_FILES_LIST"
  rm -f "$INJECTED_FILES_LIST"
fi

# Sweep any stragglers (e.g. a file was renamed mid-build): fall back to the
# legacy naive replacement only inside .preinject siblings we did not catch
# above. We deliberately do NOT do a global sed across all source files here,
# because that would clobber legitimate historical version references.
find "$DOCS_DIR/src" -name '*.preinject' -exec sh -c '
  orig=${1%.preinject}
  mv "$1" "$orig"
' sh {} \;

# Clean up cloud-init.yml mirror (regenerated each build).
rm -f "$DOCS_DIR/public/cloud-init.yml"
rm -f "$INJECTED_VERSION_FILE"

echo "[docs] Restored %%PINCHY_VERSION%% placeholders (was: $TAG)"
