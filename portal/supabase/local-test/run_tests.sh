#!/usr/bin/env bash
# run_tests.sh -- actually exercises the RLS/SECURITY DEFINER surface of
# migrations 0001-0008 against a real (Dockerized) Postgres, by role-playing
# anon / authenticated (with Supabase-Auth-shaped JWT claims, i.e. just
# {"sub": "<uuid>"} -- no org/role claims at all anymore, see 0002_rls.sql's
# header) / service_role exactly as PostgREST would present them. See
# supabase/README.md for how to run this and what it proves.
#
# Sep 2026: rewritten for the Clerk -> native Supabase Auth redesign. Every
# persona's claims are now just their real auth.users uuid -- role and org
# are resolved from organization_members/user_active_org via auth.uid(),
# never from the JWT itself, so there is no more per-persona "o":{"id":...,
# "rol":...} to fake. Groups A-F are the original 52 assertions, updated
# for that shape; Groups G-K are new, covering create_organization(),
# invite_member()/revoke_invite() (including the auth.users-insert trigger
# resolving a pending invite into a real membership), set_active_org(), and
# change_member_role()/remove_member() (including the "don't orphan an org
# with zero admins" guard and membership-list isolation).
#
# Assumes: the container from README's "Start Postgres" step is running,
# and 00_supabase_shim.sql + 00b_shim_auth_users.sql + all 8 migrations +
# 01_seed_test_data.sql have already been applied (README's "Apply
# everything" step) OR this script is invoked via reset_and_run.sh, which
# does all of that first.

set -uo pipefail

CID="${CID:-hardhat_rls_test}"
DB="${DB:-testdb}"
PASS=0
FAIL=0
declare -a FAILURES=()

OUT_FILE="$(mktemp)"
ERR_FILE="$(mktemp)"
trap 'rm -f "$OUT_FILE" "$ERR_FILE"' EXIT

# run <role> <jwt_claims_json> <sql...>
# Executes sql (one or more ;-separated statements) in a single fresh
# session as the given Postgres role, with request.jwt.claims set to the
# given JSON (or '' for "no claims at all", i.e. an anonymous/no-JWT call).
# ON_ERROR_STOP=1 so the first failing statement aborts the session (exit
# code 3) instead of psql silently continuing -- this is what lets
# expect_err below detect exactly which statement failed and why.
run() {
  local role="$1" claims="$2" sql="$3"
  local esc_claims
  esc_claims="$(printf '%s' "$claims" | sed "s/'/''/g")"
  {
    printf 'set role %s;\n' "$role"
    printf "set request.jwt.claims = '%s';\n" "$esc_claims"
    printf '%s\n' "$sql"
  } | docker exec -i "$CID" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -qtAX \
      >"$OUT_FILE" 2>"$ERR_FILE"
  return $?
}

# run_as_postgres <sql>
# Like run(), but with no "set role"/"set request.jwt.claims" at all -- a
# plain superuser session. Used exactly once, for Group H's signup-trigger
# tests: real Supabase inserts into auth.users via its own internal
# `supabase_auth_admin` role, which this harness doesn't model as a
# separate Postgres role (see 00b_shim_auth_users.sql) -- running the
# INSERT as the harness's own superuser is the closest local equivalent,
# and what matters for the trigger under test is that *some* INSERT ON
# auth.users fires it, not which role performed it.
run_as_postgres() {
  local sql="$1"
  printf '%s\n' "$sql" | docker exec -i "$CID" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -qtAX \
    >"$OUT_FILE" 2>"$ERR_FILE"
  return $?
}

pass() { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); FAILURES+=("$1"); printf '  FAIL: %s\n' "$1"; printf '        stdout: %s\n' "$(tr '\n' '|' < "$OUT_FILE")"; printf '        stderr: %s\n' "$(tr '\n' '|' < "$ERR_FILE")"; }

# expect_rows <name> <expected_count> <role> <claims> <sql-returning-one-count-row>
expect_rows() {
  local name="$1" expected="$2" role="$3" claims="$4" sql="$5"
  if run "$role" "$claims" "$sql"; then
    local got
    got="$(tr -d '[:space:]' < "$OUT_FILE")"
    if [[ "$got" == "$expected" ]]; then pass "$name"; else fail "$name (expected $expected, got '$got')"; fi
  else
    fail "$name (expected success returning $expected, but statement errored)"
  fi
}

# expect_ok <name> <role> <claims> <sql>
expect_ok() {
  local name="$1" role="$2" claims="$3" sql="$4"
  if run "$role" "$claims" "$sql"; then pass "$name"; else fail "$name (expected success, got error)"; fi
}

# expect_err <name> <error_substring> <role> <claims> <sql>
expect_err() {
  local name="$1" pattern="$2" role="$3" claims="$4" sql="$5"
  if run "$role" "$claims" "$sql"; then
    fail "$name (expected error matching '$pattern', statement succeeded)"
  else
    if grep -qi -- "$pattern" "$ERR_FILE"; then pass "$name"; else fail "$name (errored, but not matching '$pattern')"; fi
  fi
}

# expect_ok_super <name> <sql> -- see run_as_postgres() above.
expect_ok_super() {
  local name="$1" sql="$2"
  if run_as_postgres "$sql"; then pass "$name"; else fail "$name (expected success, got error)"; fi
}

