import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { canManageStorage } from "@/lib/roles";
import type { StorageConfig } from "@/lib/supabase/types";
import { StorageConfigForm } from "./storage-config-form";
import { StorageConfigRow } from "./storage-config-row";
import { ConnectStorageWizard } from "./connect-storage-wizard";
import { storageConnectionChoices } from "@/lib/storage-connections";
import { StorageConnectionCard } from "./storage-connection-card";
import { CONNECTION_FIELDS, type StorageConnection, type StorageConnectionEvent } from "@/lib/storage/connection-types";
import { SiteStorageForm } from "./site-storage-form";
import type { Site } from "@/lib/supabase/types";

// AWS trust verification includes three bounded STS requests before the probe.
export const maxDuration = 120;

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

  const [{ data: connections, error: connectionError }, { data: events, error: eventsError }] = await Promise.all([
    supabase.from("storage_connections").select(CONNECTION_FIELDS).order("created_at", { ascending: false }).returns<StorageConnection[]>(),
    supabase.from("storage_connection_events").select("id,connection_id,actor_id,event,created_at").order("created_at", { ascending: false }).limit(100).returns<StorageConnectionEvent[]>(),
  ]);
  const legacyAccounts = orgId ? storageConnectionChoices(orgId) : [];
  const trustPrincipalArn = process.env.HARDHAT_AWS_TRUST_PRINCIPAL_ARN ?? null;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Storage</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Connect once. Automatically deliver your fleet&apos;s captures to your company&apos;s storage.
        </p>
      </div>

      <p className="text-sm text-neutral-500">Automatic capture sync supports Amazon S3 and MinIO. A destination must pass a delivery test before it can be used.</p>
      <ConnectStorageWizard trustPrincipalArn={trustPrincipalArn} />
      {connectionError && <p role="alert" className="text-sm text-red-600">Storage accounts could not be loaded. Try refreshing the page.</p>}
      {connections && connections.some(c => c.status !== "cancelled") && <section className="space-y-3">
        <h2>Storage accounts</h2>
        <ul className="space-y-3">{connections.filter(c => c.status !== "cancelled").map(connection =>
          <StorageConnectionCard key={`${connection.id}:${connection.revision}`} connection={connection}
            events={(events ?? []).filter(event => event.connection_id === connection.id)} trustPrincipalArn={trustPrincipalArn} />
        )}</ul>
      </section>}
      {eventsError && <p role="alert" className="text-sm text-red-600">Connection history could not be loaded.</p>}
      {legacyAccounts.length > 0 && <StorageConfigForm connections={legacyAccounts} />}
      <h2>Delivery destinations</h2>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to load storage configs: {error.message}
        </p>
      )}

      <ul className="divide-y divide-neutral-200 surface px-4 dark:divide-neutral-800">
        {configs && configs.length > 0 ? (
          configs.map((config) => (
            <StorageConfigRow key={config.id} config={config} connectionStatus={connections?.find(c => c.config_id === config.id)?.status} />
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
