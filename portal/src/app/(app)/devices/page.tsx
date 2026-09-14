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
          <h1 className="page-title">Devices</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Your connected fleet. Manage devices, assignments, and availability.
          </p>
        </div>
        {canClaimDevice(role) && (
          <Link
            href="/devices/claim"
            className="button-primary"
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

      <ul className="divide-y divide-neutral-200 surface px-4 dark:divide-neutral-800">
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
