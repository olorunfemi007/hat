"use client";

import { useActionState, useState } from "react";
import { updateDevice } from "./actions";
import type { ActionResult } from "../sites/actions";
import type { Device, Site } from "@/lib/supabase/types";
import { StatusBadge } from "@/components/status-badge";

const initialState: ActionResult = { ok: true };

export function DeviceRow({
  device,
  sites,
  canManage,
}: {
  device: Device;
  sites: Site[];
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionResult, formData: FormData) => {
      const result = await updateDevice(device.id, formData);
      if (result.ok) setEditing(false);
      return result;
    },
    initialState,
  );

  const site = sites.find((s) => s.id === device.site_id);

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            {device.display_name || device.serial_number}
          </p>
          <p className="text-xs text-neutral-500">
            {device.serial_number}
            {site ? ` · ${site.name}` : ""}
            {device.last_seen_at
              ? ` · last seen ${new Date(device.last_seen_at).toLocaleString()}`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={device.status} />
          {canManage && (
            <button
              onClick={() => setEditing((v) => !v)}
              className="control px-3 py-1 text-xs"
            >
              {editing ? "Cancel" : "Edit"}
            </button>
          )}
        </div>
      </div>

      {editing && (
        <form
          action={formAction}
          className="flex flex-wrap items-end gap-2 rounded-md bg-neutral-50 p-3 dark:bg-neutral-900"
        >
          <div>
            <label className="block text-xs font-medium text-neutral-500">
              Display name
              <input
                name="display_name"
                defaultValue={device.display_name ?? ""}
                className="mt-1 control px-2 py-1 text-sm"
              />
            </label>
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-500">
              Site
              <select
                name="site_id"
                defaultValue={device.site_id ?? ""}
                className="mt-1 control px-2 py-1 text-sm"
              >
                <option value="">Unassigned</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="submit"
            disabled={pending}
            className="button-primary disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
          {!state.ok && state.error && (
            <p className="w-full text-xs text-red-600 dark:text-red-400">
              {state.error}
            </p>
          )}
        </form>
      )}
    </li>
  );
}