j() { # helper: build Supabase-Auth-shaped claims -- just the user's real
      # auth.users uuid. No org/role claims exist anymore (see 0002_rls.sql's
      # header) -- those are resolved from organization_members/
      # user_active_org via auth.uid(), never trusted from the JWT.
  printf '{"sub":"%s"}' "$1"
}

ALPHA_ADMIN_ID='00000000-0000-0000-0000-0000000030a1'
ALPHA_DEVADMIN_ID='00000000-0000-0000-0000-0000000030a2'
ALPHA_VIEWER_ID='00000000-0000-0000-0000-0000000030a3'
ALPHA_SITEMGR_ID='00000000-0000-0000-0000-0000000030a4'
BRAVO_ADMIN_ID='00000000-0000-0000-0000-0000000030b1'
MULTI_ORG_ID='00000000-0000-0000-0000-0000000030c1'
NO_ORG_ID='00000000-0000-0000-0000-0000000030c2'
EXISTING_NO_MEMBERSHIP_ID='00000000-0000-0000-0000-0000000030c3'
FRESH_SIGNUP_ID='00000000-0000-0000-0000-0000000030c4'
CHARLIE_ADMIN_ID='00000000-0000-0000-0000-0000000030d1'

ORG_ALPHA='00000000-0000-0000-0000-0000000000a1'
ORG_BRAVO='00000000-0000-0000-0000-0000000000b1'
ORG_CHARLIE='00000000-0000-0000-0000-0000000000c1'

ALPHA_ADMIN="$(j "$ALPHA_ADMIN_ID")"
ALPHA_DEVICE_ADMIN="$(j "$ALPHA_DEVADMIN_ID")"
ALPHA_VIEWER="$(j "$ALPHA_VIEWER_ID")"
ALPHA_SITE_MGR="$(j "$ALPHA_SITEMGR_ID")"
BRAVO_ADMIN="$(j "$BRAVO_ADMIN_ID")"
MULTI_ORG="$(j "$MULTI_ORG_ID")"
NO_ORG="$(j "$NO_ORG_ID")"
EXISTING_NO_MEMBERSHIP="$(j "$EXISTING_NO_MEMBERSHIP_ID")"
FRESH_SIGNUP="$(j "$FRESH_SIGNUP_ID")"
CHARLIE_ADMIN="$(j "$CHARLIE_ADMIN_ID")"

echo "=== GROUP A: anon ==="
expect_err  "A1 anon cannot SELECT organizations"        "permission denied" anon "" "select count(*) from public.organizations;"
expect_err  "A2 anon cannot SELECT sites"                 "permission denied" anon "" "select count(*) from public.sites;"
expect_err  "A3 anon cannot SELECT devices"               "permission denied" anon "" "select count(*) from public.devices;"
expect_err  "A4 anon cannot SELECT storage_configs"       "permission denied" anon "" "select count(*) from public.storage_configs;"
expect_err  "A5 anon cannot EXEC lookup_device_by_claim_code" "permission denied" anon "" "select * from public.lookup_device_by_claim_code('DEV-ALPHA-001','claimcode-alpha-001');"
expect_err  "A6 anon cannot EXEC claim_device"            "permission denied" anon "" "select * from public.claim_device('DEV-ALPHA-001','claimcode-alpha-001',null,null);"
expect_ok   "A7 anon device_heartbeat correct creds succeeds"  anon "" "select public.device_heartbeat('DEV-ALPHA-002','identity-alpha-002','00000000000a0003');"
expect_rows "A7b heartbeat set status=active"             "active" anon "" "select status from public.device_heartbeat('DEV-ALPHA-002','identity-alpha-002','00000000000a0003');"
expect_rows "A8 anon device_heartbeat wrong secret fails (zero rows, not an exception - see 0004 comments)" "0" anon "" "select count(*) from public.device_heartbeat('DEV-ALPHA-002','wrong-secret','00000000000a0003');"
expect_rows "A8b anon device_heartbeat wrong hardware_serial fails (zero rows, same as wrong secret - see 0013 comments)" "0" anon "" "select count(*) from public.device_heartbeat('DEV-ALPHA-002','identity-alpha-002','ffffffffffffffff');"
expect_rows "A9 heartbeat on unclaimed device stays unclaimed" "unclaimed" anon "" "select status from public.device_heartbeat('DEV-ALPHA-001','identity-alpha-001','00000000000a0001');"
expect_err  "A10 anon cannot EXEC mark_stale_devices_offline" "permission denied" anon "" "select * from public.mark_stale_devices_offline();"
expect_err  "A11 anon cannot EXEC provision_devices"      "permission denied" anon "" "select * from public.provision_devices(array['X'], array['00000000000c0000']);"

