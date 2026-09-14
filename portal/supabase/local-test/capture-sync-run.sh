#!/usr/bin/env bash
# Isolated plain-Postgres regression suite; never resets the app's postgres DB.
set -euo pipefail
CID="${CID:-hardhat_rls_test}"
DB="${DB:-hardhat_capture_sync_test}"
if [[ ! "$DB" =~ ^hardhat_capture_sync_test(_[a-z0-9_]+)?$ ]]; then
  echo 'DB must be a dedicated hardhat_capture_sync_test database.' >&2
  exit 1
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PSQL=(docker exec -i "$CID" psql -X -U postgres -d "$DB" -v ON_ERROR_STOP=1)
docker exec -i "$CID" psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists ${DB};"
docker exec -i "$CID" psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -c "create database ${DB};"
"${PSQL[@]}" < "$HERE/00_supabase_shim.sql" >/dev/null
"${PSQL[@]}" < "$HERE/00b_shim_auth_users.sql" >/dev/null
for migration in "$HERE"/../migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  # The plain Postgres image has no pg_cron. Existing real-Supabase integration
  # tests cover maintenance scheduling; capture SQL doesn't depend on it.
  [[ "$migration" == *0012_device_maintenance.sql ]] && continue
  "${PSQL[@]}" < "$migration" >/dev/null
done
"${PSQL[@]}" < "$HERE/01_seed_test_data.sql" >/dev/null
CID="$CID" DB="$DB" bash "$HERE/run_tests.sh"
"${PSQL[@]}" < "$HERE/capture-sync.sql"
