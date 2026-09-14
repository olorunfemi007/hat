import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { canManageStorage } from "@/lib/roles";
import type { StorageConfig } from "@/lib/supabase/types";
import { StorageConfigForm } from "./storage-config-form";
import { StorageConfigRow } from "./storage-config-row";
import { ConnectStorageWizard } from "./connect-storage-wizard";
import { storageConnectionChoices } from "@/lib/storage-connections";
import { SiteStorageForm } from "./site-storage-form";
import type { Site } from "@/lib/supabase/types";

export default async function StoragePage() {
  const supabase = await createServerSupabaseClient();
  const { role, orgId } = await getOrgContext(supabase);

  if (!canManageStorage(role)) {
    return (
      <div className="surface p-6 text-sm text-neutral-600 dark:text-neutral-400">
        Storage configuration is only visible to org admins.
      </div>
    );
  }

  const { data: configs, error } = await supabase
    .from("storage_configs")
    .select("*")
    .order("created_at", { ascending: false })
    .returns<StorageConfig[]>();
  const { data: sites, error: sitesError } = await supabase.from("sites").select("*").order("name").returns<Site[]>();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Storage</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Connect once. Automatically deliver your fleet&apos;s captures to your company&apos;s storage.
        </p>
      </div>

      <p className="text-sm text-neutral-500">Automatic capture sync supports Amazon S3 and MinIO. A destination must pass a delivery test before it can be used.</p>
      <ConnectStorageWizard trustPrincipalArn={process.env.HARDHAT_AWS_TRUST_PRINCIPAL_ARN ?? null} />
      <StorageConfigForm connections={orgId ? storageConnectionChoices(orgId) : []} />

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to load storage configs: {error.message}
        </p>
      )}

      <ul className="divide-y divide-neutral-200 surface px-4 dark:divide-neutral-800">
        {configs && configs.length > 0 ? (
          configs.map((config) => (
            <StorageConfigRow key={config.id} config={config} />
          ))
        ) : (
          <li className="py-6 text-center text-sm text-neutral-500">
            No storage configs yet.
          </li>
        )}
      </ul>
      {!sitesError && sites && sites.length > 0 && (
        <section className="surface p-6 space-y-4">
          <div><h2>Site destinations</h2><p className="text-sm text-neutral-500 mt-1">Use the organization default, or send a site&apos;s new captures to a different tested destination. Existing uploads keep their original destination.</p></div>
          {sites.map((site) => <SiteStorageForm key={site.id} site={site} configs={configs ?? []} />)}
        </section>
      )}
      {sitesError && <p role="alert" className="text-sm text-red-600">Site destinations could not be loaded.</p>}
    </div>
  );
}
