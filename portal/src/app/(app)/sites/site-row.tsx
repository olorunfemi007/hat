"use client";

import { useActionState, useState } from "react";
import { renameSite, deleteSite, type ActionResult } from "./actions";
import type { Site } from "@/lib/supabase/types";

const initialState: ActionResult = { ok: true };

export function SiteRow({
  site,
  canManage,
}: {
  site: Site;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [renameState, renameAction, renamePending] = useActionState(
    async (_prev: ActionResult, formData: FormData) => {
      const result = await renameSite(site.id, formData);
      if (result.ok) setEditing(false);
      return result;
    },
    initialState,
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    async () => deleteSite(site.id),
    initialState,
  );

  if (editing) {
    return (
      <li className="flex flex-col gap-2 py-3">
        <form action={renameAction} className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Site name"
            name="name"
            defaultValue={site.name}
            required
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            disabled={renamePending}
            className="rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded-md border border-neutral-300 px-3 py-1 text-xs dark:border-neutral-700"
          >
            Cancel
          </button>
        </form>
        {!renameState.ok && renameState.error && (
          <p className="text-xs text-red-600 dark:text-red-400">
            {renameState.error}
          </p>
        )}
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{site.name}</p>
          {site.address && (
            <p className="text-xs text-neutral-500">{site.address}</p>
          )}
        </div>
        {canManage && (
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(true)}
              className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Rename
            </button>
            <form action={deleteAction}>
              <button
                type="submit"
                disabled={deletePending}
                className="rounded-md border border-red-300 px-3 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
              >
                {deletePending ? "Deleting…" : "Delete"}
              </button>
            </form>
          </div>
        )}
      </div>
      {!deleteState.ok && deleteState.error && (
        <p className="text-xs text-red-600 dark:text-red-400">
          {deleteState.error}
        </p>
      )}
    </li>
  );
}
