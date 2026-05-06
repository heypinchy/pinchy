#!/usr/bin/env bash
# Seed Pinchy with demo data for screenshots.
# See SCENARIO.md for the full Springfield Energy backstory.
#
# Usage: ./screenshots/seed.sh
# Expects: docker compose up -d (Pinchy running at localhost:7777)
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:7777}"
COOKIE_JAR="/tmp/pinchy-cookies.txt"
ADMIN_EMAIL="monty@snpp.com"
ADMIN_PASSWORD="PinchyDemo2026!"
ADMIN_NAME="Monty Burns"

rm -f "$COOKIE_JAR"

api() {
  # Origin is required by the CSRF gate added in PR #235 for every
  # state-changing /api/* route. Setting it on every call (including GETs,
  # where it's a no-op) keeps the wrapper a single source of truth.
  curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -H "Origin: $BASE_URL" \
    "$@"
}

# =====================================================
# 1. Wait for Pinchy to be healthy
# =====================================================
echo "⏳ Waiting for Pinchy to be healthy..."
for i in $(seq 1 60); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/health" 2>/dev/null || echo "000")
  [ "$STATUS" = "200" ] && break
  sleep 2
done
[ "$STATUS" != "200" ] && echo "❌ Pinchy didn't start" && exit 1
echo "✅ Pinchy is healthy"

echo "⏳ Waiting for infrastructure..."
for i in $(seq 1 30); do
  INFRA=$(api "$BASE_URL/api/setup/status" 2>/dev/null | grep -o '"openclaw":"connected"' || echo "")
  [ -n "$INFRA" ] && break
  sleep 2
done
echo "✅ Infrastructure ready"

# =====================================================
# 2. Setup admin account
# =====================================================
echo "🔧 Running setup wizard..."
api -X POST "$BASE_URL/api/setup" -d "{
  \"email\": \"$ADMIN_EMAIL\",
  \"password\": \"$ADMIN_PASSWORD\",
  \"name\": \"$ADMIN_NAME\"
}" > /dev/null 2>&1
echo "✅ Admin account created ($ADMIN_NAME)"

# =====================================================
# 3. Configure provider (unencrypted for demo)
# =====================================================
echo "🔌 Configuring demo provider..."
docker compose exec -T db psql -U pinchy -d pinchy -c "
  INSERT INTO settings (key, value, encrypted)
  VALUES ('default_provider', 'anthropic', false)
  ON CONFLICT (key) DO UPDATE SET value = 'anthropic';
  INSERT INTO settings (key, value, encrypted)
  VALUES ('anthropic_api_key', 'sk-ant-demo-key-for-screenshots', false)
  ON CONFLICT (key) DO UPDATE SET value = 'sk-ant-demo-key-for-screenshots', encrypted = false;
" > /dev/null 2>&1 && echo "  ✅ Provider configured (Anthropic)" || echo "  ⚠️  Provider config failed"

# =====================================================
# 4. Login
# =====================================================
echo "🔑 Logging in..."
api -X POST "$BASE_URL/api/auth/sign-in/email" -d "{
  \"email\": \"$ADMIN_EMAIL\",
  \"password\": \"$ADMIN_PASSWORD\"
}" > /dev/null 2>&1

# Verify login
AUTH_CHECK=$(api "$BASE_URL/api/agents" 2>/dev/null)
if echo "$AUTH_CHECK" | grep -q "Unauthorized"; then
  echo "❌ Login failed"
  exit 1
fi
echo "✅ Logged in as $ADMIN_EMAIL"

ADMIN_ID=$(docker compose exec -T db psql -U pinchy -d pinchy -t -A -c "SELECT id FROM \"user\" WHERE email = '$ADMIN_EMAIL';")

# =====================================================
# 5. Enterprise key (if available)
# =====================================================
if [ -n "${PINCHY_ENTERPRISE_KEY:-}" ]; then
  echo "🔑 Activating enterprise features..."
  api -X PUT "$BASE_URL/api/enterprise/key" -d "{\"key\":\"$PINCHY_ENTERPRISE_KEY\"}" > /dev/null 2>&1 \
    && echo "  ✅ Enterprise key activated" || echo "  ⚠️  Enterprise key failed"
