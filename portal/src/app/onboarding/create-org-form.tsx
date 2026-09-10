"use client";

import { useActionState } from "react";
import { createOrganization, type CreateOrgState } from "./actions";

const initialState: CreateOrgState = { ok: false };

export function CreateOrgForm() {
  const [state, action, pending] = useActionState(
    createOrganization,
    initialState,
  );

  return (
    <form
      action={action}
      className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-200 p-6 dark:border-neutral-800"
    >
      <div>
        <label className="block text-xs font-medium text-neutral-500">
          Organization name
          <input
            name="name"
            required
            autoComplete="organization"
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="Acme Construction"
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {pending ? "Creating…" : "Create organization"}
      </button>
      {!state.ok && state.error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </form>
  );
}
