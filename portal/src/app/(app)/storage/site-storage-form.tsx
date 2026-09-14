"use client";

import { useActionState } from "react";
import { setSiteStorage } from "./actions";
import type { ActionResult } from "../sites/actions";
import type { Site, StorageConfig } from "@/lib/supabase/types";

export function SiteStorageForm({ site, configs }: { site: Site; configs: StorageConfig[] }) {
  const [state, action, pending] = useActionState(async (_prev: ActionResult, form: FormData) =>
    setSiteStorage(site.id, String(form.get("storage_config_id") ?? "") || null), { ok: true });
  return (
    <form action={action} className="flex flex-wrap items-end gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-700">
      <label className="min-w-0 flex-1 text-xs font-medium text-neutral-500">{site.name}
        <select key={site.storage_config_id ?? "default"} name="storage_config_id" defaultValue={site.storage_config_id ?? ""} className="control w-full mt-1">
          <option value="">Organization default</option>
          {configs.filter((c) => (c.verified_at && !c.disabled_at) || c.id === site.storage_config_id).map((c) => (
            <option key={c.id} value={c.id} disabled={Boolean(c.disabled_at) || !c.verified_at}>{c.name || c.bucket}{c.disabled_at ? " (paused)" : !c.verified_at ? " (needs test)" : ""}</option>
          ))}
        </select>
      </label>
      <button type="submit" className="button-secondary" disabled={pending}>{pending ? "Saving…" : "Save destination"}</button>
      {!state.ok && state.error && <p role="alert" className="w-full text-sm text-red-600 dark:text-red-400">{state.error}</p>}
    </form>
  );
}