else
  echo "ℹ️  No PINCHY_ENTERPRISE_KEY set, skipping enterprise activation"
fi

# =====================================================
# 6. Create agents (Springfield characters)
# =====================================================
echo "🤖 Creating demo agents..."

create_agent() {
  local NAME="$1" TAGLINE="$2" TEMPLATE="$3" GREETING="$4" PRESET="$5" VARNAME="$6"
  RESULT=$(api -X POST "$BASE_URL/api/agents" -d "{
    \"name\":\"$NAME\",
    \"tagline\":\"$TAGLINE\",
    \"templateId\":\"$TEMPLATE\",
    \"greetingMessage\":\"$GREETING\",
    \"personalityPresetId\":\"$PRESET\"
  }" 2>&1)
  local ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
  if [ -n "$ID" ]; then
    echo "  ✅ $NAME ($ID)"
    eval "$VARNAME=$ID"
  else
    echo "  ⚠️  $NAME failed: $RESULT"
    eval "$VARNAME=''"
  fi
}

FRINK_ID=""
TIBOR_ID=""
MINDY_ID=""

create_agent "Frink" "Reactor docs and safety protocols" "custom" \
  "Greetings, {user}! Professor Frink here — your go-to for reactor documentation, safety protocols, and all things technical. What would you like to look up?" \
  "the-professor" FRINK_ID

create_agent "Tibor" "Infrastructure and deployment support" "custom" \
  "Standing by, {user}. Ready for infrastructure tasks, deployments, and system operations. What needs attention?" \
  "the-pilot" TIBOR_ID

create_agent "Mindy" "New employee onboarding" "custom" \
  "Hi {user}! Welcome — I'm here to help new team members get up to speed. Whether it's your first day or you're onboarding someone new, I've got you covered. Where should we start?" \
  "the-coach" MINDY_ID

# Force personality presets via PATCH (create may not apply them)
echo "🎭 Setting personality presets..."
[ -n "$FRINK_ID" ] && api -X PATCH "$BASE_URL/api/agents/$FRINK_ID" -d '{"personalityPresetId":"the-professor"}' > /dev/null 2>&1
[ -n "$TIBOR_ID" ] && api -X PATCH "$BASE_URL/api/agents/$TIBOR_ID" -d '{"personalityPresetId":"the-pilot"}' > /dev/null 2>&1
[ -n "$MINDY_ID" ] && api -X PATCH "$BASE_URL/api/agents/$MINDY_ID" -d '{"personalityPresetId":"the-coach"}' > /dev/null 2>&1
echo "  ✅ Presets applied"

# =====================================================
# 7. Configure directories and agent permissions
# =====================================================
echo "📁 Configuring directories and permissions..."

# Create directories in OpenClaw container with human-friendly names
# scan_data_directories() uses basename as label, so name the folders nicely
docker compose exec -T openclaw sh -c '
  mkdir -p "/data/Reactor Operations" "/data/Safety Protocols" "/data/Employee Handbook" \
           "/data/NRC Inspections" "/data/Executive Memos" "/data/Budget Reports"
