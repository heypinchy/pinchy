# Smithers Onboarding Interview Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Smithers interviews new users to learn about them (and for admins, their organization), then saves the context via tools — replacing the empty Settings → Context fields that nobody would fill out manually.

**Architecture:** A new OpenClaw plugin (`pinchy-context`) provides two tools that Smithers uses to save context. An `ONBOARDING.md` file in Smithers' workspace extends the system prompt to trigger the interview when context is missing. The existing context sync infrastructure handles propagation to all relevant agent workspaces.

---

## Trigger & Status Tracking

No extra database fields needed. The existing fields serve as status:

| Field | null | set (non-null) |
|-------|------|----------------|
| `users.context` | User onboarding pending | User onboarding complete |
| `settings.org_context` | Org onboarding pending (admin) | Org onboarding complete |

Existing users get onboarding automatically — the migration from the previous feature left `users.context` as null, and `org_context` is unset.

---

## Plugin: pinchy-context

A new plugin at `packages/plugins/pinchy-context/`, parallel to `pinchy-files`.

### Tools

**`save_user_context`**
- Parameter: `{ content: string }` — Markdown summary of user info
- HTTP call: `PUT /api/internal/users/{userId}/context` with Gateway-Token auth
- Available to: every Smithers agent

**`save_org_context`**
- Parameter: `{ content: string }` — Markdown summary of org info
- HTTP call: `PUT /api/internal/settings/context` with Gateway-Token auth
- Available to: Smithers agents of admin users only

### Plugin Config in openclaw.json

```json
"pinchy-context": {
  "enabled": true,
  "config": {
    "apiBaseUrl": "http://pinchy:7777",
    "gatewayToken": "...",
    "agents": {
      "smithers-uuid": {
        "tools": ["save_user_context"],
        "userId": "user-123"
      },
      "admin-smithers-uuid": {
        "tools": ["save_user_context", "save_org_context"],
        "userId": "admin-456"
      }
    }
  }
}
```

The `userId` is routing information (which user to save context for), not a security mechanism. Security comes from Pinchy controlling which agents get which tools at config generation time.

### Tool Return Value & ONBOARDING.md Deletion

The internal API returns `{ success: true, onboardingComplete: boolean }`. The plugin uses this to:

1. If `onboardingComplete: true` → delete `ONBOARDING.md` from the agent's workspace
2. Return a message to the agent indicating whether to continue with org questions or wrap up

Onboarding completion logic (in the Pinchy API):
- Normal user: complete after `save_user_context`
- Admin: complete after `save_org_context`, but only if `users.context` is also set

---

## Internal API Endpoints

New internal endpoints secured with the Gateway-Token (shared secret between Pinchy and OpenClaw).

**`PUT /api/internal/users/:userId/context`**
- Auth: Gateway-Token header
- Body: `{ content: string }`
- Saves to `users.context`, calls `syncUserContextToWorkspaces(userId)`, triggers restart
- Returns: `{ success: true, onboardingComplete: boolean }`
- `onboardingComplete` logic: if user is admin → check if org_context is also set; if normal user → always true

**`PUT /api/internal/settings/context`**
- Auth: Gateway-Token header
- Body: `{ content: string }`
- Saves via `setSetting("org_context", content)`, calls `syncOrgContextToWorkspaces()`, triggers restart
- Returns: `{ success: true, onboardingComplete: true }` (always true — this is the last step)

---

## ONBOARDING.md

A workspace file that extends Smithers' system prompt. Written when context is missing, deleted when onboarding is complete.

### Content for Normal Users

```markdown
## Onboarding

The user hasn't shared any context about themselves yet. Your job is to
get to know them through natural conversation.

Find out: their name, their role, what they work on, how they prefer to
communicate, and anything else that helps you be a better assistant.

Be conversational, not robotic. Don't fire off a list of questions —
weave them into the conversation naturally. If the user wants to talk
about something else first, help them with it — but always steer back to
learning about them when there's a natural opening. Be persistent but
not annoying.

Once you have their name, role, and at least 2-3 other useful details,
use the save_user_context tool to save a structured summary in Markdown.
```

### Additional Block for Admin Users

```markdown
After saving the user's personal context, learn about the organization:
company name, what they do, team structure, domain-specific terminology,
conventions. Again, be conversational — don't interrogate. Once you have
enough, use the save_org_context tool to save an organization summary.
```

