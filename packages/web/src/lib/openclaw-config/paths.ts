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
