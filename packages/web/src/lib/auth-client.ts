import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";

// NOTE: no `apiKeyClient()` here, deliberately (#572). It would expose
// `authClient.apiKey.create/update/delete/get/list` to the browser — and
// lib/auth.ts's C1 guard 404s every one of those endpoints for client
// requests, on purpose: keys are issued and revoked only through the audited,
// admin-gated /api/settings/api-keys route. Registering the plugin would
// advertise an API that is designed to fail, and invite the next person to
// "fix" the guard so it works.
export const authClient = createAuthClient({
  plugins: [adminClient()],
});
