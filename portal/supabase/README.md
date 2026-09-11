# Supabase schema, RLS, and auth model

This directory is the full Postgres surface for the portal: schema, Row
Level Security, tenancy (organizations/membership/invites), and the two
non-human device-auth paths (device claiming, device heartbeat). Everything
here is real, runnable SQL — nothing is pseudocode — and the RLS/SECURITY
DEFINER logic has been **executed against a real Postgres in Docker**, not
just read over, per the assertion suite under `local-test/` (137/137
passing; see "Testing this locally" below for exactly how to reproduce
that).

## Sep 2026: Clerk dropped, native Supabase Auth adopted

This project originally used Clerk (Organizations, custom roles) for the
human side of auth. Clerk's custom-roles feature requires a paid add-on in
production, so this project now uses **Supabase's own native Auth**
instead — open source, no per-role paywall. That's a bigger change than a
provider swap: Clerk's "Organizations" product used to give this app
membership, roles, active-org selection, and invites for free, synced into
Postgres by a webhook. Native Supabase Auth has users and JWTs, nothing
org-shaped — so this migration set now **builds tenancy from scratch**:
`organizations` is the system of record for itself (no external mirror),
and three new tables (`organization_members`, `user_active_org`,
`organization_invites`) replace what Clerk used to do for free. This
project has never been deployed against a real Supabase/Clerk project
(nothing in production to migrate away from safely), so the Clerk-era
tables/columns/functions were edited in place rather than layered over with
a parallel "legacy" path — there's no real-world data shape to preserve,
and a clean history beats an artificial migration trail for something that
never shipped.

This file documents the **current** (native Supabase Auth) design. Where a
security lesson from the Clerk era still applies unchanged (anti-
enumeration hardening, column-level grants, `service_role` needing explicit
grants, the "zero rows not raise" transaction lesson), it's carried over
below without re-litigating it — those hazards are about Postgres/SQL
semantics, not about which auth provider issues the JWT.

## Files

```
supabase/
├── migrations/
│   ├── 0001_schema.sql                 organizations, organization_members,
│   │                                    user_active_org, organization_invites,
│   │                                    sites, devices, storage_configs,
│   │                                    device_auth_failures
│   ├── 0002_rls.sql                    helper functions (current_org_id(),
│   │                                    current_org_role(), is_org_member()),
│   │                                    RLS, policies, grants
│   ├── 0003_claim_function.sql         lookup_device_by_claim_code(), claim_device()
│   ├── 0004_heartbeat_function.sql     device_heartbeat(), mark_stale_devices_offline()
│   ├── 0005_provisioning_function.sql  provision_devices()
│   ├── 0006_auth_throttle.sql          cleanup_old_auth_failures()
│   ├── 0007_org_management_functions.sql  create_organization(), invite_member(),
│   │                                    revoke_invite(), change_member_role(),
│   │                                    remove_member(), set_active_org()
│   ├── 0008_invite_signup_trigger.sql  AFTER INSERT ON auth.users trigger that
│   │                                    resolves pending invites into memberships
│   ├── 0009_orphaned_org_admin_guard.sql  AFTER DELETE ON organization_members
│   │                                    trigger that auto-promotes a replacement
│   │                                    org_admin if a deletion (any path) would
│   │                                    otherwise leave an org with zero admins
│   └── 0010_list_org_members.sql       list_org_members() -- the only sanctioned
│                                        way to resolve a fellow member's email,
│                                        needed for any member-management UI
├── seed.sql                            dev/test device provisioning
├── local-test/
│   ├── 00_supabase_shim.sql            emulates auth.jwt()/auth.uid() + the
│   │                                    anon/authenticated/service_role roles
│   │                                    (generic — not Clerk- or Supabase-Auth-
│   │                                    specific; unchanged by this redesign)
│   ├── 00b_shim_auth_users.sql         minimal auth.users table, needed now that
│   │                                    real FKs/triggers point at/fire off it
│   ├── 01_seed_test_data.sql           fixed-id fixtures: real auth.users rows,
│   │                                    three orgs, memberships, sites, devices
│   ├── run_tests.sh                    137 assertions against a running DB
│   └── reset_and_run.sh                one command: reset DB, migrate, seed, test
└── README.md                           this file
```

Run migrations in numeric order — each one assumes the previous ones are
already applied (`supabase db push` / `supabase migration up` do this
automatically; manually, just `psql -f` them 0001 → 0012).

**Why the new tenancy tables (`organization_members`, `user_active_org`,
`organization_invites`) live in `0001_schema.sql` instead of a later 0007+
file, even though they're part of this redesign:** `0002_rls.sql`'s
rewritten `current_org_id()`/`current_org_role()` need these tables to
already exist the moment they're defined — Postgres validates a
plpgsql/sql function's body against the catalog at `CREATE FUNCTION` time,
not deferred to first call — and `0003_claim_function.sql`'s
`claim_device()` in turn needs those helpers to already work. So the raw
table DDL had to move earlier than the migration-numbering convention would
otherwise suggest. Everything genuinely *new* in this redesign — the
`create_organization`/`invite_member`/`change_member_role`/`remove_member`/
`set_active_org` functions, and the `auth.users` signup trigger — still
lands in fresh `0007`/`0008` files, since those have no such
forward-reference problem.

## Data model

