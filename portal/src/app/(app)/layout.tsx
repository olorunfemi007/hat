import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { signOut } from "@/app/auth/actions";
import { NavLinks } from "@/components/nav-links";
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
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 sm:px-6 dark:border-neutral-800">
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
          <span className="text-sm font-semibold tracking-tight">
            Hard Hat Portal
          </span>
          {orgs.length > 1 ? (
            <OrgSwitcher orgs={orgs} currentOrgId={orgId} />
          ) : (
            <span className="min-w-0 [overflow-wrap:anywhere] text-sm text-neutral-600 dark:text-neutral-400">
              {orgs[0]?.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {role && (
            <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
              {ROLE_LABELS[role]}
            </span>
          )}
          <form action={signOut}>
            <button
              type="submit"
              className="text-sm text-neutral-600 underline dark:text-neutral-400"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>
      <div className="flex min-w-0 flex-1 flex-col md:flex-row">
        <aside className="w-full shrink-0 border-b border-neutral-200 p-3 md:w-56 md:border-r md:border-b-0 md:p-4 dark:border-neutral-800">
          <NavLinks role={role} />
        </aside>
        <main className="min-w-0 flex-1 p-4 [overflow-wrap:anywhere] sm:p-6">{children}</main>
      </div>
    </div>
  );
}
