// Public surface of the openclaw-config module. All call-sites import via
// `@/lib/openclaw-config`; this re-export keeps them stable across the split
// from `openclaw-config.ts` into focused sub-modules (#233).
//
// File map:
//   build.ts       — regenerateOpenClawConfig (DB → openclaw.json)
//   targeted.ts    — narrow-scope writes that bypass full regeneration
//   write.ts       — atomic file writes + RPC push (internal)
//   normalize.ts   — openclaw#75534 workarounds, removable per #215 (internal)
//   secrets-bundle.ts — SecretsBundle assembly helper (internal)
//   paths.ts       — CONFIG_PATH constant (internal)
export { regenerateOpenClawConfig } from "./build";
export {
  sanitizeOpenClawConfig,
  seedRestartClassOverridesIfMissing,
  updateIdentityLinks,
  updateTelegramChannelConfig,
} from "./targeted";
