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

### Full window vs. focused variants

Every capture is the **full 1280×720 app window** — the docs
(`docs.heypinchy.com`) use these so readers see *where* a feature lives.

Marketing pages shrink images hard (especially on 375px mobile), where a full
window becomes an unreadable slice. For the screens that appear large on the
marketing site we additionally capture a **focused element screenshot** of the
relevant panel, written to `output/focus/<name>.png` (same base name, `focus/`
subdir). These are **additive** — the full-window files are never replaced.

| Focused file | Element captured |
|------|-------------|
| `focus/agent-settings-permissions.png` | Content region (`<main>`, no sidebar/banner) |
| `focus/audit-trail.png` | Content region (`<main>`, no sidebar/banner) |
| `focus/usage-dashboard.png` | Content region (`<main>`, no sidebar/banner) |
| `focus/groups.png` | Content region (`<main>`, no sidebar/banner) |
| `focus/user-management.png` | Content region (`<main>`, no sidebar/banner) |

The selector is the only tuning knob — pass it as the 3rd arg to
`screenshot(page, name, selector)`. All five use `main` (the shadcn
`SidebarInset`): a fixed, viewport-sized box that drops the sidebar and the
already-hidden banners, so focused shots are about legibility, not banner
removal. Tighter per-panel selectors (e.g. just a tab panel's allow-list) are
possible but `main` is what we ship — element-screenshotting a tall panel
inside the scroll container hit Playwright stability timeouts, whereas `main`'s
fixed box is reliable.

Both variants ship in the `pinchy-screenshots` artifact (the upload is
recursive over `screenshots/output/`), so the website's `pull-screenshots.yml`
receives the `focus/` subdir automatically.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:7777` | Pinchy instance URL |
| `SCREENSHOT_DIR` | `screenshots/output` | Output directory |
