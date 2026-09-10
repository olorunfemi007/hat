"use client";

import { useActionState } from "react";
import { renamePortalOrgName } from "./actions";
import type { ActionResult } from "../sites/actions";

const initialState: ActionResult = { ok: true };

export function RenameOrgForm({ currentName }: { currentName: string }) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionResult, formData: FormData) =>
      renamePortalOrgName(formData),
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <div>
        <label className="block text-xs font-medium text-neutral-500">
          Portal display name
          <input
            name="name"
            defaultValue={currentName}
            required
            className="mt-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {pending ? "Saving…" : "Save"}
      </button>
      {!state.ok && state.error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </form>
  );
}
