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
// and adding mode/bind later is a restart-class `gateway` diff. entrypoint.sh
// writes the same pair as a shell literal; a test in openclaw-config.test.ts
// holds the two together.
export const OPENCLAW_GATEWAY_MODE = "local";
export const OPENCLAW_GATEWAY_BIND = "lan";

/**
 * Absolute path (inside the OpenClaw container) to the bundled EmbeddingGemma
 * GGUF used by memory-core's `local` embedding provider. Baked into the openclaw
 * image at build time so memory search works offline with no API key — see
 * Dockerfile.openclaw. Overridable via `MEMORY_EMBEDDING_MODEL_PATH` for
 * air-gapped forks that ship a different local model.
 */
export const MEMORY_EMBEDDING_MODEL_PATH =
  process.env.MEMORY_EMBEDDING_MODEL_PATH?.trim() ||
  "/opt/embedding-models/embeddinggemma-300m-qat-Q8_0.gguf";

/** `models.providers` key of the managed llama-server (the provider plugin's id). */
export const LLAMA_CPP_PROVIDER_ID = "llama-cpp";

/**
 * Absolute path (inside the OpenClaw container) to the llama-server binary the
 * llama.cpp provider runs for `local` embeddings since OpenClaw 2026.9. Baked
 * into the openclaw image (Dockerfile.openclaw, `llama-server` stage) — the
 * provider's own setup would download it, which an offline install cannot.
 * OpenClaw requires an absolute path here.
 */
export const LLAMA_SERVER_COMMAND = "/opt/llama-server/llama-server";

/**
 * The llama-server models preset. The provider writes it itself before it
 * starts the server — the embedding model from `memory.search.local.modelPath`
 * — at the path the server's `--models-preset` argument names. This is the
 * provider's own default location in OpenClaw's state dir.
 */
export const LLAMA_SERVER_PRESET_PATH = "/root/.openclaw/tools/llama.cpp/models.ini";

/**
 * Bundled OpenClaw plugins Pinchy needs in `plugins.allow` on every install
 * (why each one: build.ts, where the full allow-list is assembled). The boot
 * seed writes exactly these before the setup wizard: an allow-list keeps
 * OpenClaw 2026.9 from enabling the globally installed pinchy-* plugins before
 * Pinchy has written their config.
 */
export const REQUIRED_BUNDLED_PLUGINS = ["document-extract", LLAMA_CPP_PROVIDER_ID] as const;
