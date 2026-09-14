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
      className="w-full max-w-sm space-y-4 surface p-6"
    >
      <div>
        <label className="block text-xs font-medium text-neutral-500">
          Organization name
          <input
            name="name"
            required
            autoComplete="organization"
            className="mt-1 w-full control px-3 py-2 text-sm"
            placeholder="Acme Construction"
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="button-primary w-full disabled:opacity-50"
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
