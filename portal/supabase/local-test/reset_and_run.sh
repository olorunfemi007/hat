#!/usr/bin/env bash
# reset_and_run.sh -- drops and recreates testdb, applies the shim + all 11
# migrations in order + fixed test fixtures, then runs the assertion suite.
# This verifies database behavior through 0011. Migration 0012 needs pg_cron;
# device-agent/tests/local_integration.py verifies that on real local Supabase.
set -euo pipefail

CID="${CID:-hardhat_rls_test}"
DB="${DB:-testdb}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="$HERE/../migrations"

PSQL_MAINT=(docker exec -i "$CID" psql -U postgres -d postgres -v ON_ERROR_STOP=1)
PSQL=(docker exec -i "$CID" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1)

echo "== dropping + recreating $DB =="
"${PSQL_MAINT[@]}" -c "drop database if exists ${DB};"
"${PSQL_MAINT[@]}" -c "create database ${DB};"

echo "== applying shim =="
"${PSQL[@]}" < "$HERE/00_supabase_shim.sql" >/dev/null
"${PSQL[@]}" < "$HERE/00b_shim_auth_users.sql" >/dev/null

for f in 0001_schema 0002_rls 0003_claim_function 0004_heartbeat_function 0005_provisioning_function 0006_auth_throttle 0007_org_management_functions 0008_invite_signup_trigger 0009_orphaned_org_admin_guard 0010_list_org_members 0011_member_email_type; do
  echo "== applying migration $f =="
  "${PSQL[@]}" < "$MIGRATIONS/${f}.sql" >/dev/null
done

echo "== loading fixed test fixtures =="
"${PSQL[@]}" < "$HERE/01_seed_test_data.sql" >/dev/null

echo "== running assertion suite =="
CID="$CID" DB="$DB" bash "$HERE/run_tests.sh"
