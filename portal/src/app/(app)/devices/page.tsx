import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { canClaimDevice, canManageDevices } from "@/lib/roles";
import type { Device, Site } from "@/lib/supabase/types";
import { DeviceRow } from "./device-row";

export default async function DevicesPage() {
  const supabase = await createServerSupabaseClient();
  const { role } = await getOrgContext(supabase);
  const canManage = canManageDevices(role);

  const [devicesResult, sitesResult] = await Promise.all([
    supabase
      .from("devices")
      .select(
        "id, org_id, site_id, serial_number, status, claimed_at, claimed_by_user_id, last_seen_at, display_name, created_at",
      )
      .order("created_at", { ascending: false })
      .returns<Device[]>(),
    supabase.from("sites").select("*").returns<Site[]>(),
  ]);

  const devices = devicesResult.data ?? [];
  const sites = sitesResult.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Devices</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Devices claimed into this organization. Unclaimed inventory isn&apos;t
            listable here by design -- see the claim flow.
          </p>
        </div>
        {canClaimDevice(role) && (
          <Link
            href="/devices/claim"
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Claim a device
          </Link>
        )}
      </div>

      {devicesResult.error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to load devices: {devicesResult.error.message}
        </p>
      )}
      {sitesResult.error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to load sites (site assignment may be unavailable below): {sitesResult.error.message}
        </p>
      )}

      <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 px-4 dark:divide-neutral-800 dark:border-neutral-800">
        {devices.length > 0 ? (
          devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              sites={sites}
              canManage={canManage}
            />
          ))
        ) : (
          <li className="py-6 text-center text-sm text-neutral-500">
            No devices claimed yet.
            {canClaimDevice(role) && (
              <>
                {" "}
                <Link href="/devices/claim" className="underline">
                  Claim your first device
                </Link>
                .
              </>
            )}
          </li>
        )}
      </ul>
    </div>
  );
}
