#!/bin/sh
# Sync Pinchy plugin SOURCE from the image into the shared openclaw-extensions
# volume, on every pinchy-container start. Extracted from entrypoint.sh so the
# node_modules-preservation invariant below is unit-testable
# (see packages/web/src/__tests__/lib/sync-plugins.test.ts).
#
# The named Docker volume is only seeded from the image on first creation;
# upgrades leave stale content from the previous image, so we re-sync each boot.
#
# CRITICAL — never touch node_modules. Plugin node_modules are installed ONLY by
# the OpenClaw container's start-openclaw.sh (install_plugin_deps) from baked
# /opt/<plugin>-deps bundles; the pinchy image ships plugin SOURCE with NO
# node_modules. Before PR #275 the sync was a non-destructive overlay; #275
# changed it to `rm -rf "$dst"; cp -r`, which — because the image source has no
# node_modules — made `diff` ALWAYS differ and wiped the OpenClaw-installed deps.
# On a pinchy-only restart (deps not reinstalled until openclaw restarts) the
# three external-dep plugins (pinchy-web/@mozilla/readability,
# pinchy-files/mammoth, pinchy-odoo/odoo-node) then fail to load with
# "Cannot find module". So: exclude node_modules from the change-detection AND
# from the deletion — one writer (openclaw), zero deleters.
#
# Idempotent: untouched source means no spurious inotify events for OpenClaw's
# plugin watcher (which would otherwise re-init the plugin runtime every boot).

PLUGIN_SRC_ROOT="${PLUGIN_SRC_ROOT:-/app/pinchy-plugins}"
PLUGIN_DST_ROOT="${PLUGIN_DST_ROOT:-/openclaw-extensions}"

for plugin_src in "$PLUGIN_SRC_ROOT"/*/; do
  [ -d "$plugin_src" ] || continue
  plugin_name=$(basename "$plugin_src")
  plugin_dst="$PLUGIN_DST_ROOT/$plugin_name"
  if [ ! -d "$plugin_dst" ] || ! diff -rq --exclude=node_modules "$plugin_src" "$plugin_dst" >/dev/null 2>&1; then
    mkdir -p "$plugin_dst"
    # Replace only stale SOURCE entries; never delete node_modules.
    find "$plugin_dst" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
    cp -r "$plugin_src". "$plugin_dst"/
    echo "[entrypoint] synced plugin: $plugin_name"
  fi
done
