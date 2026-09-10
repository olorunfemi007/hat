"use client";

import { useActionState } from "react";
import { createSite, type ActionResult } from "./actions";

const initialState: ActionResult = { ok: true };

export function CreateSiteForm() {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionResult, formData: FormData) => createSite(formData),
    initialState,
  );

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800 sm:flex-row sm:items-end"
    >
      <div className="flex-1">
        <label className="block text-xs font-medium text-neutral-500">
          Site name
          <input
            name="name"
            required
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="North Yard"
          />
        </label>
      </div>
      <div className="flex-1">
        <label className="block text-xs font-medium text-neutral-500">
          Address (optional)
          <input
            name="address"
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="123 Industrial Way"
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {pending ? "Adding…" : "Add site"}
      </button>
      {!state.ok && state.error && (
        <p className="text-sm text-red-600 dark:text-red-400 sm:basis-full">
          {state.error}
        </p>
      )}
    </form>
  );
}