echo "=== GROUP B: authenticated, org isolation ==="
expect_rows "B1 alpha admin sees only own org row"        "1" authenticated "$ALPHA_ADMIN" "select count(*) from public.organizations;"
expect_rows "B2 alpha admin sees only own org's sites"    "1" authenticated "$ALPHA_ADMIN" "select count(*) from public.sites;"
expect_rows "B3 alpha admin sees only own org's claimed devices" "1" authenticated "$ALPHA_ADMIN" "select count(*) from public.devices;"
expect_rows "B4 unclaimed devices are unlistable (org_id is null -> 0 rows)" "0" authenticated "$ALPHA_ADMIN" "select count(*) from public.devices where org_id is null;"
expect_err  "B5 hash columns not selectable even for own org's device" "permission denied" authenticated "$ALPHA_ADMIN" "select claim_code_hash from public.devices where serial_number = 'DEV-ALPHA-002';"
expect_rows "B6 alpha admin sees only own org's storage_configs" "1" authenticated "$ALPHA_ADMIN" "select count(*) from public.storage_configs;"
expect_ok   "B7 alpha admin can rename own site"          authenticated "$ALPHA_ADMIN" "update public.sites set name = 'Alpha Site 1 Renamed' where id = '00000000-0000-0000-0000-0000000010a1';"
expect_err  "B8 alpha admin cannot move own site into bravo org" "row-level security" authenticated "$ALPHA_ADMIN" "update public.sites set org_id = '00000000-0000-0000-0000-0000000000b1' where id = '00000000-0000-0000-0000-0000000010a1';"
expect_err  "B9 alpha admin cannot insert a site for bravo org" "row-level security" authenticated "$ALPHA_ADMIN" "insert into public.sites (org_id, name) values ('00000000-0000-0000-0000-0000000000b1','sneaky');"
expect_ok   "B10 alpha admin can delete own org's site (after re-creating one)" authenticated "$ALPHA_ADMIN" "insert into public.sites (org_id, name) values ('00000000-0000-0000-0000-0000000000a1','Temp Site'); delete from public.sites where org_id = '00000000-0000-0000-0000-0000000000a1' and name = 'Temp Site';"
expect_err  "B11 viewer cannot insert a site (role check)"  "row-level security" authenticated "$ALPHA_VIEWER" "insert into public.sites (org_id, name) values ('00000000-0000-0000-0000-0000000000a1','viewer-made');"
expect_rows "B12 device_admin can read sites (read-only role)" "1" authenticated "$ALPHA_DEVICE_ADMIN" "select count(*) from public.sites;"
expect_rows "B13a no-active-org authenticated user sees 0 orgs (safe degrade, not error)" "0" authenticated "$NO_ORG" "select count(*) from public.organizations;"
expect_rows "B13b no-active-org authenticated user sees 0 devices" "0" authenticated "$NO_ORG" "select count(*) from public.devices;"
expect_err  "B14 cannot UPDATE devices.org_id directly (column grant)" "permission denied" authenticated "$ALPHA_ADMIN" "update public.devices set org_id = '00000000-0000-0000-0000-0000000000a1' where serial_number = 'DEV-ALPHA-002';"
expect_err  "B15 cannot UPDATE devices.status directly (column grant)" "permission denied" authenticated "$ALPHA_ADMIN" "update public.devices set status = 'active' where serial_number = 'DEV-ALPHA-002';"
expect_ok   "B16 can UPDATE devices.display_name for own org's device" authenticated "$ALPHA_ADMIN" "update public.devices set display_name = 'Renamed' where serial_number = 'DEV-ALPHA-002';"
expect_err  "B17 composite FK blocks assigning a cross-org site to own device" "foreign key" authenticated "$ALPHA_ADMIN" "update public.devices set site_id = '00000000-0000-0000-0000-0000000010b1' where serial_number = 'DEV-ALPHA-002';"
expect_rows "B18 bravo admin sees only bravo's device count" "1" authenticated "$BRAVO_ADMIN" "select count(*) from public.devices;"
expect_rows "B19 bravo admin cannot see alpha's storage_configs" "0" authenticated "$BRAVO_ADMIN" "select count(*) from public.storage_configs where org_id = '00000000-0000-0000-0000-0000000000a1';"

echo "=== GROUP C: claim flow ==="
expect_rows "C1 lookup correct serial+code returns the row" "1" authenticated "$ALPHA_ADMIN" "select count(*) from public.lookup_device_by_claim_code('DEV-ALPHA-001','claimcode-alpha-001');"
expect_rows "C2 lookup wrong code returns nothing" "0" authenticated "$ALPHA_ADMIN" "select count(*) from public.lookup_device_by_claim_code('DEV-ALPHA-001','wrong-code');"
expect_rows "C3 lookup unknown serial returns nothing" "0" authenticated "$ALPHA_ADMIN" "select count(*) from public.lookup_device_by_claim_code('NO-SUCH-SERIAL','whatever');"
expect_err  "C7 claim_device requires an active org" "authentication with an active organization" authenticated "$NO_ORG" "select * from public.claim_device('DEV-ALPHA-001','claimcode-alpha-001',null,null);"
expect_err  "C6 claim_device rejects insufficient role (viewer)" "insufficient role" authenticated "$ALPHA_VIEWER" "select * from public.claim_device('DEV-ALPHA-001','claimcode-alpha-001',null,null);"
expect_err  "C8 claim_device rejects a site belonging to a different org" "does not belong to your organization" authenticated "$ALPHA_ADMIN" "select * from public.claim_device('DEV-ALPHA-001','claimcode-alpha-001','00000000-0000-0000-0000-0000000010b1',null);"
expect_rows "C9 claim_device rejects wrong claim code (zero rows, not an exception)" "0" authenticated "$ALPHA_ADMIN" "select count(*) from public.claim_device('DEV-UNCLAIMED','wrong-code',null,null);"
expect_ok   "C4 claim_device succeeds with correct code + own-org site" authenticated "$ALPHA_ADMIN" "select * from public.claim_device('DEV-ALPHA-001','claimcode-alpha-001','00000000-0000-0000-0000-0000000010a1','Claimed Alpha 001');"
expect_rows "C4b claimed device now visible via normal SELECT" "1" authenticated "$ALPHA_ADMIN" "select count(*) from public.devices where serial_number = 'DEV-ALPHA-001' and status = 'claimed';"
expect_rows "C5 double-claim is rejected (zero rows, not an exception)" "0" authenticated "$ALPHA_ADMIN" "select count(*) from public.claim_device('DEV-ALPHA-001','claimcode-alpha-001',null,null);"
expect_ok   "C10 device_admin (not just org_admin) can also claim" authenticated "$ALPHA_DEVICE_ADMIN" "select * from public.claim_device('DEV-UNCLAIMED','claimcode-unclaimed',null,null);"

