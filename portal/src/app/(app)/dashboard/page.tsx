import Link from "next/link";
import { Icon, type IconName } from "@/components/icon";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { canClaimDevice, canManageStorage } from "@/lib/roles";
import type { Organization, DeviceStatus } from "@/lib/supabase/types";

const DEVICE_STATUSES: DeviceStatus[] = ["claimed", "active", "offline"];

export default async function DashboardPage() {
  const supabase = await createServerSupabaseClient();
  const { orgId, role } = await getOrgContext(supabase);

  const canSeeStorage = canManageStorage(role);

  // organizations_select_member (0002_rls.sql) returns EVERY org the caller
  // is a member of, not just the active one -- a bare `select('*')` would
  // throw for any multi-org user under `.maybeSingle()`. Filtering to
  // orgId explicitly is required, not just tidy.
  const [orgResult, sitesResult, devicesResult, storageResult] =
    await Promise.all([
      orgId
        ? supabase
            .from("organizations")
            .select("*")
            .eq("id", orgId)
            .maybeSingle<Organization>()
        : Promise.resolve({ data: null, error: null }),
      supabase.from("sites").select("id", { count: "exact", head: true }),
      supabase.from("devices").select("id, status"),
      // storage_configs RLS restricts SELECT to org_admin -- for any other
      // role this legitimately (and silently, per RLS semantics) returns
      // zero rows rather than an error, so we gate the query itself on role
      // rather than trying to distinguish "zero configs" from "no access"
      // from the response.
      canSeeStorage
        ? supabase.from("storage_configs").select("id", { count: "exact", head: true })
        : Promise.resolve({ count: null, error: null }),
    ]);

  const org = orgResult.data;
  const sitesCount = sitesResult.count ?? 0;
  const devices = devicesResult.data ?? [];
  const storageCount = storageResult.count ?? 0;

  // Surface query failures explicitly instead of silently falling back to
  // `?? 0` / `?? []`, which would otherwise render a genuine backend
  // failure (e.g. Supabase Auth misconfigured, a transient outage) as an
  // indistinguishable, falsely reassuring "0 sites, 0 devices, 0 offline" -
  // the one place on this dashboard that actually matters most to get
  // right, since it's the fleet-status overview.
  const queryErrors = [
    orgResult.error && `organization: ${orgResult.error.message}`,
    sitesResult.error && `sites: ${sitesResult.error.message}`,
    devicesResult.error && `devices: ${devicesResult.error.message}`,
    storageResult.error && `storage: ${storageResult.error.message}`,
  ].filter((e): e is string => Boolean(e));

  const statusCounts = DEVICE_STATUSES.reduce<Record<string, number>>(
    (acc, status) => {
      acc[status] = devices.filter((d) => d.status === status).length;
      return acc;
    },
    {},
  );

  const activePercent = devices.length
    ? ((statusCounts.active ?? 0) / devices.length) * 100 : 0;
  const claimedEnd = activePercent + (devices.length
    ? ((statusCounts.claimed ?? 0) / devices.length) * 100 : 0);
  const ringBackground = devices.length
    ? `conic-gradient(var(--green) 0% ${activePercent}%, var(--amber) ${activePercent}% ${claimedEnd}%, var(--red) ${claimedEnd}% 100%)`
    : "var(--surface-muted)";
  const statusColors: Record<string, string> = {
    active: "var(--green)", claimed: "var(--amber)", offline: "var(--red)",
  };

  return (
    <div className="space-y-8">
      <div className="dashboard-heading">
        <div>
          <p className="eyebrow">Fleet overview</p>
          <h1 className="page-title">{org?.name ?? "Dashboard"}</h1>
          <p className="text-sm text-neutral-500">Your people, places, and devices. All together.</p>
        </div>
        {canClaimDevice(role) && (
          <Link href="/devices/claim" className="button-primary"><Icon name="plus" />Claim a device</Link>
        )}
      </div>

      {queryErrors.length > 0 && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          <p className="font-medium">Some dashboard data failed to load. Counts below may be incomplete or wrong.</p>
          <ul className="mt-1 list-inside list-disc">
            {queryErrors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        </div>
      )}

      <div className="overview-grid">
        <StatCard label="Sites" value={sitesCount} href="/sites" icon="sites" />
        <StatCard label="Total devices" value={devices.length} href="/devices" icon="devices" />
        <StatCard label="Active devices" value={statusCounts.active ?? 0} href="/devices" icon="activity" color="var(--green)" />
        <StatCard label="Offline devices" value={statusCounts.offline ?? 0} href="/devices" icon="offline" color="var(--red)" />
      </div>

      <div className="dashboard-lower">
        <section className="surface fleet-panel" aria-labelledby="fleet-title">
          <div className="section-heading">
            <h2 id="fleet-title">Device status breakdown</h2>
            <Link href="/devices">View devices <Icon name="arrow" /></Link>
          </div>
          <p className="section-description">A snapshot of your connected fleet.</p>
          <div className="fleet-summary">
            <div className="fleet-ring" aria-hidden="true" style={{ background: ringBackground }}>
              <div className="fleet-ring-center"><strong>{devices.length}</strong><span>Total devices</span></div>
            </div>
            <dl className="fleet-legend">
              {DEVICE_STATUSES.map((status) => (
                <div key={status}>
                  <dt><span className="status-dot" style={{ color: statusColors[status] }} />{status}</dt>
                  <dd>{statusCounts[status] ?? 0}</dd>
                </div>
              ))}
            </dl>
          </div>
          {devices.length === 0 && <p className="section-description mt-6">Your fleet overview will appear as devices are claimed.</p>}
        </section>
        <section className="surface workspace-panel" aria-labelledby="workspace-title">
          <h2 id="workspace-title">Your workspace</h2>
          <p className="section-description">Everything your fleet needs, in one place.</p>
          <Link className="workspace-shortcut" href="/sites">
            <Icon name="sites" /><div><strong>Sites</strong><span>{sitesCount} {sitesCount === 1 ? "location" : "locations"} in your organization</span></div><Icon name="arrow" />
          </Link>
          {canSeeStorage && (
            <Link className="workspace-shortcut" href="/storage">
              <Icon name="storage" /><div><strong>Storage configs</strong><span>{storageCount} {storageCount === 1 ? "destination" : "destinations"} configured</span></div><Icon name="arrow" />
            </Link>
          )}
          <Link className="workspace-shortcut" href="/org">
            <Icon name="organization" /><div><strong>Organization</strong><span>Members, roles, and invitations</span></div><Icon name="arrow" />
          </Link>
        </section>
      </div>
      <p className="dashboard-footer">Device availability reflects the latest reported heartbeat.</p>
    </div>
  );
}

function StatCard({ label, value, href, icon, color }: {
  label: string; value: number; href: string; icon: IconName; color?: string;
}) {
  return (
    <Link href={href} className="surface stat-card">
      <span className="stat-icon" style={{ color }}><Icon name={icon} /></span>
      <Icon name="arrow" className="stat-arrow" />
      <p className="stat-label">{label}</p>
      <span className="stat-value">{value}</span>
    </Link>
  );
}
