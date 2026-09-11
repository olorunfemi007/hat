# Graph Report - .  (2026-09-09)

## Corpus Check
- 103 files · ~60,687 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 474 nodes · 871 edges · 43 communities (23 shown, 20 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 34 edges (avg confidence: 0.8)
- Token cost: 48,247 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Org & Device Server Actions|Org & Device Server Actions]]
- [[_COMMUNITY_Sites & Devices UI|Sites & Devices UI]]
- [[_COMMUNITY_Portal Data Model & RLS|Portal Data Model & RLS]]
- [[_COMMUNITY_WiFi Onboarding Core (Go)|WiFi Onboarding Core (Go)]]
- [[_COMMUNITY_Org Invites & Membership|Org Invites & Membership]]
- [[_COMMUNITY_Project Docs & Auth Stack|Project Docs & Auth Stack]]
- [[_COMMUNITY_Portal Dependencies|Portal Dependencies]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_Auth Flows (Sign InUpReset)|Auth Flows (Sign In/Up/Reset)]]
- [[_COMMUNITY_Request Routing & Middleware|Request Routing & Middleware]]
- [[_COMMUNITY_Voice Trigger Docs (PocketSphinx KWS)|Voice Trigger Docs (PocketSphinx KWS)]]
- [[_COMMUNITY_Captive Portal & Email Templates|Captive Portal & Email Templates]]
- [[_COMMUNITY_Supabase Local Test Runner|Supabase Local Test Runner]]
- [[_COMMUNITY_Device Claim State & Types|Device Claim State & Types]]
- [[_COMMUNITY_Voice Trigger Camera Runner|Voice Trigger Camera Runner]]
- [[_COMMUNITY_Root Layout (FontsMetadata)|Root Layout (Fonts/Metadata)]]
- [[_COMMUNITY_Voice Model Downloader|Voice Model Downloader]]
- [[_COMMUNITY_Go Installer Script|Go Installer Script]]
- [[_COMMUNITY_Voice Trigger Pi Setup|Voice Trigger Pi Setup]]
- [[_COMMUNITY_Linux Socket Binding|Linux Socket Binding]]
- [[_COMMUNITY_Non-Linux Socket Binding|Non-Linux Socket Binding]]
- [[_COMMUNITY_Claude Memory Stub|Claude Memory Stub]]
- [[_COMMUNITY_DB Reset & Test Script|DB Reset & Test Script]]
- [[_COMMUNITY_Next.js Config|Next.js Config]]
- [[_COMMUNITY_PostCSS Config|PostCSS Config]]
- [[_COMMUNITY_Org Members RPC|Org Members RPC]]
- [[_COMMUNITY_Audio Fix Script|Audio Fix Script]]
- [[_COMMUNITY_WiFi Onboarding Pi Setup|WiFi Onboarding Pi Setup]]
- [[_COMMUNITY_Voice Trigger Go Module|Voice Trigger Go Module]]
- [[_COMMUNITY_WiFi Onboarding Go Module|WiFi Onboarding Go Module]]
- [[_COMMUNITY_Password Reset Anti-Enumeration Note|Password Reset Anti-Enumeration Note]]
- [[_COMMUNITY_File Icon Asset|File Icon Asset]]
- [[_COMMUNITY_Globe Icon Asset|Globe Icon Asset]]
- [[_COMMUNITY_Next.js Logo Asset|Next.js Logo Asset]]
- [[_COMMUNITY_Vercel Logo Asset|Vercel Logo Asset]]
- [[_COMMUNITY_Window Icon Asset|Window Icon Asset]]