echo "=== GROUP D: offline sweep ==="
expect_err  "D2 authenticated cannot run mark_stale_devices_offline" "permission denied" authenticated "$ALPHA_ADMIN" "select * from public.mark_stale_devices_offline();"
expect_ok   "D1 service_role can sweep stale devices to offline" service_role "" "select * from public.mark_stale_devices_offline('30 minutes'::interval);"
expect_rows "D1b bravo's stale device is now offline"      "offline" service_role "" "select status from public.devices where serial_number = 'DEV-BRAVO-001';"

echo "=== GROUP E: service_role bypass + constraints still hold ==="
expect_rows "E1 service_role sees rows across both orgs"   "2" service_role "" "select count(distinct org_id) from public.devices where org_id is not null;"
expect_err  "E2 composite FK blocks cross-org site_id even for service_role" "foreign key" service_role "" "insert into public.devices (org_id, site_id, serial_number, hardware_serial, claim_code_hash, device_identity_hash, status, claimed_at, claimed_by_user_id) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000010b1','BAD-DEVICE-1','00000000000e0003','x','y','claimed', now(), null);"
expect_err  "E3 claim-state CHECK blocks unclaimed-with-org_id even for service_role" "devices_claim_state_chk" service_role "" "insert into public.devices (org_id, serial_number, hardware_serial, claim_code_hash, device_identity_hash, status) values ('00000000-0000-0000-0000-0000000000a1','BAD-DEVICE-2','00000000000e0004','x','y','unclaimed');"
expect_ok   "E4 provision_devices (service_role) creates a fresh device"  service_role "" "select * from public.provision_devices(array['BATCH-TEST-0001'], array['00000000000e0001']);"
expect_rows "E4b provisioned device row actually exists, unclaimed"  "1" service_role "" "select count(*) from public.devices where serial_number = 'BATCH-TEST-0001' and status = 'unclaimed';"
expect_rows "E4c provisioned device row recorded the real hardware_serial" "00000000000e0001" service_role "" "select hardware_serial from public.devices where serial_number = 'BATCH-TEST-0001';"
expect_err  "E4d provision_devices rejects mismatched array lengths" "same length" service_role "" "select * from public.provision_devices(array['BATCH-TEST-0002','BATCH-TEST-0003'], array['00000000000e0002']);"
expect_err  "E5 authenticated cannot call provision_devices"  "permission denied" authenticated "$ALPHA_ADMIN" "select * from public.provision_devices(array['X'], array['00000000000c0000']);"

echo "=== GROUP F: auth throttle (0004/0006) ==="
# Drive 10 failed heartbeat attempts against a dedicated serial (wrong
# secret each time) - this is what device_auth_failures logs and what the
# throttle in device_heartbeat/lookup_device_by_claim_code/claim_device
# counts. Not asserted individually; F1 below is the real check.
for i in $(seq 1 10); do
  run anon "" "select public.device_heartbeat('DEV-THROTTLE-001','wrong-secret-$i','00000000000f0001');" >/dev/null
done
expect_rows "F1 heartbeat throttled after 10 failures, even with the CORRECT secret (zero rows)" "0" anon "" \
  "select count(*) from public.device_heartbeat('DEV-THROTTLE-001','identity-throttle-001','00000000000f0001');"
expect_ok   "F2 throttle is per-serial, not global - a different device's heartbeat still works" \
  anon "" "select public.device_heartbeat('DEV-ALPHA-002','identity-alpha-002','00000000000a0003');"
expect_rows "F3 device_auth_failures actually has >=10 rows for the throttled serial" "t" service_role "" \
  "select (count(*) >= 10) from public.device_auth_failures where serial_number = 'DEV-THROTTLE-001';"

# Same throttle logic, exercised through lookup_device_by_claim_code instead
# of device_heartbeat, against a separate dedicated serial.
for i in $(seq 1 10); do
  run authenticated "$ALPHA_ADMIN" "select public.lookup_device_by_claim_code('DEV-THROTTLE-CLAIM-001','wrong-code-$i');" >/dev/null
done
expect_rows "F4 claim-code lookup throttled after 10 failures - correct code now also returns 0 rows" "0" \
  authenticated "$ALPHA_ADMIN" "select count(*) from public.lookup_device_by_claim_code('DEV-THROTTLE-CLAIM-001','claimcode-throttle-claim-001');"

expect_err  "F5 authenticated cannot call cleanup_old_auth_failures" "permission denied" authenticated "$ALPHA_ADMIN" \
  "select public.cleanup_old_auth_failures();"
