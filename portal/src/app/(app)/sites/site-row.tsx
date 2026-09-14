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
            className="control px-2 py-1 text-sm"
          />
          <button
            type="submit"
            disabled={renamePending}
            className="button-primary"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="control px-3 py-1 text-xs"
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
              className="control px-3 py-1 text-xs"
            >
              Rename
            </button>
            <form action={deleteAction}>
              <button
                type="submit"
                disabled={deletePending}
                className="button-danger disabled:opacity-50"
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
