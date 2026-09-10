import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { canRenameOrg, canManageMembers } from "@/lib/roles";
import type { Organization, MemberWithEmail, OrganizationInvite } from "@/lib/supabase/types";
import { RenameOrgForm } from "./rename-org-form";
import { MemberList } from "./member-list";
import { InviteForm } from "./invite-form";
import { PendingInvites } from "./pending-invites";

/**
 * Member/role management, hand-built against the RPC surface documented in
 * supabase/README.md's "Tenancy functions" section -- there's no Clerk
 * <OrganizationProfile/> to lean on any more (see 0001_schema.sql's
 * header on why Clerk was dropped).
 */
export default async function OrgSettingsPage() {
  const supabase = await createServerSupabaseClient();
  const { orgId, role, userId } = await getOrgContext(supabase);

  if (!orgId) {
    return (
      <div className="rounded-lg border border-neutral-200 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
        No active organization.
      </div>
    );
  }

  const canManage = canManageMembers(role);

  const [orgResult, membersResult, invitesResult] = await Promise.all([
    canRenameOrg(role)
      ? supabase
          .from("organizations")
          .select("*")
          .eq("id", orgId)
          .maybeSingle<Organization>()
      : Promise.resolve({ data: null, error: null }),
    supabase.rpc("list_org_members", { p_org_id: orgId }),
    canManage
      ? supabase
          .from("organization_invites")
          .select("*")
          .eq("org_id", orgId)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .order("created_at", { ascending: false })
          .returns<OrganizationInvite[]>()
      : Promise.resolve({ data: [], error: null }),
  ]);

  const members = (membersResult.data ?? []) as MemberWithEmail[];
  const invites = invitesResult.data ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Organization
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Members, roles, and invitations. Role changes take effect on each
          member&apos;s next request -- Postgres RLS reads their role live
          from organization_members, not a cached session claim.
        </p>
      </div>

      {canRenameOrg(role) && orgResult.data && (
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-semibold">Organization name</h2>
          <div className="mt-3">
            <RenameOrgForm currentName={orgResult.data.name} />
          </div>
        </div>
      )}

      {membersResult.error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to load members: {membersResult.error.message}
        </p>
      )}

      <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">
          Members ({members.length})
        </h2>
        <div className="mt-3">
          <MemberList
            members={members}
            canManage={canManage}
            currentUserId={userId}
          />
        </div>
      </div>

      {canManage && (
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-semibold">Invite a member</h2>
          <div className="mt-3">
            <InviteForm />
          </div>
        </div>
      )}

      {canManage && (
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-semibold">
            Pending invites ({invites.length})
          </h2>
          {invitesResult.error && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">
              Failed to load invites: {invitesResult.error.message}
            </p>
          )}
          <div className="mt-3">
            <PendingInvites invites={invites} />
          </div>
        </div>
      )}
    </div>
  );
}
