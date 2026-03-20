#!/usr/bin/env bash
# Seed Pinchy with demo data for screenshots.
# Expects Pinchy running at BASE_URL (default: http://localhost:7777).
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:7777}"
ADMIN_EMAIL="admin@demo.pinchy.dev"
ADMIN_PASSWORD="PinchyDemo2026!"
ADMIN_NAME="Sandra Chen"

echo "⏳ Waiting for Pinchy to be healthy..."
for i in $(seq 1 30); do
  if curl -sf "$BASE_URL/api/health" > /dev/null 2>&1; then
    echo "✅ Pinchy is healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "❌ Pinchy not healthy after 60s"
    exit 1
  fi
  sleep 2
done

echo "⏳ Waiting for infrastructure..."
for i in $(seq 1 15); do
  BODY=$(curl -sf "$BASE_URL/api/setup/status" 2>/dev/null || echo '{}')
  DB=$(echo "$BODY" | jq -r '.infrastructure.database // "unknown"')
  OC=$(echo "$BODY" | jq -r '.infrastructure.openclaw // "unknown"')
  if [ "$DB" = "connected" ] && [ "$OC" = "connected" ]; then
    echo "✅ Infrastructure ready"
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo "❌ Infrastructure not ready: db=$DB, openclaw=$OC"
    exit 1
  fi
  sleep 2
done

# --- Setup admin ---
echo "🔧 Running setup wizard..."
SETUP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$BASE_URL/api/setup" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$ADMIN_NAME\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")

if [ "$SETUP_STATUS" -eq 201 ]; then
  echo "✅ Admin account created"
elif [ "$SETUP_STATUS" -eq 403 ]; then
  echo "ℹ️  Setup already complete, continuing..."
else
  echo "❌ Setup failed (HTTP $SETUP_STATUS)"
  exit 1
fi

# --- Seed provider config directly in DB (skip API key validation) ---
echo "🔌 Configuring demo provider..."
docker compose exec -T db psql -U pinchy -d pinchy -c "
  INSERT INTO settings (key, value, encrypted)
  VALUES ('default_provider', 'anthropic', false)
  ON CONFLICT (key) DO UPDATE SET value = 'anthropic';
  INSERT INTO settings (key, value, encrypted)
  VALUES ('anthropic_api_key', 'sk-ant-demo-key-for-screenshots', true)
  ON CONFLICT (key) DO UPDATE SET value = 'sk-ant-demo-key-for-screenshots';
" > /dev/null 2>&1 && echo "  ✅ Provider configured (Anthropic)" || echo "  ⚠️  Provider config failed"

# --- Login to get session cookie ---
echo "🔑 Logging in..."
LOGIN_RESPONSE=$(curl -s -c /tmp/pinchy-cookies.txt \
  -X POST "$BASE_URL/api/auth/sign-in/email" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")

if echo "$LOGIN_RESPONSE" | jq -e '.user' > /dev/null 2>&1; then
  echo "✅ Logged in as $ADMIN_EMAIL"
else
  echo "❌ Login failed: $LOGIN_RESPONSE"
  exit 1
fi

# Helper: authenticated API call
api() {
  curl -s -b /tmp/pinchy-cookies.txt \
    -H "Content-Type: application/json" \
    "$@"
}

# --- Create demo agents ---
echo "🤖 Creating demo agents..."

# Agent 1: Knowledge base agent
api -X POST "$BASE_URL/api/agents" -d '{
  "name": "Research Assistant",
  "tagline": "Company knowledge at your fingertips",
  "templateId": "knowledge-base"
}' > /dev/null 2>&1 && echo "  ✅ Research Assistant" || echo "  ⚠️  Research Assistant (may exist)"

# Agent 2: Technical expert
api -X POST "$BASE_URL/api/agents" -d '{
  "name": "DevOps Helper",
  "tagline": "Infrastructure and deployment support",
  "templateId": "technical-expert"
}' > /dev/null 2>&1 && echo "  ✅ DevOps Helper" || echo "  ⚠️  DevOps Helper (may exist)"

# Agent 3: Custom agent
api -X POST "$BASE_URL/api/agents" -d '{
  "name": "HR Onboarding",
  "tagline": "New employee onboarding assistant"
}' > /dev/null 2>&1 && echo "  ✅ HR Onboarding" || echo "  ⚠️  HR Onboarding (may exist)"

# --- Invite demo users (creates pending invites) ---
echo "👥 Creating demo users..."

api -X POST "$BASE_URL/api/users/invite" -d '{
  "email": "maria.schmidt@demo.pinchy.dev",
  "name": "Maria Schmidt",
  "role": "member"
}' > /dev/null 2>&1 && echo "  ✅ Maria Schmidt (member)" || echo "  ⚠️  Maria Schmidt (may exist)"

api -X POST "$BASE_URL/api/users/invite" -d '{
  "email": "thomas.weber@demo.pinchy.dev",
  "name": "Thomas Weber",
  "role": "admin"
}' > /dev/null 2>&1 && echo "  ✅ Thomas Weber (admin)" || echo "  ⚠️  Thomas Weber (may exist)"

api -X POST "$BASE_URL/api/users/invite" -d '{
  "email": "lisa.mueller@demo.pinchy.dev",
  "name": "Lisa Müller",
  "role": "member"
}' > /dev/null 2>&1 && echo "  ✅ Lisa Müller (member)" || echo "  ⚠️  Lisa Müller (may exist)"

# --- Create groups (enterprise feature, may fail without key) ---
echo "🏷️  Creating groups..."

api -X POST "$BASE_URL/api/groups" -d '{
  "name": "Engineering",
  "description": "Development and DevOps team"
}' > /dev/null 2>&1 && echo "  ✅ Engineering" || echo "  ⚠️  Engineering (enterprise required?)"

api -X POST "$BASE_URL/api/groups" -d '{
  "name": "Human Resources",
  "description": "HR and people operations"
}' > /dev/null 2>&1 && echo "  ✅ Human Resources" || echo "  ⚠️  Human Resources (enterprise required?)"

echo ""
echo "🎉 Seed complete! Ready for screenshots."
echo "   Run: npx playwright test screenshots/capture.ts"
