import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { canManageSites } from "@/lib/roles";
import type { Site } from "@/lib/supabase/types";
import { CreateSiteForm } from "./create-site-form";
import { SiteRow } from "./site-row";

export default async function SitesPage() {
  const supabase = await createServerSupabaseClient();
  const { role } = await getOrgContext(supabase);
  const canManage = canManageSites(role);

  const { data: sites, error } = await supabase
    .from("sites")
    .select("*")
    .order("name")
    .returns<Site[]>();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sites</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Physical locations devices can be assigned to.
        </p>
      </div>

      {canManage && <CreateSiteForm />}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to load sites: {error.message}
        </p>
      )}

      <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 px-4 dark:divide-neutral-800 dark:border-neutral-800">
        {sites && sites.length > 0 ? (
          sites.map((site) => (
            <SiteRow key={site.id} site={site} canManage={canManage} />
          ))
        ) : (
          <li className="py-6 text-center text-sm text-neutral-500">
            No sites yet.
          </li>
        )}
      </ul>
    </div>
  );
}
