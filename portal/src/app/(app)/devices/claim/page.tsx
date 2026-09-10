import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { canClaimDevice } from "@/lib/roles";
import type { Site } from "@/lib/supabase/types";
import { ClaimForm } from "./claim-form";

export default async function ClaimDevicePage({ searchParams }: {
  searchParams: Promise<{ serial_number?: string | string[]; claim_code?: string | string[] }>;
}) {
  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  const { role } = await getOrgContext(supabase);

  if (!canClaimDevice(role)) {
    return (
      <div className="rounded-lg border border-neutral-200 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
        Only org admins and device admins can claim devices. Ask one of them
        to claim this device, or to grant you the device_admin role.
      </div>
    );
  }

  const { data: sites, error: sitesError } = await supabase
    .from("sites")
    .select("*")
    .order("name")
    .returns<Site[]>();

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Claim a device
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Enter the serial number and claim code printed on the device
          label.
        </p>
      </div>
      {sitesError && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to load sites (you can still claim without assigning a site): {sitesError.message}
        </p>
      )}
      <ClaimForm sites={sites ?? []}
        initialSerial={typeof query.serial_number === "string" ? query.serial_number : ""}
        initialCode={typeof query.claim_code === "string" ? query.claim_code : ""}
      />
    </div>
  );
}