expect_ok   "F6 service_role can run cleanup_old_auth_failures" service_role "" \
  "select public.cleanup_old_auth_failures('0 seconds'::interval);"
expect_rows "F6b cleanup with 0-second cutoff removed everything" "0" service_role "" \
  "select count(*) from public.device_auth_failures;"

echo "=== GROUP G: create_organization() ==="
expect_ok   "G1 authenticated user with zero memberships can create an org" authenticated "$FRESH_SIGNUP" \
  "select public.create_organization('New Co');"
expect_rows "G2 creator is automatically an org_admin of the new org" "1" authenticated "$FRESH_SIGNUP" \
  "select count(*) from public.organization_members om join public.organizations o on o.id = om.org_id where om.user_id = '$FRESH_SIGNUP_ID' and om.role = 'org_admin' and o.name = 'New Co';"
expect_rows "G3 the new org is automatically the creator's active org" "t" authenticated "$FRESH_SIGNUP" \
  "select (public.current_org_id() = (select id from public.organizations where name = 'New Co'));"
expect_err  "G4 anon cannot call create_organization" "permission denied" anon "" \
  "select public.create_organization('Sneaky Co');"
expect_err  "G5 blank organization name is rejected" "organization name is required" authenticated "$ALPHA_ADMIN" \
  "select public.create_organization('   ');"

echo "=== GROUP H: invite_member() / revoke_invite() / signup-resolves-invite trigger ==="
expect_rows "H1 org_admin invites a brand-new email -> outcome=invited" "invited" authenticated "$ALPHA_ADMIN" \
  "select outcome from public.invite_member('$ORG_ALPHA','brand-new@test.dev','viewer');"
expect_rows "H1b a pending invite row now exists for that email" "1" authenticated "$ALPHA_ADMIN" \
  "select count(*) from public.organization_invites where org_id = '$ORG_ALPHA' and email = 'brand-new@test.dev' and accepted_at is null and revoked_at is null;"
expect_err  "H2 non-admin member cannot invite" "only an org admin can invite" authenticated "$ALPHA_VIEWER" \
  "select * from public.invite_member('$ORG_ALPHA','someone-else@test.dev','viewer');"
expect_rows "H3 inviting an email with an existing auth.users account adds membership immediately" "added_existing_member" authenticated "$ALPHA_ADMIN" \
  "select outcome from public.invite_member('$ORG_ALPHA','existing-user@test.dev','device_admin');"
expect_rows "H3b existing-user branch: they are now a member with the invited role" "device_admin" authenticated "$ALPHA_ADMIN" \
  "select role from public.organization_members where org_id = '$ORG_ALPHA' and user_id = '$EXISTING_NO_MEMBERSHIP_ID';"
expect_rows "H3c existing-user branch never created an invite row" "0" authenticated "$ALPHA_ADMIN" \
  "select count(*) from public.organization_invites where org_id = '$ORG_ALPHA' and email = 'existing-user@test.dev';"
expect_rows "H3d inviting an email that only has an UNCONFIRMED (squatted) account falls through to pending, not immediate membership" "invited" authenticated "$ALPHA_ADMIN" \
  "select outcome from public.invite_member('$ORG_ALPHA','squatted@test.dev','org_admin');"
expect_rows "H3e the squatter's account was NOT granted membership" "0" service_role "" \
  "select count(*) from public.organization_members where org_id = '$ORG_ALPHA' and user_id = '00000000-0000-0000-0000-0000000030c5';"
expect_err  "H4 duplicate pending invite for the same org+email is rejected" "already pending" authenticated "$ALPHA_ADMIN" \
  "select * from public.invite_member('$ORG_ALPHA','brand-new@test.dev','viewer');"
expect_err  "H5 inviting someone already a member of the org is rejected" "already a member" authenticated "$ALPHA_ADMIN" \
  "select * from public.invite_member('$ORG_ALPHA','existing-user@test.dev','viewer');"
expect_ok_super "H6 a real signup with a matching pending invite - insert UNCONFIRMED first" \
  "insert into auth.users (email) values ('brand-new@test.dev');"
expect_rows "H6-unconfirmed the invite must NOT resolve while the email is still unconfirmed (the account-squatting fix)" "0" service_role "" \
  "select count(*) from public.organization_members om join auth.users u on u.id = om.user_id where u.email = 'brand-new@test.dev' and om.org_id = '$ORG_ALPHA';"
expect_ok_super "H6-confirm now confirm that email (the ordinary password-signup confirmation step)" \
  "update auth.users set email_confirmed_at = now() where email = 'brand-new@test.dev';"
expect_rows "H6b the trigger created a real membership once - and only once - the email was confirmed" "1" service_role "" \
  "select count(*) from public.organization_members om join auth.users u on u.id = om.user_id where u.email = 'brand-new@test.dev' and om.org_id = '$ORG_ALPHA' and om.role = 'viewer';"
expect_rows "H6c the resolved invite is now marked accepted" "1" service_role "" \
  "select count(*) from public.organization_invites where org_id = '$ORG_ALPHA' and email = 'brand-new@test.dev' and accepted_at is not null;"
expect_ok_super "H7 an ordinary CONFIRMED signup with NO matching invite is a silent no-op, not an error" \
  "insert into auth.users (email, email_confirmed_at) values ('nobody-invited-me@test.dev', now());"