## God Nodes (most connected - your core abstractions)
1. `createServerSupabaseClient()` - 49 edges
2. `getOrgContext()` - 32 edges
3. `compilerOptions` - 16 edges
4. `runCmd()` - 13 edges
5. `Context` - 13 edges
6. `organization_members table` - 13 edges
7. `ActionResult` - 11 edges
8. `canClaimDevice()` - 11 edges
9. `devices table` - 10 edges
10. `canManageStorage()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `Device identity (serial, UUID, cert, private key)` --semantically_similar_to--> `devices table`  [INFERRED] [semantically similar]
  workflow.txt → portal/supabase/README.md
- `Claim device flow (QR/claim code)` --semantically_similar_to--> `claim_device()`  [INFERRED] [semantically similar]
  workflow.txt → portal/supabase/README.md
- `voice-trigger program` --semantically_similar_to--> `Future edge-AI capabilities`  [INFERRED] [semantically similar]
  voice-trigger/README.md → workflow.txt
- `portal.yourhardhat.com company login` --semantically_similar_to--> `Hard Hat Portal`  [INFERRED] [semantically similar]
  workflow.txt → portal/README.md
- `Enterprise SSO` --semantically_similar_to--> `Supabase Auth (native)`  [INFERRED] [semantically similar]
  workflow.txt → portal/README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Clerk-to-native-Supabase-Auth migration** — portal_readme_clerk, portal_readme_supabase_auth, supabase_readme_clerk, supabase_readme_supabase_auth, supabase_readme_organization_members_table [EXTRACTED 1.00]
- **SECURITY DEFINER functions bypassing RLS for structurally-inexpressible authorization** — supabase_readme_create_organization, supabase_readme_invite_member, supabase_readme_change_member_role, supabase_readme_remove_member, supabase_readme_set_active_org, supabase_readme_claim_device, supabase_readme_device_heartbeat [EXTRACTED 1.00]
- **Three separate identity concerns in helmet onboarding (human account, device certificate, network provisioning)** — workflow_three_identities_principle, portal_readme_supabase_auth, supabase_readme_devices_table, wifi_onboarding_readme_program [INFERRED 0.85]

## Communities (43 total, 20 thin omitted)

### Community 0 - "Org & Device Server Actions"
Cohesion: 0.07
Nodes (54): switchActiveOrg(), AppLayout(), OrgSwitcher(), Home(), signOut(), claimDevice(), EXPECTED_CLAIM_ERROR_CODES, lookupDevice() (+46 more)

### Community 1 - "Sites & Devices UI"
Cohesion: 0.09
Nodes (33): StatusBadge(), STYLES, DeviceRow(), initialState, canManageSites(), ActionResult, createSite(), deleteSite() (+25 more)

### Community 2 - "Portal Data Model & RLS"
Cohesion: 0.06
Nodes (38): Browser Supabase client (client.ts), Device claim flow UI (anti-enumeration), device_heartbeat() not called by this app, devices table, 5-role permission matrix, organizations table, Row Level Security (RLS), RLS is the actual authorization boundary (+30 more)

### Community 3 - "WiFi Onboarding Core (Go)"
Cohesion: 0.13
Nodes (32): Config, IP, eslintConfig, Config, gatewayFromCIDR(), Context, Duration, Mutex (+24 more)

### Community 4 - "Org Invites & Membership"
Cohesion: 0.08
Nodes (35): Admin Supabase client (admin.ts), current_org_id(), current_org_role(), getOrgContext(), inviteMember() Server Action, supabase.auth.admin.inviteUserByEmail(), Onboarding: create_organization() form, Org settings member/invite management UI (+27 more)

### Community 5 - "Project Docs & Auth Stack"
Cohesion: 0.08
Nodes (33): generate-agent-files.js generator, next dev command, Next.js Agent Rules Block, portal CLAUDE.md, Clerk, Hard Hat Portal, Next.js App Router, Supabase Auth (native) (+25 more)

### Community 6 - "Portal Dependencies"
Cohesion: 0.08
Nodes (24): dependencies, next, react, react-dom, server-only, @supabase/ssr, @supabase/supabase-js, devDependencies (+16 more)

### Community 7 - "TypeScript Config"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 8 - "Auth Flows (Sign In/Up/Reset)"
Cohesion: 0.16
Nodes (10): AuthActionState, requestPasswordReset(), signIn(), signUp(), siteUrl(), updatePassword(), initialState, initialState (+2 more)

### Community 9 - "Request Routing & Middleware"
Cohesion: 0.16
Nodes (12): Request, ResponseWriter, Server, config, proxy(), isPublicRoute(), PUBLIC_PATHS, updateSession() (+4 more)

### Community 10 - "Voice Trigger Docs (PocketSphinx KWS)"
Cohesion: 0.14
Nodes (19): voice-trigger CLI flags, download_models.sh, keyword.list (KWS thresholds), kws_listen.py (PocketSphinx wrapper), main.go orchestrator, mic_test.py, PocketSphinx 5.x model path layout gotcha, Raspberry Pi deployment (pip not apt, arm64) (+11 more)

### Community 11 - "Captive Portal & Email Templates"
Cohesion: 0.16
Nodes (16): src/app/auth/confirm/route.ts (verifyOtp handler), Email template replacement (First-time setup step 5), Reset Password email template, Confirm signup email template, Invite user email template, /connect POST form, iOS captive portal quirk help text, Manual SSID entry field (+8 more)

### Community 12 - "Supabase Local Test Runner"
Cohesion: 0.42
Nodes (10): expect_err(), expect_ok(), expect_ok_super(), expect_rows(), fail(), FAILURES, pass(), run() (+2 more)

### Community 13 - "Device Claim State & Types"
Cohesion: 0.24
Nodes (8): ClaimState, LookupState, ClaimForm(), FoundDevice, initialClaimState, initialLookupState, ClaimDeviceResult, DeviceLookupResult

### Community 14 - "Voice Trigger Camera Runner"
Cohesion: 0.43
Nodes (5): Cmd, cameraRunner, Mutex, main(), startCommand()

### Community 15 - "Root Layout (Fonts/Metadata)"
Cohesion: 0.40
Nodes (3): geistMono, geistSans, metadata

## Ambiguous Edges - Review These
- `main.go orchestrator` → `Media Pipeline (HTTPS upload)`  [AMBIGUOUS]
  voice-trigger/README.md · relation: conceptually_related_to

## Knowledge Gaps
- **121 isolated node(s):** `eslintConfig`, `nextConfig`, `name`, `version`, `private` (+116 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **20 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `main.go orchestrator` and `Media Pipeline (HTTPS upload)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `createServerSupabaseClient()` connect `Org & Device Server Actions` to `Auth Flows (Sign In/Up/Reset)`, `Sites & Devices UI`?**
  _High betweenness centrality (0.085) - this node is a cross-community bridge._
- **Why does `Server` connect `Request Routing & Middleware` to `Org & Device Server Actions`?**
  _High betweenness centrality (0.081) - this node is a cross-community bridge._
- **Why does `activateAP()` connect `WiFi Onboarding Core (Go)` to `Request Routing & Middleware`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **What connects `eslintConfig`, `nextConfig`, `name` to the rest of the system?**
  _138 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Org & Device Server Actions` be split into smaller, more focused modules?**
  _Cohesion score 0.07405063291139241 - nodes in this community are weakly interconnected._
- **Should `Sites & Devices UI` be split into smaller, more focused modules?**
  _Cohesion score 0.08748615725359911 - nodes in this community are weakly interconnected._