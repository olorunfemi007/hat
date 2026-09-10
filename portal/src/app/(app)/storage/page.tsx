import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { canManageStorage } from "@/lib/roles";
import type { StorageConfig } from "@/lib/supabase/types";
import { StorageConfigForm } from "./storage-config-form";
import { StorageConfigRow } from "./storage-config-row";

export default async function StoragePage() {
  const supabase = await createServerSupabaseClient();
  const { role } = await getOrgContext(supabase);

  if (!canManageStorage(role)) {
    return (
      <div className="rounded-lg border border-neutral-200 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
        Storage configuration is only visible to org admins.
      </div>
    );
  }

  const { data: configs, error } = await supabase
    .from("storage_configs")
    .select("*")
    .order("created_at", { ascending: false })
    .returns<StorageConfig[]>();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Storage</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Where this organization&apos;s device data lands. Only a{" "}
          <strong>reference</strong> to a secret is stored here -- never a raw
          credential.
        </p>
      </div>

      <StorageConfigForm />

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to load storage configs: {error.message}
        </p>
      )}

      <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 px-4 dark:divide-neutral-800 dark:border-neutral-800">
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
    </div>
  );
}
