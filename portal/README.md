# Hard Hat Portal

Customer-facing web portal for the hard-hat IoT project: organization
dashboard, sites, device claiming/management, and per-org storage
configuration. Next.js (App Router, TypeScript, Tailwind), native Supabase
Auth for human sign-in, Supabase/Postgres for data + RLS + tenancy.

This app is built against the schema/RLS/auth-function design in
`supabase/` **as-is** -- read `supabase/README.md` first if you're going to
touch anything auth- or RLS-related here; this README assumes it, and only
restates what's needed to run/deploy the Next.js layer on top of it.

## Sep 2026: Clerk dropped, native Supabase Auth adopted

This app originally used Clerk Organizations for human auth. Clerk's
custom-roles feature requires a paid add-on in production, so this app now
uses **Supabase's own native Auth** instead -- open source, no per-role
paywall. Clerk's "Organizations" product used to give this app membership,
roles, active-org selection, and invites for free, synced into Postgres by a
webhook. Native Supabase Auth has users and JWTs, nothing org-shaped, so all
of that is now built by hand: `supabase/migrations/0001_schema.sql` onward
define `organizations`/`organization_members`/`user_active_org`/
`organization_invites` and the RPCs that manage them (see
`supabase/README.md` for the full design and the 137-assertion test suite
that verifies it), and this app's `src/` is a from-scratch rewrite of every
Clerk-provided UI surface (`<SignIn>`, `<SignUp>`, `<OrganizationSwitcher>`,
`<OrganizationProfile>`, the `organization.created` webhook) against those
RPCs. There is no Clerk code, no webhook route, and no `@clerk/*` dependency
left anywhere in this app.

## Architecture at a glance

```
Browser / Server Component
        │  Supabase Auth session cookie (native email/password -- no
        │  external identity provider; JWT `sub` is the user's real
        │  auth.users.id, a uuid)
        ▼
Supabase (PostgREST) ── verifies the JWT's own signature ── runs the
        │                query as Postgres role `authenticated`
        ▼
Postgres ── RLS reads auth.uid() directly; org id + role are NOT in the
            JWT -- current_org_id()/current_org_role() (both SECURITY
            DEFINER, supabase/migrations/0002_rls.sql) resolve them per
            request from organization_members/user_active_org instead
            (see supabase/README.md's "Auth model" section for why a
            table, not a JWT claim)


Server Action (e.g. org/actions.ts's inviteMember, only when
supabase.rpc("invite_member") returns outcome = "invited")
        │
        ▼
supabase.auth.admin.inviteUserByEmail() (src/lib/supabase/admin.ts,
service_role key -- JS-SDK-only, can't be expressed in SQL)
        │
        ▼
Supabase sends the invite email; the link lands on /auth/confirm, which
verifyOtp()'s the token_hash and (via 0008_invite_signup_trigger.sql)
resolves the pending organization_invites row into real membership
```

Three Supabase clients exist in this app, and the split matters:

- `src/lib/supabase/server.ts` (`createServerSupabaseClient`, async --
  every caller must `await` it) and `src/lib/supabase/client.ts`
  (`createBrowserSupabaseClient`) -- both plain `@supabase/ssr` clients
  authenticated as the **current human user** via their own session
  cookie. Every RLS policy applies normally. This is what every
  page/Server Action/Client Component in this app uses.
- `src/lib/supabase/admin.ts` (`createAdminSupabaseClient`) -- the
  **service_role** key, bypasses RLS entirely. Used in exactly one place:
  `inviteMember()` (`src/app/(app)/org/actions.ts`), for
  `supabase.auth.admin.inviteUserByEmail()`, which is JS-SDK-only and
  requires this key -- it can never be called from SQL (see
  `supabase/README.md`'s "Invites" section). Never import this from a
  Client Component or a user-facing read/write path.

## Running locally

```bash
npm install
cp .env.example .env.local   # then fill in real values, see below
npm run dev
```

`npm run build` uses Webpack because Turbopack cannot bind its worker port in the local managed environment.

`npm run build` / `npx tsc --noEmit` succeed with placeholder `.env.example`
values (no code path makes a live network call at build time), but the app
won't be usable at runtime until a real Supabase project is configured per
"First-time setup" below.

## First-time setup: Supabase

1. **Create a Supabase project** at https://supabase.com/dashboard (or run
   one locally via the Supabase CLI -- see `supabase/README.md`'s "Testing
   this locally" section for a Docker-only alternative that doesn't need a
   real project at all, useful for iterating on the SQL itself).