expect_rows "H7b no membership was fabricated for an unmatched signup" "0" service_role "" \
  "select count(*) from public.organization_members om join auth.users u on u.id = om.user_id where u.email = 'nobody-invited-me@test.dev';"
# Two fresh throwaway orgs, created/invited-from by FRESH_SIGNUP and
# CHARLIE_ADMIN specifically -- NOT ALPHA_ADMIN/BRAVO_ADMIN. This isn't just
# about ORG_ALPHA/ORG_BRAVO's membership COUNTS (Group K asserts those) --
# create_organization() also atomically switches the CALLER's active org to
# the org it just created (by design). Using ALPHA_ADMIN/BRAVO_ADMIN here
# would silently point their active org away from ORG_ALPHA/ORG_BRAVO for
# the rest of the run, breaking any later test whose client-side query
# relies on organization_invites'/etc RLS resolving through current_org_id()
# (revoke_invite's own internal authorization logic does its own direct,
# org_id-parameterized membership lookup and is unaffected either way -- but
# the *client's* pre-fetch of an invite's id to pass in is a normal
# RLS-gated SELECT, and got bitten by exactly this the first time this test
# was written).
expect_ok   "H-multi0a create a throwaway org for this test" authenticated "$FRESH_SIGNUP" \
  "select public.create_organization('Multi Invite Org 1');"
expect_ok   "H-multi0b create a second throwaway org for this test" authenticated "$CHARLIE_ADMIN" \
  "select public.create_organization('Multi Invite Org 2');"
expect_ok   "H-multi1 invite the same not-yet-existing email to the first throwaway org" authenticated "$FRESH_SIGNUP" \
  "select public.invite_member((select id from public.organizations where name = 'Multi Invite Org 1'),'double-invited@test.dev','viewer');"
expect_ok   "H-multi2 and separately to the second, before they ever sign up" authenticated "$CHARLIE_ADMIN" \
  "select public.invite_member((select id from public.organizations where name = 'Multi Invite Org 2'),'double-invited@test.dev','device_admin');"
expect_ok_super "H-multi3 a single confirmed signup for that email" \
  "insert into auth.users (email, email_confirmed_at) values ('double-invited@test.dev', now());"
expect_rows "H-multi4 one signup resolved BOTH pending invites into two separate org memberships" "2" service_role "" \
  "select count(*) from public.organization_members om join auth.users u on u.id = om.user_id join public.organizations o on o.id = om.org_id where u.email = 'double-invited@test.dev' and o.name in ('Multi Invite Org 1','Multi Invite Org 2');"
expect_rows "H-multi5 the second org's membership got the role THAT org's invite specified, not the first's" "device_admin" service_role "" \
  "select om.role from public.organization_members om join auth.users u on u.id = om.user_id join public.organizations o on o.id = om.org_id where u.email = 'double-invited@test.dev' and o.name = 'Multi Invite Org 2';"
expect_ok   "H8 create an invite to revoke" authenticated "$ALPHA_ADMIN" \
  "select public.invite_member('$ORG_ALPHA','to-be-revoked@test.dev','viewer');"
expect_ok   "H8b org_admin can revoke a pending invite" authenticated "$ALPHA_ADMIN" \
  "select public.revoke_invite((select id from public.organization_invites where org_id = '$ORG_ALPHA' and email = 'to-be-revoked@test.dev' and accepted_at is null and revoked_at is null));"
expect_rows "H8c revoked invite no longer counts as pending" "0" authenticated "$ALPHA_ADMIN" \
  "select count(*) from public.organization_invites where org_id = '$ORG_ALPHA' and email = 'to-be-revoked@test.dev' and accepted_at is null and revoked_at is null;"
expect_ok   "H9 create another invite" authenticated "$ALPHA_ADMIN" \
  "select public.invite_member('$ORG_ALPHA','to-not-be-revoked@test.dev','viewer');"
# H9b's whole point is that a non-admin CANNOT see/act on this invite -- so
# unlike H8b, the invite_id can't be resolved inline as part of the same
# call made by the non-admin caller under test (organization_invites' RLS
# policy correctly hides it from them, which would make the id subquery
# itself return null and mask the real assertion behind a confusing
# "invite not found" instead of the intended authorization error). Resolve
# the id out-of-band as service_role (bypasses RLS, a legitimate use of a
# trusted role purely for test setup/introspection -- never something a
# real client could do), then hand only the resulting literal uuid to the
# actual (non-admin) call being tested.
run service_role "" "select id from public.organization_invites where org_id = '$ORG_ALPHA' and email = 'to-not-be-revoked@test.dev' and accepted_at is null and revoked_at is null;" >/dev/null
TO_NOT_BE_REVOKED_INVITE_ID="$(tr -d '[:space:]' < "$OUT_FILE")"
expect_err  "H9b non-admin cannot revoke an invite" "only an org admin can revoke" authenticated "$ALPHA_VIEWER" \
  "select public.revoke_invite('$TO_NOT_BE_REVOKED_INVITE_ID');"
expect_rows "H10 non-admin member cannot see the org's pending invites" "0" authenticated "$ALPHA_VIEWER" \
  "select count(*) from public.organization_invites where org_id = '$ORG_ALPHA';"