'
# Trigger rescan so data-directories.json picks them up
docker compose exec -T openclaw sh -c '
  ls -d /data/*/ 2>/dev/null | sed "s|/$||" | \
    node -e "const lines=require(\"fs\").readFileSync(\"/dev/stdin\",\"utf8\").trim().split(\"\n\").filter(Boolean); \
    const dirs=lines.map(p=>({path:p,name:require(\"path\").basename(p)})); \
    console.log(JSON.stringify({directories:dirs}))" \
    > /root/.openclaw/data-directories.json
'

# Verify
DIR_COUNT=$(docker compose exec -T pinchy sh -c 'cat /openclaw-config/data-directories.json' 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('directories',[])))" 2>/dev/null || echo "0")
echo "  ✅ $DIR_COUNT directories configured"

# Web Search integration (enables hasApiKey path in Web Search UI for screenshots)
echo "🔍 Adding Web Search integration..."
api -X POST "$BASE_URL/api/integrations" -d '{
  "type":"web-search",
  "name":"Brave Search",
  "description":"Demo API key for screenshots",
  "credentials":{"apiKey":"BSAdemo-screenshot-placeholder-key"}
}' > /dev/null 2>&1 && echo "  ✅ Brave Search connected" || echo "  ⚠️  Web Search connection failed"

# Frink: files (3/6 directories) + web search with mixed domain restrictions
if [ -n "$FRINK_ID" ]; then
  api -X PATCH "$BASE_URL/api/agents/$FRINK_ID" -d '{
    "allowedTools": ["pinchy_ls", "pinchy_read", "pinchy_web_search", "pinchy_web_fetch"],
    "pluginConfig": {
      "pinchy-files": { "allowed_paths": ["/data/Reactor Operations", "/data/Safety Protocols", "/data/Employee Handbook"] },
      "pinchy-web": {
        "allowedDomains": ["nrc.gov", "iaea.org", "docs.springfield.energy"],
        "excludedDomains": ["reddit.com"],
        "freshness": "pw",
        "language": "en",
        "country": "US"
      }
    }
  }' > /dev/null 2>&1 && echo "  ✅ Frink: files + web search with domain restrictions" || echo "  ⚠️  Frink config failed"
fi

# Tibor: safe + powerful tools
if [ -n "$TIBOR_ID" ]; then
  api -X PATCH "$BASE_URL/api/agents/$TIBOR_ID" -d '{
    "allowedTools": ["pinchy_ls", "pinchy_read", "shell", "web_fetch"],
    "pluginConfig": { "pinchy-files": { "allowed_paths": ["/data/Reactor Operations"] } }
  }' > /dev/null 2>&1 && echo "  ✅ Tibor: safe + powerful tools" || echo "  ⚠️  Tibor config failed"
fi

# =====================================================
# 8. Create users (directly in DB for active status)
# =====================================================
echo "👥 Creating demo users..."

docker compose exec -T db psql -U pinchy -d pinchy <<'SQL'
INSERT INTO "user" (id, name, email, role, email_verified, created_at, updated_at) VALUES
  ('usr_carl_carlson', 'Carl Carlson', 'carl@snpp.com', 'admin', true, NOW() - interval '14 days', NOW() - interval '2 hours'),
  ('usr_homer_jay', 'Homer Jay', 'homer@snpp.com', 'member', true, NOW() - interval '10 days', NOW() - interval '1 day'),
  ('usr_lenny_leonard', 'Lenny Leonard', 'lenny@snpp.com', 'member', true, NOW() - interval '7 days', NOW() - interval '3 days')
ON CONFLICT (email) DO NOTHING;

-- Pending invite (Frank hasn't joined yet)
INSERT INTO invites (id, token_hash, email, role, type, created_by, created_at, expires_at) VALUES
  ('inv_frank', 'hash_frank', 'frank@springfield.energy', 'member', 'invite',
   (SELECT id FROM "user" WHERE email = 'monty@snpp.com'),
   NOW() - interval '1 day', NOW() + interval '6 days')
ON CONFLICT DO NOTHING;
SQL
echo "  ✅ 3 active users + 1 pending invite (Frank Grimes)"

# =====================================================
# 9. Create groups + assign members and agents
# =====================================================
echo "🏷️  Creating groups..."

GRP1=$(api -X POST "$BASE_URL/api/groups" -d '{"name":"Reactor Operations","description":"Core reactor team and shift workers"}' 2>/dev/null)
GRP1_ID=$(echo "$GRP1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")

GRP2=$(api -X POST "$BASE_URL/api/groups" -d '{"name":"Safety & Compliance","description":"Safety protocols and NRC compliance"}' 2>/dev/null)
GRP2_ID=$(echo "$GRP2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")

GRP3=$(api -X POST "$BASE_URL/api/groups" -d '{"name":"Executive Office","description":"Executive team and strategic planning"}' 2>/dev/null)
GRP3_ID=$(echo "$GRP3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")

if [ -n "$GRP1_ID" ]; then
  echo "  ✅ Reactor Operations ($GRP1_ID)"
  docker compose exec -T db psql -U pinchy -d pinchy -c "
    INSERT INTO user_groups (user_id, group_id) VALUES
      ('$ADMIN_ID', '$GRP1_ID'),
      ('usr_carl_carlson', '$GRP1_ID'),
      ('usr_homer_jay', '$GRP1_ID'),
      ('usr_lenny_leonard', '$GRP1_ID')
    ON CONFLICT DO NOTHING;
    INSERT INTO agent_groups (agent_id, group_id) VALUES
      ('$FRINK_ID', '$GRP1_ID'),
      ('$TIBOR_ID', '$GRP1_ID')
    ON CONFLICT DO NOTHING;
  " > /dev/null 2>&1
else
  echo "  ⚠️  Reactor Operations (enterprise required)"
fi

if [ -n "$GRP2_ID" ]; then
  echo "  ✅ Safety & Compliance ($GRP2_ID)"
  docker compose exec -T db psql -U pinchy -d pinchy -c "
    INSERT INTO user_groups (user_id, group_id) VALUES
      ('$ADMIN_ID', '$GRP2_ID'),
      ('usr_carl_carlson', '$GRP2_ID')
    ON CONFLICT DO NOTHING;
    INSERT INTO agent_groups (agent_id, group_id) VALUES
      ('$FRINK_ID', '$GRP2_ID')
    ON CONFLICT DO NOTHING;
  " > /dev/null 2>&1
else
  echo "  ⚠️  Safety & Compliance (enterprise required)"
fi

if [ -n "$GRP3_ID" ]; then
  echo "  ✅ Executive Office ($GRP3_ID)"
  docker compose exec -T db psql -U pinchy -d pinchy -c "
    INSERT INTO user_groups (user_id, group_id) VALUES
      ('$ADMIN_ID', '$GRP3_ID'),
      ('usr_carl_carlson', '$GRP3_ID')
    ON CONFLICT DO NOTHING;
  " > /dev/null 2>&1
else
  echo "  ⚠️  Executive Office (enterprise required)"
fi

# Set Frink access to Restricted + Reactor Ops & Safety groups
if [ -n "$FRINK_ID" ] && [ -n "$GRP1_ID" ]; then
  api -X PATCH "$BASE_URL/api/agents/$FRINK_ID" -d "{\"visibility\":\"restricted\"}" > /dev/null 2>&1
  echo "  ✅ Frink: restricted to Reactor Ops + Safety"
fi

# =====================================================
# 10. Fake audit trail (diverse, realistic entries)
# =====================================================
echo "📋 Creating diverse audit trail entries..."

docker compose exec -T db psql -U pinchy -d pinchy <<SQL
ALTER TABLE audit_log DISABLE TRIGGER no_delete;
ALTER TABLE audit_log DISABLE TRIGGER no_update;
DELETE FROM audit_log;
ALTER TABLE audit_log ENABLE TRIGGER no_delete;
ALTER TABLE audit_log ENABLE TRIGGER no_update;

INSERT INTO audit_log (timestamp, actor_type, actor_id, event_type, resource, detail, row_hmac) VALUES
  -- Day 1: Setup
  (NOW() - interval '14 days 2 hours', 'user', '$ADMIN_ID', 'auth.login', NULL,
   '{"email":"monty@snpp.com"}', 'hmac_placeholder_01'),

  (NOW() - interval '14 days 1 hour', 'user', '$ADMIN_ID', 'settings.updated', 'settings:default_provider',
   '{"key":"default_provider","value":"anthropic"}', 'hmac_placeholder_02'),

  (NOW() - interval '14 days', 'user', '$ADMIN_ID', 'agent.created', 'agent:$FRINK_ID',
   '{"name":"Frink","model":"anthropic/claude-haiku-4-5-20251001","templateId":"custom"}', 'hmac_placeholder_03'),

  (NOW() - interval '13 days 23 hours', 'user', '$ADMIN_ID', 'agent.created', 'agent:$TIBOR_ID',
   '{"name":"Tibor","model":"anthropic/claude-haiku-4-5-20251001","templateId":"custom"}', 'hmac_placeholder_04'),

  (NOW() - interval '13 days 22 hours', 'user', '$ADMIN_ID', 'agent.created', 'agent:$MINDY_ID',
   '{"name":"Mindy","model":"anthropic/claude-haiku-4-5-20251001","templateId":"custom"}', 'hmac_placeholder_05'),

  -- Invites
  (NOW() - interval '13 days', 'user', '$ADMIN_ID', 'user.invited', NULL,
   '{"email":"carl@snpp.com","role":"admin"}', 'hmac_placeholder_06'),

  (NOW() - interval '12 days', 'user', '$ADMIN_ID', 'user.invited', NULL,
   '{"email":"homer@snpp.com","role":"member"}', 'hmac_placeholder_07'),

  (NOW() - interval '10 days', 'user', 'usr_carl_carlson', 'auth.login', NULL,
   '{"email":"carl@snpp.com"}', 'hmac_placeholder_08'),

  -- Agent config
  (NOW() - interval '9 days', 'user', '$ADMIN_ID', 'agent.updated', 'agent:$FRINK_ID',
   '{"field":"allowedTools","added":["pinchy_ls","pinchy_read"]}', 'hmac_placeholder_09'),

  (NOW() - interval '8 days', 'user', 'usr_carl_carlson', 'agent.updated', 'agent:$TIBOR_ID',
   '{"field":"allowedTools","added":["shell","web_fetch"]}', 'hmac_placeholder_10'),

  -- More team joins
  (NOW() - interval '7 days', 'user', '$ADMIN_ID', 'user.invited', NULL,
   '{"email":"lenny@snpp.com","role":"member"}', 'hmac_placeholder_11'),

  (NOW() - interval '7 days', 'user', 'usr_homer_jay', 'auth.login', NULL,
   '{"email":"homer@snpp.com"}', 'hmac_placeholder_12'),

  -- Agent tool usage
  (NOW() - interval '6 days', 'agent', '$FRINK_ID', 'tool.executed', NULL,
   '{"tool":"pinchy_read","path":"/data/safety-protocols/emergency-procedures.md"}', 'hmac_placeholder_13'),

  (NOW() - interval '5 days', 'agent', '$TIBOR_ID', 'tool.executed', NULL,
   '{"tool":"shell","command":"docker ps --format table"}', 'hmac_placeholder_14'),

  (NOW() - interval '5 days', 'user', '$ADMIN_ID', 'user.invited', NULL,
   '{"email":"frank@snpp.com","role":"member"}', 'hmac_placeholder_15'),

  (NOW() - interval '4 days', 'user', 'usr_lenny_leonard', 'auth.login', NULL,
   '{"email":"lenny@snpp.com"}', 'hmac_placeholder_16'),

  -- Group creation
  (NOW() - interval '3 days', 'user', '$ADMIN_ID', 'group.created', NULL,
   '{"name":"Reactor Operations"}', 'hmac_placeholder_17'),

  (NOW() - interval '3 days', 'user', '$ADMIN_ID', 'group.created', NULL,
   '{"name":"Safety & Compliance"}', 'hmac_placeholder_18'),

  -- Recent activity
  (NOW() - interval '2 days', 'user', 'usr_carl_carlson', 'agent.updated', 'agent:$MINDY_ID',
   '{"field":"personalityPresetId","value":"the-coach"}', 'hmac_placeholder_19'),

  (NOW() - interval '1 day', 'agent', '$FRINK_ID', 'tool.executed', NULL,
   '{"tool":"pinchy_ls","path":"/data/reactor-operations/"}', 'hmac_placeholder_20'),

  (NOW() - interval '6 hours', 'user', 'usr_homer_jay', 'auth.login', NULL,
   '{"email":"homer@snpp.com"}', 'hmac_placeholder_21'),

  (NOW() - interval '3 hours', 'agent', '$FRINK_ID', 'tool.executed', NULL,
   '{"tool":"pinchy_read","path":"/data/employee-handbook/pto-policy.md"}', 'hmac_placeholder_22'),

  (NOW() - interval '1 hour', 'user', '$ADMIN_ID', 'user.role_changed', NULL,
   '{"email":"carl@snpp.com","from":"member","to":"admin"}', 'hmac_placeholder_23');
SQL
echo "  ✅ 23 diverse audit trail entries"

# =====================================================
# 11. Clean non-seeded audit entries
# =====================================================
echo "🧹 Cleaning non-seeded audit entries..."
docker compose exec -T db psql -U pinchy -d pinchy -c "
  ALTER TABLE audit_log DISABLE TRIGGER no_delete;
  DELETE FROM audit_log WHERE row_hmac NOT LIKE 'hmac_placeholder%';
  ALTER TABLE audit_log ENABLE TRIGGER no_delete;
" > /dev/null 2>&1
echo "  ✅ Only seeded entries remain"

# =====================================================
# 12. Seed usage data (30 days, realistic token counts)
# =====================================================
echo "📊 Seeding usage data..."

# Get Smithers agent ID
SMITHERS_ID=$(docker compose exec -T db psql -U pinchy -d pinchy -t -A -c "SELECT id FROM agents WHERE name = 'Smithers' AND deleted_at IS NULL LIMIT 1;")

docker compose exec -T db psql -U pinchy -d pinchy <<SQL
DELETE FROM usage_records;

DO \$\$
DECLARE
  d INTEGER;
  day_date TIMESTAMPTZ;
  msgs INTEGER;
  i INTEGER;
  agent_ids TEXT[] := ARRAY['$SMITHERS_ID', '$FRINK_ID', '$TIBOR_ID', '$MINDY_ID'];
  agent_names TEXT[] := ARRAY['Smithers', 'Frink', 'Tibor', 'Mindy'];
  agent_models TEXT[] := ARRAY[
    'claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514',
    'claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'
  ];
  user_ids TEXT[] := ARRAY['$ADMIN_ID', 'usr_carl_carlson', 'usr_homer_jay', 'usr_lenny_leonard'];
  a_idx INTEGER; u_idx INTEGER;
  inp INTEGER; outp INTEGER;
  cost NUMERIC(10,6);
  input_price NUMERIC; output_price NUMERIC;
BEGIN
  FOR d IN 1..30 LOOP
    day_date := NOW() - (d || ' days')::INTERVAL;
    -- Realistic enterprise usage: ~80 messages/weekday, ~25 weekend (4 active users)
    IF EXTRACT(DOW FROM day_date) IN (0, 6) THEN
      msgs := 15 + floor(random() * 20)::INTEGER;
    ELSE
      msgs := 60 + floor(random() * 45)::INTEGER;
    END IF;

    FOR i IN 1..msgs LOOP
      a_idx := CASE
        WHEN random() < 0.35 THEN 1
        WHEN random() < 0.55 THEN 2
        WHEN random() < 0.75 THEN 3
        ELSE 4
      END;
      u_idx := CASE
        WHEN random() < 0.40 THEN 1
        WHEN random() < 0.65 THEN 2
        WHEN random() < 0.85 THEN 3
        ELSE 4
      END;

      -- Realistic token counts per turn (context + response)
      IF agent_models[a_idx] = 'claude-sonnet-4-20250514' THEN
        -- Sonnet: heavier usage, longer context, detailed responses
        inp := 3000 + floor(random() * 9000)::INTEGER;
        outp := 1500 + floor(random() * 5500)::INTEGER;
        input_price := 3.0; output_price := 15.0;
      ELSE
        -- Haiku: lighter but still substantial
        inp := 1500 + floor(random() * 5500)::INTEGER;
        outp := 800 + floor(random() * 3200)::INTEGER;
        input_price := 0.80; output_price := 4.0;
      END IF;

      cost := (inp * input_price / 1000000.0) + (outp * output_price / 1000000.0);

      INSERT INTO usage_records (
        timestamp, user_id, agent_id, agent_name, session_key, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        estimated_cost_usd
      ) VALUES (
        day_date + (floor(random() * 43200) || ' seconds')::INTERVAL,
        user_ids[u_idx], agent_ids[a_idx], agent_names[a_idx],
        'agent:' || agent_ids[a_idx] || ':user-' || lower(user_ids[u_idx]),
        agent_models[a_idx], inp, outp,
        floor(random() * inp * 0.3)::INTEGER,
        floor(random() * inp * 0.1)::INTEGER,
        cost
      );
    END LOOP;
  END LOOP;
END \$\$;
SQL

USAGE_COUNT=$(docker compose exec -T db psql -U pinchy -d pinchy -t -A -c "SELECT count(*) FROM usage_records;")
echo "  ✅ $USAGE_COUNT usage records seeded (30 days, 4 agents, 4 users)"

echo ""
echo "🎉 Seed complete! Ready for screenshots."
echo "   Run: npx playwright test screenshots/capture.ts"
