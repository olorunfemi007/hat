import Link from "next/link";
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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {org?.name ?? "Dashboard"}
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Overview of your organization&apos;s sites, devices, and storage.
        </p>
      </div>

      {queryErrors.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          <p className="font-medium">
            Some dashboard data failed to load. Counts below may be incomplete or wrong.
          </p>
          <ul className="mt-1 list-inside list-disc">
            {queryErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Sites" value={sitesCount} href="/sites" />
        <StatCard label="Total devices" value={devices.length} href="/devices" />
        <StatCard
          label="Active devices"
          value={statusCounts.active ?? 0}
          href="/devices"
        />
        <StatCard
          label="Offline devices"
          value={statusCounts.offline ?? 0}
          href="/devices"
        />
      </div>

      <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">Device status breakdown</h2>
        <dl className="mt-3 grid grid-cols-3 gap-4 text-sm">
          {DEVICE_STATUSES.map((status) => (
            <div key={status}>
              <dt className="capitalize text-neutral-500">{status}</dt>
              <dd className="text-lg font-semibold">
                {statusCounts[status] ?? 0}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {canSeeStorage && (
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-semibold">Storage configs</h2>
          <p className="mt-1 text-2xl font-semibold">{storageCount}</p>
        </div>
      )}

      {canClaimDevice(role) && (
        <Link
          href="/devices/claim"
          className="inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Claim a device
        </Link>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  href,
}: {
  label: string;
  value: number;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-neutral-200 p-4 transition-colors hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
    >
      <p className="text-sm text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </Link>
  );
}