expect_rows "H11 an admin of a DIFFERENT org cannot see alpha's invites" "0" authenticated "$BRAVO_ADMIN" \
  "select count(*) from public.organization_invites where org_id = '$ORG_ALPHA';"
expect_err  "H12 anon cannot call invite_member" "permission denied" anon "" \
  "select * from public.invite_member('$ORG_ALPHA','x@test.dev','viewer');"

echo "=== GROUP I: set_active_org() / active-org switching ==="
expect_rows "I1 multi-org user's default active org is their EARLIEST membership (alpha)" "t" authenticated "$MULTI_ORG" \
  "select (public.current_org_id() = '$ORG_ALPHA'::uuid);"
expect_rows "I2 multi-org user's default role there is viewer" "viewer" authenticated "$MULTI_ORG" \
  "select public.current_org_role();"
expect_ok   "I3 multi-org user switches active org to bravo" authenticated "$MULTI_ORG" \
  "select public.set_active_org('$ORG_BRAVO');"
expect_rows "I4 a FRESH session/connection now resolves current_org_id() to bravo (proves persistence, not a session-local GUC)" "t" authenticated "$MULTI_ORG" \
  "select (public.current_org_id() = '$ORG_BRAVO'::uuid);"
expect_rows "I5 and current_org_role() now resolves to bravo's role (org_admin)" "org_admin" authenticated "$MULTI_ORG" \
  "select public.current_org_role();"
expect_err  "I6 cannot set_active_org to an org you don't belong to" "not a member" authenticated "$ALPHA_VIEWER" \
  "select public.set_active_org('$ORG_CHARLIE');"
expect_err  "I7 anon cannot call set_active_org" "permission denied" anon "" \
  "select public.set_active_org('$ORG_ALPHA');"

echo "=== GROUP J: change_member_role() / remove_member() ==="
expect_ok   "J1 org_admin changes alpha_viewer's role to site_manager" authenticated "$ALPHA_ADMIN" \
  "select public.change_member_role('$ORG_ALPHA','$ALPHA_VIEWER_ID','site_manager');"
expect_rows "J1b role change took effect" "site_manager" authenticated "$ALPHA_ADMIN" \
  "select role from public.organization_members where org_id = '$ORG_ALPHA' and user_id = '$ALPHA_VIEWER_ID';"
expect_err  "J2 non-admin cannot change another member's role" "only an org admin" authenticated "$ALPHA_DEVICE_ADMIN" \
  "select public.change_member_role('$ORG_ALPHA','$ALPHA_SITEMGR_ID','viewer');"
expect_err  "J3 cannot demote the lone admin of an org (even themselves)" "no org_admin left" authenticated "$CHARLIE_ADMIN" \
  "select public.change_member_role('$ORG_CHARLIE','$CHARLIE_ADMIN_ID','viewer');"
expect_ok   "J4 org_admin removes a member" authenticated "$ALPHA_ADMIN" \
  "select public.remove_member('$ORG_ALPHA','$ALPHA_SITEMGR_ID');"
expect_rows "J4b removed member's row is gone" "0" authenticated "$ALPHA_ADMIN" \
  "select count(*) from public.organization_members where org_id = '$ORG_ALPHA' and user_id = '$ALPHA_SITEMGR_ID';"
expect_ok   "J5 a member can remove themselves (leave org)" authenticated "$ALPHA_VIEWER" \
  "select public.remove_member('$ORG_ALPHA','$ALPHA_VIEWER_ID');"
expect_rows "J5b self-removed member's row is gone" "0" authenticated "$ALPHA_ADMIN" \
  "select count(*) from public.organization_members where org_id = '$ORG_ALPHA' and user_id = '$ALPHA_VIEWER_ID';"
expect_err  "J6 cannot remove the last org_admin of an org (even via self-removal)" "cannot remove the last org_admin" authenticated "$CHARLIE_ADMIN" \
  "select public.remove_member('$ORG_CHARLIE','$CHARLIE_ADMIN_ID');"
expect_err  "J7 non-admin, non-self cannot remove someone else" "only an org admin can remove" authenticated "$ALPHA_DEVICE_ADMIN" \
  "select public.remove_member('$ORG_ALPHA','$MULTI_ORG_ID');"
expect_ok   "J8 org_admin removes the multi-org user from bravo (their CURRENT active org)" authenticated "$BRAVO_ADMIN" \
  "select public.remove_member('$ORG_BRAVO','$MULTI_ORG_ID');"
expect_rows "J8b their active org correctly falls back to alpha (their only remaining membership)" "t" authenticated "$MULTI_ORG" \
  "select (public.current_org_id() = '$ORG_ALPHA'::uuid);"
expect_rows "J8c and their role there is still viewer" "viewer" authenticated "$MULTI_ORG" \
  "select public.current_org_role();"
expect_err  "J9 anon cannot call change_member_role" "permission denied" anon "" \
  "select public.change_member_role('$ORG_ALPHA','$ALPHA_ADMIN_ID','viewer');"
expect_err  "J10 anon cannot call remove_member" "permission denied" anon "" \
  "select public.remove_member('$ORG_ALPHA','$ALPHA_ADMIN_ID');"

echo "=== GROUP K: organization_members isolation (non-member cannot see/modify another org's list) ==="
expect_rows "K1 bravo admin sees only bravo's members" "1" authenticated "$BRAVO_ADMIN" \
  "select count(*) from public.organization_members where org_id = '$ORG_BRAVO';"
