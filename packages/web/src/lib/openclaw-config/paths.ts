// Single source of truth for the openclaw.json file path. Lives in its own
// module so both `write.ts` and `normalize.ts` can import it without a cycle.
export const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";
