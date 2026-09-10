/**
 * The 5 roles this app defines, and the permission matrix that mirrors (not
 * replaces) the RLS policies in supabase/migrations/0002_rls.sql. This
 * module is UX / defense-in-depth only -- every check here has a
 * corresponding, authoritative check in Postgres. If this file and the RLS
 * policies ever disagree, Postgres wins; treat that as a bug in this file.
 *
 * Native Supabase Auth stores this as a plain string in
 * organization_members.role -- no vendor-specific prefix to strip (unlike
 * the Clerk era, where roles carried an "org:" prefix depending on SDK
 * surface). current_org_role() (0002_rls.sql) already returns one of these
 * five exact strings, or null.
 */
export const ORG_ROLES = [
  "org_admin",
  "device_admin",
  "site_manager",
  "safety_officer",
  "viewer",
] as const;

export type OrgRole = (typeof ORG_ROLES)[number];

/** Narrows an arbitrary string (e.g. straight from current_org_role()) to OrgRole, or null if unrecognized/absent. */
export function asOrgRole(role: string | null | undefined): OrgRole | null {
  if (!role) return null;
  return (ORG_ROLES as readonly string[]).includes(role)
    ? (role as OrgRole)
    : null;
}

// ---------------------------------------------------------------------------
// Permission matrix -- mirrors 0002_rls.sql policy-by-policy.
// ---------------------------------------------------------------------------

/** sites: full CRUD for org_admin/site_manager; read-only for everyone else. */
export function canManageSites(role: OrgRole | null): boolean {
  return role === "org_admin" || role === "site_manager";
}

/** devices: display_name/site_id edits, and claiming, for org_admin/device_admin only. */
export function canManageDevices(role: OrgRole | null): boolean {
  return role === "org_admin" || role === "device_admin";
}

/** Claiming a new device requires the same role as managing devices (claim_device RPC checks this too). */
export function canClaimDevice(role: OrgRole | null): boolean {
  return canManageDevices(role);
}

/** storage_configs: org_admin only, for every operation including read. */
export function canManageStorage(role: OrgRole | null): boolean {
  return role === "org_admin";
}

/** organizations.name rename: org_admin only. */
export function canRenameOrg(role: OrgRole | null): boolean {
  return role === "org_admin";
}

/** Inviting/removing/role-changing members: org_admin only (matches invite_member()/change_member_role()/remove_member() in 0007_org_management_functions.sql). */
export function canManageMembers(role: OrgRole | null): boolean {
  return role === "org_admin";
}

export const ROLE_LABELS: Record<OrgRole, string> = {
  org_admin: "Org Admin",
  device_admin: "Device Admin",
  site_manager: "Site Manager",
  safety_officer: "Safety Officer",
  viewer: "Viewer",
};
