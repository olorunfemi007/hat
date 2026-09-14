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
            className="mt-1 control px-3 py-2 text-sm"
          />
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
        <p className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </form>
  );
}
