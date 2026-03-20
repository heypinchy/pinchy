# Automated Screenshots

Captures screenshots of Pinchy's UI for the [marketing website](https://heypinchy.com).

## How it works

1. **`seed.sh`** — Starts a fresh Pinchy instance, creates admin account, demo agents, users, and groups
2. **`capture.ts`** — Playwright script that logs in and captures screenshots of each feature
3. **GitHub Actions** — Runs automatically on every release; can be triggered manually anytime

## Local development

```bash
# 1. Start Pinchy
docker compose up -d

# 2. Seed demo data
./screenshots/seed.sh

# 3. Capture screenshots
npx playwright test screenshots/capture.ts

# Screenshots land in screenshots/output/
```

## Screenshots captured

| File | Feature page |
|------|-------------|
| `chat-interface.png` | Chat UI with agent |
| `agent-list.png` | Agent management overview |
| `agent-settings-general.png` | Agent config — General tab |
| `agent-settings-personality.png` | Agent config — Personality & SOUL.md |
| `agent-settings-permissions.png` | Agent config — Tool permissions |
| `audit-trail.png` | Cryptographic audit log |
| `user-management.png` | User list & roles |
| `groups.png` | Group-based access control |
| `provider-settings.png` | AI provider configuration |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:7777` | Pinchy instance URL |
| `SCREENSHOT_DIR` | `screenshots/output` | Output directory |
