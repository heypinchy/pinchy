#!/bin/bash
# Install pinchy-{files,odoo,web,email} plugin runtime dependencies from the
# baked /opt/<plugin>-deps bundles into each plugin's extension directory.
# Extracted from start-openclaw.sh so it is unit-testable (see
# packages/web/src/__tests__/lib/install-plugin-deps.test.ts), following the
# same extraction pattern as config/sync-plugins.sh.
#
# In dev mode, source files are volume-mounted from the host, but host
# node_modules contain macOS native bindings that won't work in Linux — so
# each plugin's node_modules dir is instead a target this script populates
# from the image's prebuilt bundle. Runs before every gateway start
# (including restarts after config changes).
#
# CRITICAL — mountpoint safety. docker-compose.dev.yml mounts a named shadow
# volume directly ON TOP of each of these four node_modules paths (to stop the
# host/container dependency ping-pong: this script's old `rm -rf` blew away
# the host's pnpm symlink farm through the bind mount, and a host `pnpm
# install` in turn wrote host-only symlinks into the container's tree that
# don't resolve inside Linux). A named-volume mount is a real mountpoint
# inside the container, and `rm -rf` on a mountpoint fails with "Device or
# resource busy" — you can remove its CONTENTS but not the mounted directory
# itself. So this empties the target's contents in place rather than deleting
# and recreating the directory. That also sidesteps the nesting bug plain
# `cp -r bundle dst` has when dst already exists (`cp -r` copies the source
# directory INTO an existing target, producing dst/node_modules) — `cp -a
# bundle/. dst/` copies the bundle's CONTENTS into dst, which is correct
# whether dst is a plain directory (prod, inside the named volume) or a
# mountpoint (dev).

PLUGIN_EXTENSIONS_ROOT="${PLUGIN_EXTENSIONS_ROOT:-/root/.openclaw/extensions}"
PLUGIN_DEPS_ROOT="${PLUGIN_DEPS_ROOT:-/opt}"

install_plugin_deps_for() {
    local plugin="$1"
    local bundle="$PLUGIN_DEPS_ROOT/${plugin}-deps/node_modules"
    local target="$PLUGIN_EXTENSIONS_ROOT/$plugin/node_modules"

    # No bundle baked for this plugin (context/audit/transcript/docs have no
    # external deps), or the plugin's extension dir isn't mounted here: no-op.
    [ -d "$bundle" ] || return 0
    [ -d "$PLUGIN_EXTENSIONS_ROOT/$plugin" ] || return 0

    mkdir -p "$target"
    # Empty the target's CONTENTS instead of removing the directory itself —
    # removing it would fail with "Device or resource busy" when target is a
    # mountpoint (dev shadow volume). No-op when target is already empty.
    find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    # Trailing "/." on the source copies its CONTENTS into target rather than
    # nesting a "node_modules" dir inside it.
    cp -a "$bundle/." "$target/"
}

install_plugin_deps() {
    for plugin in pinchy-files pinchy-odoo pinchy-web pinchy-email pinchy-image; do
        install_plugin_deps_for "$plugin"
    done
}

# Allow sourcing (to call install_plugin_deps from start-openclaw.sh) without
# executing, mirroring the guard style used elsewhere in config/*.sh.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    install_plugin_deps
fi
