// Single source of truth for the openclaw.json file path. Lives in its own
// module so both `write.ts` and `normalize.ts` can import it without a cycle
// (write.ts → normalize.ts → write.ts would otherwise loop on the
// `redactUnchangedEnvForApply` ↔ `pushConfigInBackground` edge).
export const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";