### Lifecycle

**Created:**
- In `createSmithersAgent()` when `users.context` is null
- For existing users: a migration step writes ONBOARDING.md to all Smithers workspaces where `users.context` is null

**Deleted:**
- By the `pinchy-context` plugin when the API returns `onboardingComplete: true`
- After the restart, Smithers no longer has the onboarding instructions in the system prompt

---

## Smithers Tool Assignment

Smithers (personal agents) can now have `allowedTools`. The role-based logic lives in `createSmithersAgent()`:

- **All users:** `allowedTools: ["pinchy_save_user_context"]`
- **Admin users:** `allowedTools: ["pinchy_save_user_context", "pinchy_save_org_context"]`

The existing restriction that prevents admins from editing personal agent permissions in the UI stays in place — these tools are set programmatically, not through the Permissions tab.

### Config Generation

`regenerateOpenClawConfig()` reads `allowedTools` from the agent record (like it does for all agents). For personal agents with `pinchy_save_*` tools, it builds the `pinchy-context` plugin config using the agent's `ownerId` as `userId`. No role lookup needed — the tools were already assigned correctly at creation time.

---

## End-to-End Flow

### New User (non-admin)

1. Admin invites user → user claims invite → `createSmithersAgent()` runs
2. Smithers created with `allowedTools: ["pinchy_save_user_context"]`
3. ONBOARDING.md written to workspace (user version)
4. Config regenerated with `pinchy-context` plugin entry
5. User opens Smithers, starts chatting
6. Smithers sees ONBOARDING.md, starts getting to know the user
7. User can ask other things — Smithers helps but steers back to the interview
8. Smithers gathers enough info, calls `save_user_context` tool
9. Plugin calls `PUT /api/internal/users/{userId}/context`
10. API saves context, syncs to workspaces, returns `onboardingComplete: true`
11. Plugin deletes ONBOARDING.md, returns success to Smithers
12. Restart triggered — Smithers reloads with USER.md populated, no ONBOARDING.md
13. Future conversations: Smithers knows the user, behaves normally

### New Admin (first setup)

1. Admin creates account via setup wizard → `createSmithersAgent()` runs
2. Smithers created with `allowedTools: ["pinchy_save_user_context", "pinchy_save_org_context"]`
3. ONBOARDING.md written to workspace (admin version: user + org blocks)
4. Admin opens Smithers, starts chatting
5. Smithers interviews about the user first
6. Calls `save_user_context` → API returns `onboardingComplete: false` (admin, org missing)
7. Plugin keeps ONBOARDING.md, tells Smithers "User context saved, now ask about the organization"
8. Smithers interviews about the organization
9. Calls `save_org_context` → API returns `onboardingComplete: true`
10. Plugin deletes ONBOARDING.md
11. Restart triggered — org context synced to all shared agents

### Existing Users (after deploy)

1. Migration writes ONBOARDING.md to all Smithers workspaces where `users.context` is null
2. Migration updates Smithers `allowedTools` (based on owner's role)
3. Config regenerated
4. Next time user opens Smithers → onboarding flow starts (same as new user)

---

## Files to Create/Modify

| File | Change |
|------|--------|
| `packages/plugins/pinchy-context/` | NEW: Plugin with save_user_context and save_org_context tools |
| `packages/web/src/app/api/internal/users/[userId]/context/route.ts` | NEW: Internal API for user context (Gateway-Token auth) |
| `packages/web/src/app/api/internal/settings/context/route.ts` | NEW: Internal API for org context (Gateway-Token auth) |
| `packages/web/src/lib/personal-agent.ts` | Set allowedTools on Smithers, write ONBOARDING.md |
| `packages/web/src/lib/openclaw-config.ts` | Generate pinchy-context plugin config |
| `packages/web/src/lib/tool-registry.ts` | Register pinchy_save_user_context and pinchy_save_org_context |
| `packages/web/src/lib/workspace.ts` | Add ONBOARDING.md to writeWorkspaceFileInternal allowed files (or keep it unrestricted) |
| `drizzle/XXXX_*.sql` | Migration: set allowedTools + write ONBOARDING.md for existing Smithers |
| `packages/web/src/lib/smithers-soul.ts` | Reference onboarding in platform knowledge |
