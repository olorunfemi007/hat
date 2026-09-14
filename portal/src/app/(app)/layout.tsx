import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { signOut } from "@/app/auth/actions";
import { NavLinks } from "@/components/nav-links";
import { Brand } from "@/components/brand";
import { ROLE_LABELS } from "@/lib/roles";
import { OrgSwitcher } from "./org-switcher";
import type { Organization, OrganizationMember } from "@/lib/supabase/types";

/**
 * Shared shell for every authenticated, org-scoped route. `src/proxy.ts`
 * already requires sign-in for all non-public routes; this layout adds the
 * two checks that matter at the resource layer:
 *   1. Redirect to onboarding if the user has no active organization --
 *      every query below this layout assumes current_org_id() resolves.
 *   2. Surface the caller's normalized role so nav/pages can gate UI. This
 *      is UX only -- RLS is the actual enforcement (see supabase/README.md).
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createServerSupabaseClient();
  const { userId, orgId, role } = await getOrgContext(supabase);

  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/onboarding");
  }

  // organization_members_select_fellow_members (0002_rls.sql) allows a
  // caller to see any row where they're a member of that row's org_id --
  // every one of THEIR OWN rows trivially qualifies, so this returns every
  // org they belong to (not just the active one). Two queries (memberships,
  // then the orgs those point at) rather than a PostgREST embedded join --
  // this project has no generated types yet (see types.ts), and this keeps
  // the shape simple to hand-type.
  const { data: memberships } = await supabase
    .from("organization_members")
    .select("org_id, user_id, role, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .returns<OrganizationMember[]>();

  const orgIds = (memberships ?? []).map((m) => m.org_id);
  const { data: orgRows } = orgIds.length
    ? await supabase
        .from("organizations")
        .select("id, name, plan, created_at")
        .in("id", orgIds)
        .returns<Organization[]>()
    : { data: [] as Organization[] };

  const orgNameById = new Map((orgRows ?? []).map((o) => [o.id, o.name]));
  const orgs = (memberships ?? []).map((m) => ({
    id: m.org_id,
    name: orgNameById.get(m.org_id) ?? "Unnamed organization",
  }));

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <header className="workspace-header">
        <Brand />
        <div className="workspace-context">
          <span className="eyebrow">Workspace</span>
          {orgs.length > 1 ? (
            <OrgSwitcher orgs={orgs} currentOrgId={orgId} />
          ) : (
            <span className="workspace-name">
              {orgs[0]?.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {role && (
            <span className="role-badge">
              {ROLE_LABELS[role]}
            </span>
          )}
          <form action={signOut}>
            <button
              type="submit"
              className="button-secondary"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>
      <div className="workspace-body">
        <aside className="workspace-sidebar">
          <p className="sidebar-label">Manage</p>
          <NavLinks role={role} />
          <div className="sidebar-note">
            <span className="sidebar-note-line" />
            <p>Your fleet.<br />One connected workspace.</p>
            <span>Hard Hat Portal</span>
          </div>
        </aside>
        <main id="main-content" tabIndex={-1} className="workspace-main">
          <div className="page-content">{children}</div>
        </main>
      </div>
    </div>
  );
}
