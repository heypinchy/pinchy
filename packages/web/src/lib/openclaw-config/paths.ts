// Single source of truth for the openclaw.json file path. Lives in its own
// module so both `write.ts` and `normalize.ts` can import it without a cycle.
export const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";

// Origins OpenClaw seeds into `gateway.controlUi.allowedOrigins` for a
// non-loopback (`bind: "lan"`) gateway on its fixed port 18789. OpenClaw seeds
// these in memory only (never persisted), so Pinchy must emit them explicitly
// in every config write — otherwise the field appears/disappears between OC's
// in-memory config and Pinchy's on-disk regenerate, and OC's reload diff
// classifies the `gateway.controlUi` change as restart-class, triggering a
// SIGUSR1 restart cascade. Lives here (alongside CONFIG_PATH) so build.ts and
// targeted.ts can both import it without a module cycle.
export const OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS = [
  "http://localhost:18789",
  "http://127.0.0.1:18789",
];

// How long OpenClaw keeps inbound channel media under ~/.openclaw/media (see
// the `media` block in build.ts for why Pinchy sets it at all). Shared with the
// boot-time seed in targeted.ts: OpenClaw has no reload rule for `media`, so a
// value the seed did not already put on disk makes the first regenerate a
// gateway restart instead of a hot reload.
export const OPENCLAW_MEDIA_TTL_HOURS = 48;

// The gateway's run mode and bind interface. Pinchy always runs OpenClaw as a
// local gateway reached over the Docker network. Shared with the boot-time seed
// in targeted.ts: OpenClaw refuses to start on a config without gateway.mode,
// and adding mode/bind later is a restart-class `gateway` diff.
export const OPENCLAW_GATEWAY_MODE = "local";
export const OPENCLAW_GATEWAY_BIND = "lan";
