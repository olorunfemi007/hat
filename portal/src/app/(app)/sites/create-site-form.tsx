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
      className="flex flex-col gap-3 surface p-4 sm:flex-row sm:items-end"
    >
      <div className="flex-1">
        <label className="block text-xs font-medium text-neutral-500">
          Site name
          <input
            name="name"
            required
            className="mt-1 w-full control px-3 py-2 text-sm"
            placeholder="North Yard"
          />
        </label>
      </div>
      <div className="flex-1">
        <label className="block text-xs font-medium text-neutral-500">
          Address (optional)
          <input
            name="address"
            className="mt-1 w-full control px-3 py-2 text-sm"
            placeholder="123 Industrial Way"
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="button-primary disabled:opacity-50"
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