- **organizations** — a tenant, and now the system of record for its own
  existence (no external mirror, no webhook sync — Clerk used to own this
  row's lifecycle). `plan` is a portal-only field. Rows are created only by
  `create_organization()` (`0007_org_management_functions.sql`), which
  atomically creates the org, the creator's `org_admin` membership, and
  sets it as their active org — there is no INSERT policy for
  `authenticated` on this table itself.
- **organization_members** — who belongs to which org, in what role. A
  user can belong to multiple organizations (the app's org-switcher-shaped
  UI assumes this), so this is a proper many-to-many join table:
  `(org_id, user_id)` primary key, `role` one of the same five roles as
  before (`org_admin`, `device_admin`, `site_manager`, `safety_officer`,
  `viewer`). No self-service INSERT/UPDATE/DELETE policy exists at all —
  every mutation goes through a SECURITY DEFINER function (see "Tenancy
  functions" below).
- **user_active_org** — one row per user recording which org their session
  is currently "in". See "Active org: why a table, not a JWT claim" below.
- **organization_invites** — records the *intent* ("this email, this org,
  this role") for a person an org_admin invites who doesn't have an
  account yet. Resolved into a real `organization_members` row either
  immediately (if the email already has an `auth.users` row) or by the
  `AFTER INSERT ON auth.users` trigger once they sign up. See "Invites"
  below.
- **sites** — `org_id`-scoped. Carries a `unique (id, org_id)` constraint
  so `devices` can reference `(site_id, org_id)` as a composite FK.
- **devices** — pre-seeded inventory. `status` moves
  `unclaimed → claimed → active ⇄ offline`. `org_id`/`site_id` are nullable
  (unclaimed devices have neither). `claimed_by_user_id` is now a real
  `uuid references auth.users(id)` (previously a bare Clerk `text` id).
  `claim_code_hash` and `device_identity_hash` are bcrypt hashes
  (`pgcrypto`'s `crypt()`); the plaintext exists only transiently, at
  `provision_devices()` call time.
- **storage_configs** — `org_id`-scoped. `credentials_secret_ref` is a
  reference into Supabase Vault (or equivalent) — never a raw secret.
- **device_auth_failures** — unchanged by this redesign; backs the
  per-serial anti-enumeration throttle (see below).

**The structural guarantee worth calling out:** `devices(site_id, org_id)
REFERENCES sites(id, org_id)`, combined with `CHECK (site_id IS NULL OR
org_id IS NOT NULL)`, makes "a device's site belongs to a different org
than the device" **impossible to insert**, full stop — not just
policy-discouraged. This holds even for `service_role`, which bypasses RLS
entirely (constraints aren't RLS; verified by test `E2`).

**Migration-hygiene rule followed throughout:** every FK into Supabase
Auth's own schema references `auth.users.id` (the primary key) only. Per
Supabase's own guidance, no other column or constraint on `auth.users` is
safe to depend on — it's platform-managed and can change without notice.
`invite_member()` and the signup trigger both read `auth.users.email` for
lookup purposes, but nothing is stored or joined elsewhere off of it beyond
that one comparison.

## Auth model

### How a native Supabase Auth session reaches Postgres RLS

1. A user signs in via Supabase Auth (email/password, OAuth, magic link —
   whichever this project's Next.js layer configures); Supabase issues a
   JWT whose `sub` claim is the user's real `auth.users.id`, a genuine
   **uuid** — unlike Clerk's `user_2abc...` ids, which is exactly why the
   old `current_clerk_user_id()` helper existed (to avoid `auth.uid()`'s
   implicit `::uuid` cast throwing on a non-uuid Clerk id). That workaround
   no longer exists: `auth.uid()` is now exactly the right primitive, and
   every human-identity comparison in this project uses it (via
   `current_user_id()`, a thin wrapper kept only for naming symmetry with
   `current_org_id()`/`current_org_role()`).
2. PostgREST executes the request as the Postgres `authenticated` role
   (or `anon` if unauthenticated), exposing the verified JWT via
   `auth.jwt()`/`auth.uid()` — this part of the platform wiring is
   unchanged from before; only what the JWT *contains* changed.
3. **The JWT carries no org or role information at all** — unlike Clerk's
   session token, which used to embed the active org id and role directly
   as claims (`o.id`, `o.rol`), refreshed by Clerk's own session machinery
   on every org switch. A native Supabase Auth JWT is just a user identity.
   Both facts — which org is "active", and the caller's role in it — are
   now resolved from Postgres tables on every request:
   - `current_org_id()` reads `public.user_active_org` (falling back to
     the caller's earliest `public.organization_members` row if unset, or
     if the pointer has gone stale — see "Active org" below).
   - `current_org_role()` reads `public.organization_members` for
     whichever org `current_org_id()` resolved to.
   - `is_org_member(org_id)` checks membership in **any** org, broader
     than the single "active" one — used where a fellow member should see
     something regardless of which org happens to be active right now
     (e.g. listing every org you belong to, for an org-switcher UI).
4. A signed-in user with zero memberships at all (or a stale active-org
   pointer to an org they were since removed from) must still degrade to
   "see nothing", never error — the exact same invariant the old
   Clerk-claims design had for "no active organization selected", just
   re-derived from tables instead of an absent JWT claim. Verified by
   tests `B13a`/`B13b`.

All four helper functions (`current_user_id()`, `current_org_id()`,
`current_org_role()`, `is_org_member()`) are `SECURITY DEFINER` and query
`organization_members`/`user_active_org` directly rather than through those
tables' own RLS — otherwise `organization_members`' own SELECT policy
(itself defined in terms of `is_org_member()`) would make role/org
resolution circular. Each is parameterless-or-uuid-in, derives everything
from the caller's own verified `auth.uid()`, and makes no authorization
decision of its own — they're pure claim resolution, safe to call from
every policy in this file.

### Active org: why a table, not a JWT claim

A user can belong to multiple organizations, so "which one is active right
now" is a real, per-user, mutable fact that has to live somewhere durable.
Clerk's session token used to carry this as a claim, refreshed by its own
`<OrganizationSwitcher/>`-integrated session machinery. Native Supabase
Auth has no equivalent mechanism, and reaching for one (e.g. a custom
access-token hook that stuffs org id into the JWT) was rejected: Supabase's
own docs note access tokens are cached client-side and only refreshed
periodically, so a custom claim would lag an org switch by up to that
refresh interval, and updating it would mean re-minting a token — real
infrastructure for something a plain table solves for free.

`public.user_active_org` (one row per user, `user_id primary key`) is that
table, written only by `set_active_org(org_id)`
(`0007_org_management_functions.sql`), which verifies real membership
server-side before writing anything — a client-supplied `org_id` is never
trusted just because it was sent. A plain table row updated by a SECURITY
DEFINER RPC is immediately consistent (the very next request sees it, no
token-refresh lag) and trivial to test — verified directly by test `I4`,
which reconnects as a fresh session after `set_active_org()` and confirms
`current_org_id()` already reflects the switch, proving persistence rather
than some session-local artifact.

**Default when a user has never explicitly switched** (no row yet, or
their active `org_id` was cleared because they were removed from it):
their **earliest membership** by `organization_members.created_at` — a
simple, stable, deterministic default that needs no extra state of its
own; `current_org_id()` computes it on the fly rather than writing it back,
so reading "what's my active org" is always a side-effect-free lookup, even
for a user who has never called `set_active_org()` (verified by test
`I1`/`I2`). `user_active_org.org_id` is nullable and set to `NULL` (not
cascade-deleted) when the referenced org disappears or the user is removed
from it, so a dangling row's mere existence never breaks this fallback
logic — `remove_member()` proactively clears the pointer when it matches
the org being left (test `J8`/`J8b`), and `current_org_id()` independently
re-verifies the pointer still corresponds to a real membership before
trusting it either way, so the fallback holds even if that cleanup step
were ever missed.

Why a separate table rather than a column on `auth.users`: `auth.users` is
Supabase-managed and explicitly documented as unsafe to extend with
app-owned columns — the exact same reason every FK into that schema in
this project only ever targets `auth.users.id`.

### Organizations, membership, and role changes are all SECURITY DEFINER — same reasoning as `claim_device()`

Every plain RLS policy in this schema fits the shape `USING (org_id =
current_org_id())` — the row already belongs to an org, and RLS asks "is
the caller in that org, with the right role?" Several tenancy operations
don't fit that shape, for the same family of reasons `claim_device()`
(`0003_claim_function.sql`) already established:

- **`create_organization(name)`** — the row being inserted (a brand new
  org) has no membership fact yet to check, the same "this operation gives
  something its first identity" shape as a device's first claim. It also
  has to atomically create a *second* row (the creator's `org_admin`
  membership) and write a *third* table (their active org) in one
  transaction — no single-table RLS policy spans three tables.
- **`invite_member(org_id, email, role)` / `revoke_invite(invite_id)`** —
  authorization depends on the caller's role in a **caller-specified** org
  (the org being managed), which must be checked against
  `organization_members` directly, never trusted from a client-supplied
  "I'm an admin" flag. The existing-user-vs-new-invite branch also needs to
  query `auth.users` by email, which an RLS policy on
  `organization_invites` has no way to do.
- **`change_member_role(org_id, user_id, new_role)` /
  `remove_member(org_id, user_id)`** — both must enforce "the org still has
  at least one `org_admin` after this change", a fact about **other rows**
  in `organization_members`, not the one row being written. RLS's
  `USING`/`WITH CHECK` can only see the row being read or written, never
  count siblings — this invariant is structurally impossible to express as
  a declarative policy no matter how it's phrased.
- **`set_active_org(org_id)`** — must verify the caller is actually a
  member of the org they're asking to switch to, server-side, before
  writing; a client-supplied `org_id` is never trusted on its own.

Every one of these functions reads the caller's identity from `auth.uid()`
(their own already-verified JWT), never from a client-supplied "user_id"
parameter, and re-derives org/role from `organization_members` itself for
whichever `org_id` the caller names — **not** from `current_org_id()` /
`current_org_role()` (which only ever reflect the caller's currently
*active* org), since several of these operations legitimately target an
org that isn't the caller's active one (e.g. managing a second org while
browsing devices in a first). This mirrors `claim_device()`'s own rule:
nothing client-supplied is trusted for "who" or "what role" without a
server-side check against a real table first.

`organization_members` itself accordingly has **no** client
INSERT/UPDATE/DELETE policy at all — only a SELECT policy
(`is_org_member(org_id)`, so any fellow member can see the org's member
list, matching what an org-switcher/member-list UI needs). Every write
reaches the table through one of the SECURITY DEFINER functions above,
which touch it as their (RLS-bypassing) owner regardless of that missing
policy — verified directly by tests `K3`/`K4` (a member cannot raw-INSERT
or raw-UPDATE their org's membership table even though they can SELECT
it).

### Invites: how an org_admin adds someone who doesn't have an account yet

Two real building blocks make this work, split across Postgres and the
Next.js app layer:

- **Supabase Auth's admin invite API**
  (`supabase.auth.admin.inviteUserByEmail(email, { redirectTo, data })`) —
  JS-SDK-only, requires the service-role/secret key, so it can only be
  called from trusted server-side code (a Next.js Route Handler/Server
  Action), never from SQL. Calling it inserts an `auth.users` row
  **immediately**, unconfirmed, before the invited person has done
  anything, then emails them a link. This project's Postgres layer does
  **not** call this API itself — `invite_member()` below is deliberately
  silent about actually sending mail; that's entirely the Next.js layer's
  job, using the outcome this function returns.
- **The standard "trigger on `auth.users` insert" pattern** — an
  `AFTER INSERT ON auth.users` trigger, which is what actually turns a
  pending invite into a real membership.

**`invite_member(org_id, email, role)`** (`0007_org_management_functions.sql`)
is the org-admin-only entry point. It decides, server-side, which of two
outcomes applies:

- The email already has a real `auth.users` account (someone who already
  has a portal login elsewhere, just not in *this* org yet) — their
  membership row is created **immediately**, no invite email needed. (Per
  the researched Admin API behavior, `inviteUserByEmail()` itself would
  just error "user already registered" for this case anyway — deciding it
  here means the Next.js layer never has to branch on that error string.)
- The email has no existing account — a pending `organization_invites` row
  is recorded, and the function returns `outcome = 'invited'`. The Next.js
  layer is expected to call `inviteUserByEmail()` right after this
  returns, using the returned email/role, to actually send the invite.

**`handle_new_user_invites()`** (`0008_invite_signup_trigger.sql`), fired
`AFTER INSERT ON auth.users`, resolves every still-pending invite matching
the new user's email into a real `organization_members` row and marks
those invites accepted. An `AFTER INSERT` trigger is the right mechanism
specifically *because* a new `auth.users` row can appear at two different
moments depending on path — admin-invited (synchronous, immediate, before
the person does anything) or organic self-serve signup (only once they
actually sign up) — and this trigger fires correctly for either ordering,
which is why the logic isn't instead wired only into `invite_member()`
itself (that function typically runs *before* the invited person's
`auth.users` row exists at all — there's nothing yet to link).

Three non-negotiable implementation details, all confirmed against
Supabase's current docs and several GitHub Discussions on this exact
pattern (#21828, #3614, #38887):

- `auth.users` INSERTs execute internally as the `supabase_auth_admin`
  role, which has zero privileges outside the `auth` schema. Without
  `SECURITY DEFINER`, this trigger function fails with "permission denied
  for schema public" the instant it touches `organization_members`.
- The function must be owned by `postgres` (true of every function in this
  project, since migrations run as that role) — `SECURITY DEFINER` then
  runs it with the *owner's* privileges regardless of who
  (`supabase_auth_admin`) triggered the insert.
- `set search_path = ''` isn't just style: an unqualified name inside a
  `SECURITY DEFINER` function is a real privilege-escalation vector, so
  every reference in this function's body is fully schema-qualified.

**Most important, and directly analogous to this project's existing
`device_auth_failures` lesson**: Supabase's own docs explicitly warn that
if this trigger function raises or fails, the **entire signup transaction
rolls back** — a broken invite-resolution trigger would mean nobody can
sign up at all. `handle_new_user_invites()` therefore wraps its whole body
in `EXCEPTION WHEN OTHERS THEN return new;` — deliberately broad, unlike
the narrower "zero rows not raise" pattern in `claim_device()`/
`device_heartbeat()` (see below), because here there's no earlier
audit-log insert in the same transaction that needs to survive a later
raise; the only goal is "never block signup because of invite-resolution
issues", full stop. An unmatched email (the overwhelmingly common case —
most signups have no pending invite at all) is a silent no-op, verified by
tests `H7`/`H7b`.

**Revocation**: `revoke_invite(invite_id)` lets an org_admin cancel a still-
pending invite (e.g. invited the wrong email) — a direct, minimal
completion of `invite_member()`'s lifecycle. `organization_invites`' own
SELECT policy is scoped to `org_id = current_org_id() AND
current_org_role() = 'org_admin'` (tighter than `organization_members`'
own SELECT policy — a pending invite's email/role is sensitive-ish in a way
a plain membership row isn't, so it's visible only to admins managing that
specific org, not every fellow member). **This is active-org-scoped, not
membership-scoped** — a real gap this caught in `local-test/run_tests.sh`
itself: a test that had an org_admin `create_organization()` a throwaway
org (which atomically switches *their own* active org, by design) then
tried to look up one of their original org's invites via this same
policy — and got zero rows, correctly, because their active org had moved.
Not a product bug; a reminder that any *client-side* query against this
table depends on active org even though `revoke_invite()`'s own internal
authorization logic doesn't (it does a direct, org_id-parameterized
membership lookup, same as `claim_device()` — see below).

### Two real vulnerabilities found by adversarial review, both fixed and covered by tests

**Account-squatting via an unconfirmed email** (`invite_member()`'s
existing-user branch, and `handle_new_user_invites()`): the first version
of both matched an email against `auth.users` without checking
`email_confirmed_at`. Since anyone can self-serve-signup with *any* email
address — creating an unconfirmed `auth.users` row immediately, before
proving they control that mailbox — an attacker could pre-squat the exact
email an org_admin was about to invite (or that was about to organically
sign up), and have that invite (potentially for the `org_admin` role
itself) resolve straight to the attacker's own account. Fixed by requiring
`email_confirmed_at is not null` in both places — an unconfirmed row is now
treated as "no real account yet" and falls through to the ordinary
pending-invite path, where the real owner still resolves it normally once
*they* confirm. This also changed `handle_new_user_invites()`'s trigger
definition: it now fires on `AFTER INSERT OR UPDATE OF email_confirmed_at`,
not bare `AFTER INSERT` — `email_confirmed_at` is null at INSERT time for
an ordinary password signup (it only becomes non-null via a *later* UPDATE,
when the person clicks their confirmation link), so gating on bare INSERT
would have meant the confirmation check could never actually pass for that
path. Covered by tests `H3d`/`H3e` (invite_member) and
`H6-unconfirmed`/`H6-confirm`/`H6b` (the trigger, exercising both the
not-yet-confirmed and just-confirmed moments explicitly as two separate
steps).

**An org left with zero admins via account deletion**
(`0009_orphaned_org_admin_guard.sql`): `organization_members.user_id
references auth.users(id) ON DELETE CASCADE` (see `0001_schema.sql`), so
deleting a user's Supabase Auth account removes their membership row
directly via the foreign key — not through `remove_member()`, which is the
*only* place the "an org must always have ≥1 org_admin" invariant was
previously enforced. If the deleted account was an org's sole admin, the
org would be left permanently unmanageable: `change_member_role()`/
`remove_member()` both require the *caller* to already be an org_admin of
the target org, so with zero left, nobody could ever promote a
replacement through normal means again. Fixed with an `AFTER DELETE`
trigger on `organization_members` itself (not on `auth.users` specifically)
so it backstops *every* deletion path uniformly: if a delete leaves an org
with zero admins but at least one other member, the earliest-joined
remaining member is auto-promoted. Covered by tests `L1`–`L2c`, which
simulate the CASCADE path directly (a raw `DELETE`, not a call through
`remove_member()`) against a real second member, and confirm exactly one
admin exists afterward — not zero, not two.

**Two related, lower-severity TOCTOU races**, also fixed: `change_member_role()`/
`remove_member()`'s "would this leave zero admins" check now locks the
relevant rows (`SELECT ... FOR UPDATE`, via a subquery — Postgres rejects
`FOR UPDATE` combined directly with an aggregate like `count(*)`) so two
concurrent calls demoting/removing two different admins at once can't both
see "someone else is still admin" and both proceed. A narrower, *accepted*
race remains, documented inline in `invite_member()`: if a signup's
confirmation lands in the exact window between this function's
existing-user check and its own INSERT committing, the signup trigger
won't see the not-yet-committed invite and correctly no-ops — the invite
row still exists and is still visible to re-invite from, so the practical
impact is "re-invite them," not a security gap or lost data. Disproportionate
to build out further (a periodic reconcile function, same shape as
`cleanup_old_auth_failures`, would close it fully if it ever matters in
practice) for a millisecond-scale race with a cheap fallback.

### Why the claim operation is a SECURITY DEFINER function, not a raw RLS-gated UPDATE

Every other write in this schema fits the shape `USING (org_id =
current_org_id())` — the row already belongs to an org, and RLS asks "is
the caller in that org?" The claim is the one *device-table* operation
that gives a row its first `org_id` (the tenancy equivalent is
`create_organization()`, above — same underlying shape):

- The row's `org_id` is `NULL`. It isn't "in" any org yet — there is no
  membership fact RLS can check.
- The authorization decision instead depends on a fact stored on the *row
  itself* (`claim_code_hash`): does the caller know the secret printed on
  *this specific device's label*? That's a **credential check**, not a
  **membership check** — RLS's `USING`/`WITH CHECK` model has no way to say
  "let this UPDATE through iff a bcrypt comparison against a column on the
  very row being updated succeeds," because `WITH CHECK` only validates the
  *proposed new row* — it would have to trust the client to have submitted
  the correct `org_id`/`claimed_by_user_id` honestly in the first place.
- A raw client-issued `UPDATE ... WHERE claim_code_hash = ...` also invites
  a client supplying its own `org_id` for literally any device it can guess
  a code for, with no server-side link between "the code checked out" and
  "the org_id that got written."

`claim_device()` (`0003_claim_function.sql`) collapses this into one atomic,
server-controlled statement: it reads the caller's identity/org/role from
their **already-verified** JWT plus `current_org_id()`/`current_org_role()`
(never from client-supplied parameters), checks the claim code against the
row's own hash **inside the same statement** that performs the UPDATE
(`FOR UPDATE` lock, then an unconditional `crypt()` comparison before
branching), and only the values *it* computes (not the client) get
written. This also closes the double-claim race for free: two concurrent
claims against the same device serialize on the same row lock, and the
loser's `UPDATE` simply matches zero rows (verified by test `C5`).

A companion function, `lookup_device_by_claim_code()`, lets a client check a
`(serial_number, claim_code)` pair *before* committing to a claim (e.g. to
show a confirmation screen) without this ever becoming a way to enumerate
the unclaimed pool: it requires both values already, and a non-match
returns zero rows rather than an error or a distinguishable failure reason.

Unclaimed devices (`org_id IS NULL`) deliberately have **no SELECT policy at
all** — a policy like `USING (org_id IS NULL)` would let any authenticated
user list the entire unclaimed inventory via a plain `GET
/devices?org_id=is.null`. RLS cannot distinguish "look up the one device
whose label I'm holding" from "list everything" — both compile to the same
`SELECT * FROM devices WHERE ...`. Routing that lookup through a SECURITY
DEFINER function is what makes the distinction possible at all (verified by
tests `B4`/`C1`–`C3`).

### Why the device heartbeat is a *different* SECURITY DEFINER function, granted to `anon`

The Pi calling home has no Supabase Auth identity whatsoever — it's not a
user or org member, it holds one static, device-specific secret
(`device_identity_secret`) and nothing else. This path was never
Clerk-dependent to begin with, so dropping Clerk changes nothing about the
logic here. Two shapes were considered:

1. **Give each device a real Postgres/Supabase credential** with table
   grants gated by an RLS policy ("a row is writable by whoever presents its
   own identity"). Rejected: there is no Supabase-native session type for
   "authenticated as one specific device row." This would mean either
   minting a `service_role`-equivalent credential per device (unmanageable
   key sprawl, and `service_role` bypasses RLS anyway, so it buys zero
   isolation), or smuggling the device secret into a custom signed JWT —
   reintroducing token-issuance infrastructure this project deliberately
   avoids by using Supabase Auth for the human side only.
2. **A SECURITY DEFINER function** taking `(serial_number,
   device_identity_secret)` that authenticates the request *inside the
   function body* and touches exactly one row. **This is what's
   implemented.** Same underlying reason as `claim_device()`: the
   authorization decision depends on a secret compared against a column on
   the row being written, not a session-level role/membership claim — it's
   procedural, not declarative, by nature.

`device_heartbeat()` is granted to `anon` **only** — not `authenticated`,
not `public`. The device calls it over the REST API using the project's
anon/publishable key, exactly like any unauthenticated client would, but
`anon` has zero table grants on `devices` (`0002_rls.sql` revokes all from
`anon`). **`EXECUTE` on this one function is the entire blast radius of a
leaked anon key** as far as this table is concerned — reading or writing
any device row additionally requires a valid `(serial_number,
device_identity_secret)` pair. `authenticated` (real signed-in humans)
deliberately does **not** get this grant — `anon`/`authenticated` are
sibling Postgres roles, neither inherits the other's grants, so the two
auth paths can't be crossed by accident.

`device_heartbeat()` only ever asserts *liveness* (`unclaimed` stays
`unclaimed`; anything else becomes `active`) — it never asserts absence of
it, since a device that's lost connectivity is, by definition, not calling
this endpoint to say so. `mark_stale_devices_offline()` is the other half
of that lifecycle: a `service_role`-only sweep (meant to be driven by
`pg_cron`, a Vercel cron route, etc.) that flips devices whose
`last_seen_at` has gone stale to `offline`.

**Pi integration:** [device-agent](../../device-agent/README.md) provisions a
per-Pi identity file and sends heartbeats independently of Wi-Fi onboarding.
Migration 0012 schedules the offline sweep every minute and authentication-log
cleanup hourly using pg_cron. Public keys use the `apikey` header; legacy anon
JWT keys additionally use `Authorization: Bearer`. Device credentials are never
Supabase administrative keys.

### Anti-enumeration hardening: timing side-channel + throttle

An adversarial review of the first version of these functions (before any
of them were run against real Postgres) found a real, verifiable flaw:
`device_heartbeat`, `lookup_device_by_claim_code`, and `claim_device` all
compared a credential (`crypt(secret, hash)`) inside the same `WHERE` clause
as the `serial_number` lookup. Since `serial_number` is uniquely indexed,
Postgres short-circuits past the expensive bcrypt comparison entirely on an
index miss — fast for a nonexistent serial, slow (bcrypt) for one that
exists — leaking which serials exist via response *timing*, even though the
functions' actual *content* never distinguished the two cases (both return
zero rows / a generic error). Fixed by always looking the row up by
`serial_number` alone first, then **unconditionally** evaluating `crypt()`
exactly once afterward — against the real hash if the row exists, against a
fixed dummy hash (same cost factor) if it doesn't — so both paths cost the
same. The same care applies to combining that result with other checks
(e.g. "already claimed"): a naive `a OR b OR c` can let Postgres short-circuit
past `crypt()` again if an earlier condition already fails, reopening the
same class of leak one level up. Every comparison here is computed into its
own variable *before* being combined with anything else, for exactly this
reason. This lesson is entirely about Postgres/bcrypt semantics and is
unaffected by the Clerk → Supabase Auth swap — nothing here was touched by
this redesign.

On top of that, `device_auth_failures` (`0001_schema.sql`) backs a per-serial
throttle: 10 failed attempts against one serial number in a 15-minute window
blocks further attempts against *that* serial (`0006_auth_throttle.sql` has
the cleanup job that bounds the table's growth). This is deliberately scoped
to one serial, not global — see the file-level comment in
`0006_auth_throttle.sql` for what it does and doesn't protect against;
broader HTTP-layer rate limiting (Supabase project settings, or the Next.js
API routes wrapping these RPCs) is still real defense-in-depth this doesn't
replace.

**A second, more fundamental bug turned up only once these fixes were
actually run against Postgres, not just read over**: `insert into
device_auth_failures (...)` followed by `raise exception` in the same
function doesn't work — an unhandled exception rolls back the *entire*
transaction back to its start, undoing the very audit-log row just written a
few lines earlier. A nested `BEGIN/EXCEPTION` block doesn't fix this either;
it only protects against an error occurring *inside* that block, not a
later, separate `raise` elsewhere in the same outer scope. There's no
autonomous-transaction feature in plain PL/pgSQL to reach for here. The real
fix was architectural: `device_heartbeat` and `claim_device` no longer raise
exceptions for credential failures (unknown serial, wrong secret/code,
already claimed, or throttled) — they return an **empty result set**
instead, exactly the pattern `lookup_device_by_claim_code` already used from
the start for its own, unrelated reason (avoiding a content-level
enumeration signal). Only genuine caller/programming errors that never touch
`device_auth_failures` (missing required params, no active org, insufficient
role, a site that isn't in the caller's org) still raise. Client code calling
these RPCs must check for an empty result, not rely on catching a Postgres
error, to detect a failed claim/heartbeat/lookup.

This exact "zero rows, not raise" lesson generalizes to the invite-signup
trigger too (see "Invites" above), even though the failure mode there is
different (no audit-log row to protect — the concern is "don't block
signup at all"): both are instances of the same underlying rule — a
`SECURITY DEFINER` function whose failure path has side effects (or
consumers) beyond "tell the caller no" must not express that failure as an
unhandled `raise`.

The 132-assertion suite (`local-test/run_tests.sh`, Group F) exercises the
throttle directly: it drives 10 real failed attempts against a dedicated
test device, then asserts the *correct* credential is also rejected on the
11th attempt, and that a different device's heartbeat is unaffected (proving
the throttle is per-serial, not global).

### Column-level grants — the second, independent lock on top of RLS

RLS answers "which *rows*"; grants answer "which *columns*." Both are
enforced, independently, on `devices`:

- `authenticated` gets `UPDATE (display_name, site_id)` only. Even a client
  whose UPDATE satisfies `USING`/`WITH CHECK` gets a Postgres
  permission-denied error if it tries to set `org_id`, `status`,
  `claimed_at`, `claimed_by_user_id`, `serial_number`, or either credential
  hash — there is no code path (short of `service_role` or the SECURITY
  DEFINER functions) that can move a device between orgs or flip its status
  via a plain UPDATE, confirmed by tests `B14`/`B15`.
- `authenticated` gets `SELECT` on every column **except**
  `claim_code_hash`/`device_identity_hash`. These are bcrypt hashes, so
  leaking them isn't an immediate credential leak — but "it's hashed" is not
  a reason to hand a device's credential hash to every `viewer` in that org
  via a REST response either. No legitimate client code path ever needs to
  read them; only the SECURITY DEFINER functions compare against them,
  server-side. (Confirmed by test `B5`.)

### `service_role` needs explicit table grants — a real bug this caught

`service_role` has `BYPASSRLS`, but **BYPASSRLS only bypasses row
policies, not the base privilege system** — a role with zero table grants
still gets `permission denied` on every statement, RLS or not. On a hosted
Supabase project this is invisible because the platform applies a
default-privileges rule to `service_role` when the project is created. That
made an early version of `0002_rls.sql` *look* complete while silently
depending on platform behavior invisible in the migration file itself — it
would have worked on Supabase and failed everywhere else (including this
Docker test harness, which is exactly how it surfaced). Fixed: explicit
`GRANT SELECT, INSERT, UPDATE, DELETE ... TO service_role` on every table
(including the three new tenancy tables) lives directly in `0002_rls.sql`
now, so the migration set is correct and self-contained on plain Postgres
too, not just on Supabase.

## Testing this locally (no real Supabase project needed)

Everything under `local-test/` stands up a **plain `postgres:16` Docker
container** and hand-builds just enough of the Supabase surface these
migrations depend on to exercise RLS for real:

- Three Postgres roles: `anon`, `authenticated`, `service_role` (the last
  with `BYPASSRLS`) — the same three roles PostgREST executes queries as on
  a real project.
- An `auth` schema with `auth.jwt()` reading a per-session GUC
  (`request.jwt.claims`) as jsonb — exactly what PostgREST sets, per
  request, *after* verifying a real JWT's signature. This harness skips
  signature verification entirely (there's no real JWT, just a jsonb
  literal a test script sets directly) — that's fine, because what's under
  test is the SQL/RLS layer *downstream* of that GUC being trustworthy,
  which is identical in shape either way. `00_supabase_shim.sql` is
  completely generic (it was never Clerk-specific, and needed zero changes
  for this redesign) — it just exposes whatever `sub` claim a test sets.
- A minimal `auth.users` table (`00b_shim_auth_users.sql`, new for this
  redesign) — just enough columns (`id`, `email`, `created_at`) for the
  new FKs and the `AFTER INSERT` trigger to have something real to point
  at/fire off. The Clerk-based design never needed this at all: no FK ever
  pointed at `auth.users`, and there was no membership table or signup
  trigger.
- Migrations 0001–0011 are applied completely unmodified — this harness
  changes nothing about the actual migration files, so a pass here is
  evidence about the same SQL that ships to Supabase, not a fork of it.

**Test claims are now Supabase-Auth-shaped, not Clerk-shaped:** every test
persona's JWT is just `{"sub": "<their real auth.users uuid>"}` — no `o.id`/
`o.rol` claims exist anymore, since org and role are resolved from
`organization_members`/`user_active_org` via `auth.uid()`, never trusted
from the JWT itself. See `run_tests.sh`'s `j()` helper.

### Prerequisites

Docker only. No Supabase CLI, no Supabase account, no Clerk account.

### Run it

```bash
cd supabase/local-test

# One-time: start a disposable Postgres 16 container.
docker run -d --name hardhat_rls_test \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=testdb \
  -p 55432:5432 postgres:16

# Wait a couple seconds for it to accept connections, then:
CID=hardhat_rls_test DB=testdb bash reset_and_run.sh
```

`reset_and_run.sh` drops+recreates `testdb`, applies `00_supabase_shim.sql`
and `00b_shim_auth_users.sql`, then all 11 migrations in order, then fixed-id
test fixtures (`01_seed_test_data.sql`: real `auth.users` rows for every
test persona, three orgs, memberships spanning both single- and multi-org
users, sites, devices in known claim states), then runs `run_tests.sh` —
**137 assertions**, actually executed as the relevant Postgres role with a
hand-set `request.jwt.claims`, covering:

| Group | What it proves |
|---|---|
| A (anon) | Zero table access on all tables; the *only* things an anon key can do are call `device_heartbeat` (and only with a correct secret) |
| B (authenticated, isolation) | Cross-org SELECT/INSERT/UPDATE blocked both directions on `sites`/`devices`/`storage_configs`; unclaimed devices are provably unlistable (`org_id IS NULL` → 0 rows) yet still owner-visible once claimed; hash columns unreadable even for one's own org; a user with no active org sees empty results, not errors; column grants block `org_id`/`status` writes even where RLS would otherwise allow the row; the composite FK blocks assigning a cross-org site |
| C (claim flow) | Correct-code lookup/claim succeeds; wrong code, unknown serial, insufficient role, no active org, and cross-org site targets are all rejected with the expected error; double-claim is rejected |
| D (offline sweep) | `authenticated` can't call the sweep; `service_role` can, and it actually flips stale devices |
| E (service_role + constraints) | `service_role` sees across orgs (bypasses RLS) but **still** can't violate the composite FK or the claim-state CHECK — constraints aren't RLS and bind everyone; `provision_devices` works for `service_role` and is denied to `authenticated` |
| F (auth throttle) | 10 failed attempts against one serial blocks the 11th, even with the correct credential; a different serial is unaffected (per-serial, not global); `cleanup_old_auth_failures` is `service_role`-only and actually deletes |
| G (create_organization) | A user with zero memberships can create an org and is atomically made its `org_admin` with it set as their active org; blank names rejected; `anon` denied |
| H (invites + signup trigger) | Inviting a new email records a pending invite; inviting an email with an existing account adds membership immediately with no invite row; duplicate/already-a-member invites rejected; a real `auth.users` INSERT with a matching pending invite creates a real membership and marks the invite accepted; a signup with **no** matching invite is a silent no-op; revocation works and is org_admin-only; non-admins/other orgs can't see or act on an org's pending invites |
| I (active org) | A multi-org user's default active org is their earliest membership; `set_active_org` persists across a fresh connection (not session-local); switching to an org you don't belong to is rejected |
| J (role change / removal) | Role changes and removal are org_admin-only (or self-removal); the "no org with zero `org_admin`s" invariant holds for both demotion and removal, including via self-service; removing a member correctly clears their active-org pointer if it pointed at that org |
| K (membership-list isolation) | A non-member of an org sees none of its `organization_members` rows and cannot raw-INSERT/UPDATE them; `anon` has zero access to any of the three tenancy tables |
| L (orphaned-admin auto-promotion) | Simulating an account-deletion CASCADE (a raw `DELETE` on `organization_members`, not a call through `remove_member()`) against an org's sole admin auto-promotes the earliest-joined remaining member, leaving exactly one admin — not zero, not two |

Sample output from the last full run (reproducible via the command above):

```
RESULTS: 137 passed, 0 failed (total 137)
```

To re-run after changing a migration, just re-run `reset_and_run.sh` — it's
idempotent (drops and rebuilds `testdb` every time). To tear down the
container entirely: `docker rm -f hardhat_rls_test`.

### What this does — and doesn't — prove

**Proves:** the RLS policies, column grants, CHECK/FK constraints, and all
SECURITY DEFINER functions (device auth *and* tenancy management) behave
exactly as designed, under real Postgres, under adversarial-shaped inputs
(wrong secrets, cross-org targets, missing org claims, concurrent
double-claims, orphan-admin attempts, mismatched invites), not just "the
SQL parses" or "it looks right on inspection."

**Doesn't prove:** that Supabase's real hosted Auth will actually issue
JWTs in this shape in production, that `supabase.auth.admin.
inviteUserByEmail()` actually sends mail and lands a row in `auth.users` the
way this design assumes, or that the Next.js layer built on top of these
RPCs calls them correctly — those depend on real dashboard/project
configuration and the separate Next.js-side implementation, neither of
which has local emulation here. Smoke-test once against a real (free-tier
is fine) Supabase project before go-live: sign in, confirm `select
auth.uid();` from a request made with that session's token returns the
expected uuid, and walk through `create_organization` →
`invite_member` → (a second browser/incognito session) actually signing up
via the emailed invite link → confirming a real `organization_members` row
appears.

## Provisioning real devices

`provision_devices(serial_numbers text[])` (`0005_provisioning_function.sql`)
is `service_role`-only and takes real serial numbers (a hardware batch's own
serials/asset tags — it does not invent them). For each serial it generates
two independent 160-bit random secrets (`claim_code`,
`device_identity_secret` — distinct entropy sources, never derived from
each other or the serial), stores only their bcrypt hashes, and returns the
plaintext **exactly once**:

```sql
select * from public.provision_devices(array[
  'PI-SN-4C1A9F2B',
  'PI-SN-4C1A9F2C'
]);
```

Run this from a trusted operator session (`psql`/SQL editor) with the
service-role credential, capture the result immediately (label printing /
device-image flashing), and discard it from wherever you ran it — the
plaintext cannot be recovered from the database afterward, only the hashes
persist.

`seed.sql` calls this same function with disposable `DEV-HARDHAT-000N`
serials, purely for local/dev convenience. It is **not** meant to run
against a production project, and its own safety guard (see its header)
means it is **not** run automatically by `supabase db reset` in this
project (`[db.seed].enabled = false` in `config.toml`) — the persistent
`alter database ... set app.confirm_seed = ...` form that would allow that
requires real Postgres superuser, which Supabase's `postgres` role does not
have, confirmed by actually running it against a local CLI stack. Run it
manually instead, once per fresh local stack, per the one-liner in
`seed.sql`'s own header.
Why SQL rather than a Node/Python seed script: the actual
generate-random+hash+insert logic already lives, correctly, in exactly one
place (`provision_devices`, reviewed as the security-sensitive piece here) —
a seed script's only remaining job is "call it and print the result," which
plain SQL does with zero added dependencies (no separate package needs a
service-role credential just to print five rows). A future "generate batch
+ download label PDFs" admin UI should be a thin wrapper calling this same
function, not a second implementation of the hashing. (Unaffected by the
Clerk → Supabase Auth swap — provisioning never touched human identity.)

## What the Next.js layer needs from this (context for that follow-up task)

This migration set is Postgres/SQL-only; a separate task replaces
`@clerk/nextjs` throughout `src/` (`ClerkProvider`, `clerkMiddleware` in
`src/proxy.ts`, the Clerk `organization.created` webhook, Clerk's prebuilt
`<SignIn>`/`<SignUp>`/`<OrganizationList>`/`<OrganizationSwitcher>`/
`<OrganizationProfile>` components, and `auth()`/`useSession()` calls for
org id/role) with `@supabase/ssr` + these RPCs. Concretely, that layer will
need to:

- Call `create_organization(name)` wherever the app currently drives
  Clerk's "create organization" flow.
- Call `invite_member(org_id, email, role)` first, then — only if it
  returns `outcome = 'invited'` — call
  `supabase.auth.admin.inviteUserByEmail(email, { redirectTo })` with a
  service-role client, server-side only. If it returns
  `outcome = 'added_existing_member'`, no email call is needed at all.
- Call `set_active_org(org_id)` wherever the app currently relies on
  Clerk's `<OrganizationSwitcher/>` to change the active org, and read
  `current_org_id()`/`current_org_role()` (or just query
  `organization_members`/`user_active_org` directly) wherever it used to
  read `o.id`/`o.rol` off the session.
- Call `change_member_role`/`remove_member` wherever it currently drives
  Clerk's `<OrganizationProfile/>` member-management UI, and render
  `organization_invites` (via its `org_admin`-only SELECT policy) plus a
  `revoke_invite` action for pending invites.
- Use `getClaims()` (not `getSession()`/`getUser()`) inside `src/proxy.ts`
  to authorize requests — see that file's own header for why, once
  rewritten, and why `src/proxy.ts`'s current filename needs no change
  under Next.js 16.

## Member-list email compatibility (0011)

Migration `0011_member_email_type.sql` casts `auth.users.email` to the declared `text` result of `list_org_members`. Apply it to databases that already ran 0010. The test shim uses `varchar(255)`, matching local Supabase, so the existing member-list assertions exercise the type conversion.

## Device maintenance schedule (0012)

`0012_device_maintenance.sql` enables Supabase pg_cron and schedules offline
detection every minute (ten-minute last-seen threshold), plus hourly cleanup
of auth failures older than one day. Unlike migrations 0001–0011 this requires
the Supabase platform extension, so it is verified against the real local
stack by `device-agent/tests/local_integration.py`, not the plain Postgres shim.
