#!/usr/bin/env bash
# Remove auth.login entries created by Playwright test logins (last 10 minutes)
# These overwhelm the carefully seeded diverse audit trail entries.
set -euo pipefail

cd "$(dirname "$0")/.."

docker compose exec -T db psql -U pinchy -d pinchy -c "
  ALTER TABLE audit_log DISABLE TRIGGER no_delete;
  ALTER TABLE audit_log DISABLE TRIGGER no_update;
  DELETE FROM audit_log
    WHERE event_type = 'auth.login'
    AND timestamp > (NOW() - interval '10 minutes')
    AND row_hmac LIKE 'hmac_%' IS NOT TRUE;
  ALTER TABLE audit_log ENABLE TRIGGER no_delete;
  ALTER TABLE audit_log ENABLE TRIGGER no_update;
" 2>/dev/null
