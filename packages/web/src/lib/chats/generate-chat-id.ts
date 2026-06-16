/**
 * Mint a fresh, opaque chat id for a new chat (#508). The id becomes the
 * trailing segment of the OpenClaw session key
 * (`agent:<agentId>:direct:<userId>:<chatId>`) and the `/chat/<agentId>/<chatId>`
 * URL, so it must satisfy `chatIdSchema` (lowercase alphanumerics + dashes,
 * ≤64 chars). `crypto.randomUUID()` already emits lowercase hex + hyphens, so
 * its output passes that schema as-is — no normalization needed.
 */
export function generateChatId(): string {
  return crypto.randomUUID();
}
