// Auto-generate BETTER_AUTH_SECRET if not set (same pattern as encryption.ts getOrCreateSecret)
if (!process.env.BETTER_AUTH_SECRET) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { existsSync, readFileSync, writeFileSync } = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require("crypto");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("path");

  const secretsDir = process.env.ENCRYPTION_KEY_DIR || "/app/secrets";
  const secretPath = join(secretsDir, ".better_auth_secret");

  try {
    if (existsSync(secretPath)) {
      process.env.BETTER_AUTH_SECRET = readFileSync(secretPath, "utf-8").trim();
    } else if (existsSync(secretsDir)) {
      const secret = randomBytes(32).toString("hex");
      writeFileSync(secretPath, secret, { mode: 0o600 });
      process.env.BETTER_AUTH_SECRET = secret;
      console.log("Generated BETTER_AUTH_SECRET (persisted to secrets volume)");
    }
  } catch {
    // Fall through — Better Auth handles missing secret with its own error
  }
}

// Suppress InsecureTransportWarning for internal OpenClaw ws:// connection.
// OpenClaw Gateway is never exposed publicly — ws:// is correct for container-internal traffic.
{
  const originalEmit = process.emit;
  process.emit = function (event, ...args) {
    if (event === "warning" && args[0]?.name === "InsecureTransportWarning") return false;
    return originalEmit.call(this, event, ...args);
  };
}

// Preload: set globalThis.AsyncLocalStorage before Next.js modules initialize.
// Next.js 16 expects this global but tsx's module loader can cause
// async-local-storage.js to run before Next.js's own require-hook sets it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AsyncLocalStorage } = require("node:async_hooks");
globalThis.AsyncLocalStorage = AsyncLocalStorage;