2. **Apply the migrations**: from `supabase/`, either `supabase db push`
   (recommended -- applies `migrations/` in order automatically) or,
   against any plain Postgres connection string, `psql -f` each file in
   `migrations/` in numeric order (`0001` through `0011`). See
   `supabase/README.md` for details and for `seed.sql` (dev-only fixture
   devices, not for production).
3. **Confirm email/password sign-up is enabled**: Dashboard ->
   Authentication -> Sign In / Providers -> Email. This is on by default
   for a new project; this app uses only email/password
   (`signInWithPassword`/`signUp`), no OAuth/magic-link UI exists yet.
4. **Set Site URL and Redirect URLs**: Dashboard -> Authentication -> URL
   Configuration. Set **Site URL** to this app's real origin (e.g.
   `https://portal.example.com`, or `http://localhost:3000` for local-only
   testing), and add that same origin to **Redirect URLs**. Supabase
   silently rejects `emailRedirectTo`/`redirectTo` values that aren't
   allow-listed here -- if confirmation/reset links 404 or bounce back to
   Supabase's own default page, this is almost always why.
5. **Replace the email templates that need to reach `/auth/confirm`.**
   This is the step that's easiest to skip and will make every auth email
   silently useless: Supabase's **default** templates link to Supabase's
   own hosted `/auth/v1/verify` endpoint via `{{ .ConfirmationURL }}`,
   which delivers the session as a URL fragment
   (`#access_token=...`) that a server-side Next.js route can never read.
   This app's `src/app/auth/confirm/route.ts` instead expects
   `token_hash` + `type` as query params and calls `verifyOtp()` itself
   (Supabase's documented PKCE-flow pattern for server-rendered apps). Go
   to Dashboard -> Authentication -> Email Templates and replace the body
   of these three templates:

   **Confirm signup:**
   ```html
   <h2>Confirm your signup</h2>
   <p>Follow this link to confirm your account:</p>
   <p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup">Confirm your email</a></p>
   ```

   **Reset Password:**
   ```html
   <h2>Reset Password</h2>
   <p>Follow this link to reset your password:</p>
   <p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/auth/reset-password">Reset Password</a></p>
   ```

   **Invite user** (sent by `inviteUserByEmail()`, see the "Invites"
   section below):
   ```html
   <h2>You've been invited</h2>
   <p>You've been invited to join an organization on Hard Hat Portal. Follow this link to accept:</p>
   <p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/auth/reset-password">Accept the invite</a></p>
   ```

   The `next` param is optional -- `/auth/confirm` defaults to
   `/dashboard` when it's absent (see that route's own open-redirect-guard
   comment), which is correct for signup (nothing else to set up first).
   Reset-password and invite both need it set explicitly to
   `/auth/reset-password`, for the same reason: `verifyOtp()` on either
   link authenticates the visitor but never sets a password on its own --
   `inviteUserByEmail()` creates the `auth.users` row with no password at
   all, so without this, an invited member lands on `/dashboard` fully
   signed in but has no way to sign in again later (no magic-link/OAuth
   exists in this app, only email+password). Routing both through
   `/auth/reset-password` first means every path that establishes a
   session via `verifyOtp()`, not just literal "I forgot my password,"
   ends with the visitor actually holding a usable credential.

   **Local CLI stack only:** if you edit a file under
   `supabase/templates/*.html` after `supabase start` has already run, the
   change won't show up in the next email sent -- confirmed directly by
   editing `invite_user.html` and re-sending an invite, which still
   rendered the old template. The local auth container reads each
   template's content once at container startup, not per-request. Pick
   one: `docker restart supabase_auth_portal` (fast, doesn't touch the
   database) or `supabase stop && supabase start` (slower, but also
   correct). This is a local-CLI-only quirk -- a real hosted Supabase
   project's dashboard-edited templates apply immediately, no restart of
   anything required.
