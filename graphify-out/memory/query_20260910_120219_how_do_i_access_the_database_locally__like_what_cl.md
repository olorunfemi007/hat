---
type: "query"
date: "2026-09-10T12:02:19.111983+00:00"
question: "how do i access the database locally. like what client do i use and where do i find the database connection"
contributor: "graphify"
source_nodes: ["Server Supabase client (server.ts)", "Browser Supabase client (client.ts)", "Admin Supabase client (admin.ts)", "supabase/ directory (schema, RLS, tenancy)"]
---

# Q: how do i access the database locally. like what client do i use and where do i find the database connection

## Answer

Expanded from original query via vocab: [supabase, postgres, local, client, connection, browser, server, admin, env, config, docker, url]. Then traversed BFS and explain on Supabase client nodes; graph was thin on setup steps so the cited source files were read directly. Two local Postgres paths exist: (1) Supabase CLI local stack, configured in portal/supabase/config.toml - Postgres on port 54322, Supabase Studio (DB browser UI) on port 54323, API on port 54321, started with supabase start from the portal directory. (2) A separate Docker-only postgres:16 container used only by the RLS test suite (portal/supabase/local-test/run_tests.sh), started with docker run, not used by the running app. The running app never connects with a raw Postgres client - it goes through three Supabase JS client wrappers in portal/src/lib/supabase/: client.ts (browser client), server.ts (createServerSupabaseClient, the most-connected node in the graph with 49 edges), and admin.ts (service-role client, used only for invites). All three read connection info from portal/.env.local (already present in this checkout with NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SITE_URL as keys), templated by portal/.env.example, documented in portal/README.md First-time setup steps 1 and 6. For direct SQL access, the README files point at psql against the same connection string, or the Supabase Studio SQL editor.

## Source Nodes

- Server Supabase client (server.ts)
- Browser Supabase client (client.ts)
- Admin Supabase client (admin.ts)
- supabase/ directory (schema, RLS, tenancy)