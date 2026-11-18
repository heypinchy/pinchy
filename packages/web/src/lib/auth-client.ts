import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";

// NOTE: no `apiKeyClient()` here, deliberately (#572). It would expose
// `authClient.apiKey.create/update/delete/get/list` to the browser — and
// lib/auth.ts's C1 guard 404s every one of those endpoints for client
// requests, on purpose: keys are issued and revoked only through the audited,
// admin-gated /api/settings/api-keys route. Registering the plugin would
// advertise an API that is designed to fail, and invite the next person to
// "fix" the guard so it works.
//
// `adminClient()` stays for one reason: it types `session.user.role`, which
// agent-settings-page-content.tsx reads. Its `authClient.admin.*` actions are
// dead on arrival — lib/auth.ts only answers clients on /sign-in/email,
// /sign-out and /get-session (CLIENT_REACHABLE_AUTH_PATHS) — and nothing here
// calls them. Don't add a call; add a Pinchy route.
export const authClient = createAuthClient({
  plugins: [adminClient()],
});