6. **Copy your keys** into `.env.local`: Dashboard -> Project Settings ->
   Data API -> `NEXT_PUBLIC_SUPABASE_URL`; Project Settings -> API Keys ->
   the **publishable** key -> `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and
   the **service_role** secret key -> `SUPABASE_SERVICE_ROLE_KEY`
   (server-only, see the warning in `.env.example` -- never expose this to
   the browser).
7. **Set `NEXT_PUBLIC_SITE_URL`** in `.env.local` to the same origin used
   in step 4 -- it's what builds the absolute `emailRedirectTo`/
   `redirectTo` URLs in `src/app/auth/actions.ts` and the invite flow in
   `src/app/(app)/org/actions.ts`.
8. **Smoke-test the whole loop once for real** before trusting it: sign up
   a throwaway account, confirm the email actually arrives and its link
   signs you in at `/dashboard` (not Supabase's own page); create an
   organization; invite a second, real email address you control and
   confirm *that* invite email arrives, and that accepting it (setting a
   password, if prompted) lands them in the same organization as a member.
   The local Docker RLS test suite (`supabase/local-test/`) proves the SQL
   is correct; it does **not** prove these real emails actually get sent
   and land in the right shape in your actual environment.

## Environment variables

See `.env.example` for the full list with inline comments on exactly where
in each dashboard to find every value. Summary:

| Variable | Where it's used | Exposed to browser? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `src/lib/supabase/*.ts` | Yes |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `src/lib/supabase/server.ts`, `client.ts`, `middleware.ts` | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | `src/lib/supabase/admin.ts` only | **No, never** |
| `NEXT_PUBLIC_SITE_URL` | `src/app/auth/actions.ts`, `src/app/(app)/org/actions.ts` | Yes |

## How the auth wiring works in this app's code

- `src/proxy.ts` (Next.js 16's replacement filename for `middleware.ts`)
  delegates to `src/lib/supabase/middleware.ts`'s `updateSession()`, which
  refreshes the session cookie on every request and redirects
  unauthenticated visitors to `/sign-in` for every route not in its
  `PUBLIC_PATHS` allowlist. It uses `getClaims()`, not `getUser()`/
  `getSession()` -- see that file's own header comment for why (JWT
  signature validated locally, no extra Auth-server round-trip, unlike
  `getSession()`'s untrustworthy embedded user object).
- `src/lib/org-context.ts`'s `getOrgContext()` is the direct replacement
  for the Clerk-era `const { userId, orgId, orgRole } = await auth()`: it
  reads the caller's id off `getClaims()`, then calls the
  `current_org_id()`/`current_org_role()` RPCs (both already
  `authenticated`-granted, `0002_rls.sql`) to resolve active org and role.
  Every Server Action/Server Component that needs org context calls this
  once, fresh, per request.
- RLS is the actual authorization boundary. The role checks in
  `src/lib/roles.ts` and scattered through the Server Actions (e.g. "only
  org_admin/site_manager can manage sites") are UX / defense-in-depth
  only -- they exist to fail fast with a friendly message, not because the
  database trusts them. If this app's role checks and Postgres's RLS
  policies (`supabase/migrations/0002_rls.sql`) ever disagree, Postgres
  wins; that's a bug in this app, not in the database.
- Sign-in/sign-up (`src/app/sign-in/`, `src/app/sign-up/`) are plain forms
  using `useActionState` against `signIn`/`signUp` in
  `src/app/auth/actions.ts`, which call
  `signInWithPassword`/`signUp` directly -- no prebuilt component, since
  Supabase (unlike Clerk) doesn't ship one.
- `src/app/auth/confirm/route.ts` is the shared landing spot for every
  emailed link (signup confirmation, password reset, and invite
  acceptance) -- `type` (`signup`/`recovery`/`invite`) distinguishes them,
  all handled by one `verifyOtp({ type, token_hash })` call. See "First-time
  setup" step 5 above -- this route does nothing useful until the email
  templates are repointed at it.

## Tenancy: org creation, switching, and member management

Clerk used to provide organization creation, an org switcher, and a full
member-management UI (`<OrganizationProfile>`) for free. This app now
implements all three directly against the RPCs in
`supabase/migrations/0007_org_management_functions.sql` (see
`supabase/README.md`'s "Organizations, membership, and role changes" and
"Invites" sections for the full server-side design):

- **`src/app/onboarding/`** -- reached only by a signed-in user with zero
  memberships anywhere (`(app)/layout.tsx` redirects here whenever
  `getOrgContext()` resolves no active org). A single "create an
  organization" form calling `create_organization(name)`, which atomically
  creates the org, makes the caller its `org_admin`, and sets it as their
  active org.
- **`src/app/(app)/layout.tsx`** -- fetches every organization the caller
  belongs to (not just the active one) and renders
  `src/app/(app)/org-switcher.tsx` (a client `<select>`) whenever they
  belong to more than one; switching calls `switchActiveOrg()`
  (`src/app/(app)/actions.ts`), which calls `set_active_org(org_id)` and
  redirects to `/dashboard`.
- **`src/app/(app)/org/`** -- the org-settings page: `rename-org-form.tsx`
  (org_admin-only rename), `invite-form.tsx` + `pending-invites.tsx` +
  `member-list.tsx` for full member management. `actions.ts` wires these to
  `invite_member`/`revoke_invite`/`change_member_role`/`remove_member`, plus
  the `inviteUserByEmail()` call described in the architecture diagram
  above (only fired when `invite_member` returns
  `outcome: "invited"` -- inviting an email that already has an account
  elsewhere adds membership immediately with no email needed, per
  `supabase/README.md`'s "Invites" section). Member emails are resolved via
  the `list_org_members()` RPC (`0010_list_org_members.sql`) -- the only
  sanctioned way to see a fellow member's email address.

## The 5 roles and what they can do (UI-level; DB is authoritative)

| Role | Sites | Devices | Claim device | Storage configs | Org settings |
|---|---|---|---|---|---|
| `org_admin` | full CRUD | edit name/site | yes | full CRUD | rename, manage members |
| `device_admin` | read-only | edit name/site | yes | none | none |
| `site_manager` | full CRUD | read-only | no | none | none |
| `safety_officer` | read-only | read-only | no | none | none |
| `viewer` | read-only | read-only | no | none | none |

Unlike the Clerk era (where every non-`org_admin` role still got Clerk's
built-in member-management permission by default), member management is now
**`org_admin`-only, full stop** -- `src/lib/roles.ts`'s `canManageMembers()`
mirrors `invite_member`/`change_member_role`/`remove_member`'s own
authorization checks exactly, with no equivalent of Clerk's separate
per-role-set permission toggle to configure.

## Notable design choices carried over from the DB layer

- **Claiming a device never distinguishes *why* it failed.** The
  `lookup_device_by_claim_code` and `claim_device` RPCs both return an
  **empty result set** (not a thrown error) for a wrong code, an unknown
  serial, an already-claimed device, or a throttled serial -- on purpose,
  to avoid leaking which case occurred (see `supabase/README.md`'s
  "Anti-enumeration hardening"). This app's claim flow
  (`src/app/(app)/devices/claim/`) checks `data.length === 0`, not a
  caught exception, and shows exactly one generic message for all of those
  cases. If you're tempted to make that error message more specific,
  don't -- that's the whole point of that part of the schema.
- **`requestPasswordReset` always returns `{ ok: true }`**, whether or not
  the email actually has an account -- the same anti-enumeration principle
  applied to the password-reset form itself (`src/app/auth/actions.ts`).
- **`storage_configs.credentials_secret_ref` is a reference, never a raw
  secret.** The storage page's form is a text field for a secret-store
  reference/name (e.g. a Supabase Vault secret name), with an explicit note
  in the UI. This app has no code path that accepts or stores an actual
  credential value, because there's no secrets-store integration built yet
  -- wiring up Vault (or equivalent) and actually resolving
  `credentials_secret_ref` to a usable credential at data-upload time is
  future work, out of scope here.
- **Unclaimed device inventory is not listable**, by design, at the RLS
  layer -- there is no page in this app that tries to show "all unclaimed
  devices" for that reason (see the devices table's RLS comment in
  `0002_rls.sql`).
- **`device_heartbeat()` is not called by this app.** It's an `anon`-only
  RPC for the Pi-side phone-home path; see `supabase/README.md`'s "device
  heartbeat" section.

## Project structure

```
src/
├── proxy.ts                     Next.js 16 middleware-equivalent: session
│                                 refresh + sign-in requirement for every
│                                 route not in the public allowlist
├── app/
│   ├── layout.tsx                Fonts + globals.css (no provider needed --
│   │                              native Supabase Auth has no client-side
│   │                              context provider to wrap the app in)
│   ├── page.tsx                  Public landing page
│   ├── sign-in/                  Email/password sign-in form
│   ├── sign-up/                  Email/password sign-up form
│   ├── auth/
│   │   ├── actions.ts             signIn/signUp/signOut/requestPasswordReset/
│   │   │                          updatePassword Server Actions
│   │   ├── confirm/route.ts       verifyOtp() handler for every emailed link
│   │   ├── forgot-password/       Request a reset link
│   │   ├── reset-password/        Set a new password (post-verifyOtp session)
│   │   └── error/                 Expired/invalid-link landing page
│   ├── onboarding/                create_organization() form (zero-org users)
│   └── (app)/                    Everything requiring an active organization
│       ├── layout.tsx             Nav shell, org switcher, redirects to
│       │                          /onboarding if no active org
│       ├── actions.ts             switchActiveOrg()
│       ├── org-switcher.tsx       Client <select> for multi-org users
│       ├── dashboard/             Sites/devices/storage overview
│       ├── sites/                 List/create/rename/delete
│       ├── devices/               List + edit display_name/site
│       │   └── claim/             lookup -> confirm -> claim flow
│       ├── storage/                provider/bucket/region/secret-ref CRUD (org_admin)
│       └── org/                   Rename org + full member/invite management
└── lib/
    ├── roles.ts                  The 5-role permission matrix (UX only)
    ├── org-context.ts             getOrgContext()/getCurrentUserClaims()
    └── supabase/
        ├── server.ts              Server Component/Action client
        ├── client.ts              Client Component client
        ├── middleware.ts          Session refresh + route protection (proxy.ts)
        ├── admin.ts               service_role client (inviteUserByEmail only)
        └── types.ts               Hand-written row shapes matching the migrations
```

## Build / typecheck

```bash
npm run build      # next build (also typechecks as part of the build)
npx tsc --noEmit   # standalone typecheck
npx eslint .        # lint
```

All three succeed against this repo with only placeholder `.env.example`
values -- there is no build-time network call to Supabase.

### September 10 portal fixes

Apply migration `0011_member_email_type.sql` to existing databases (or use the normal migration runner). It fixes member listing against Supabase's actual `varchar` email column without changing membership permissions. The local SQL harness now uses the same column type.

Sign-in preserves local destinations and query parameters, including device claim links with `serial_number` and `claim_code`. External redirect destinations fall back to the dashboard.