expect_rows "K2 bravo admin cannot see alpha's members" "0" authenticated "$BRAVO_ADMIN" \
  "select count(*) from public.organization_members where org_id = '$ORG_ALPHA';"
expect_err  "K3 bravo admin cannot raw-INSERT into organization_members" "permission denied" authenticated "$BRAVO_ADMIN" \
  "insert into public.organization_members (org_id, user_id, role) values ('$ORG_BRAVO','$ALPHA_ADMIN_ID','org_admin');"
expect_err  "K4 bravo admin cannot raw-UPDATE organization_members" "permission denied" authenticated "$BRAVO_ADMIN" \
  "update public.organization_members set role = 'viewer' where org_id = '$ORG_BRAVO' and user_id = '$BRAVO_ADMIN_ID';"
expect_err  "K5 anon cannot select organization_members" "permission denied" anon "" \
  "select count(*) from public.organization_members;"
expect_err  "K6 anon cannot select organization_invites" "permission denied" anon "" \
  "select count(*) from public.organization_invites;"
expect_err  "K7 anon cannot select user_active_org" "permission denied" anon "" \
  "select count(*) from public.user_active_org;"
expect_rows "K8 a user who is not a member of alpha at all sees 0 of its members" "0" authenticated "$CHARLIE_ADMIN" \
  "select count(*) from public.organization_members where org_id = '$ORG_ALPHA';"
expect_err  "K9 non-member cannot change alpha's member roles" "only an org admin" authenticated "$CHARLIE_ADMIN" \
  "select public.change_member_role('$ORG_ALPHA','$ALPHA_ADMIN_ID','viewer');"

echo "=== GROUP L: orphaned org_admin auto-promotion (0009) ==="
# Reuses "New Co" (created by fresh-signup in Group G) rather than standing
# up a whole new org+members just for this. Adds a second member, then
# simulates what an account-deletion CASCADE does to organization_members
# directly (a raw DELETE, bypassing remove_member() entirely) -- exactly
# the gap 0009's trigger backstops.
expect_ok   "L1 add existing-user (confirmed) to New Co as viewer" authenticated "$FRESH_SIGNUP" \
  "select public.invite_member((select id from public.organizations where name = 'New Co'), 'existing-user@test.dev', 'viewer');"
expect_rows "L1b existing-user is now a viewer of New Co" "viewer" service_role "" \
  "select role from public.organization_members where org_id = (select id from public.organizations where name = 'New Co') and user_id = '00000000-0000-0000-0000-0000000030c3';"
expect_ok_super "L2 simulate an account-deletion CASCADE: raw-delete fresh-signup's sole-admin membership row" \
  "delete from public.organization_members where org_id = (select id from public.organizations where name = 'New Co') and user_id = '$FRESH_SIGNUP_ID';"
expect_rows "L2b existing-user was auto-promoted to org_admin (the 0009 trigger's job, not remove_member() - nothing called that here)" "org_admin" service_role "" \
  "select role from public.organization_members where org_id = (select id from public.organizations where name = 'New Co') and user_id = '00000000-0000-0000-0000-0000000030c3';"
expect_rows "L2c New Co still has exactly one org_admin (not zero, not two)" "1" service_role "" \
  "select count(*) from public.organization_members where org_id = (select id from public.organizations where name = 'New Co') and role = 'org_admin';"

echo "=== GROUP M: list_org_members() (0010) ==="
# Alpha's membership count by this point in the run (5, not the seed-time
# baseline of 4): the extra row is multi-org@test.dev, seeded as an
# additional viewer of alpha specifically to exercise multi-org membership
# (Group I) -- alpha_viewer themselves already left the org via J5, so
# they're NOT one of the 5; existing-user@test.dev's H3 addition is.
expect_rows "M1 alpha admin lists alpha's members with emails attached" "5" authenticated "$ALPHA_ADMIN" \
  "select count(*) from public.list_org_members('$ORG_ALPHA');"
expect_rows "M2 the caller's own row has the right email" "alpha-admin@test.dev" authenticated "$ALPHA_ADMIN" \
  "select email from public.list_org_members('$ORG_ALPHA') where user_id = '$ALPHA_ADMIN_ID';"
expect_err  "M3 non-member cannot list alpha's members" "not a member" authenticated "$CHARLIE_ADMIN" \
  "select * from public.list_org_members('$ORG_ALPHA');"
expect_err  "M4 anon cannot call list_org_members" "permission denied" anon "" \
  "select * from public.list_org_members('$ORG_ALPHA');"
# Not $ALPHA_VIEWER: they removed themselves from alpha entirely in J5, so
# by this point they're genuinely not a member any more (correct, expected
# behavior) -- $ALPHA_DEVICE_ADMIN is a non-admin member never touched by
# any removal/role-change test, so it actually exercises "non-admin, still
# a member" rather than accidentally testing "former member" again.
expect_rows "M5 a non-admin member can also list (read-only visibility, not admin-gated)" "5" authenticated "$ALPHA_DEVICE_ADMIN" \
  "select count(*) from public.list_org_members('$ORG_ALPHA');"

echo
echo "================================================================"
echo "RESULTS: $PASS passed, $FAIL failed (total $((PASS+FAIL)))"
if [[ $FAIL -gt 0 ]]; then
  echo "Failed tests:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
