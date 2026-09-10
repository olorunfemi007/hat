"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { updatePassword, type AuthActionState } from "@/app/auth/actions";

const initialState: AuthActionState = { ok: false };

/**
 * Reached only via /auth/confirm's redirect after a successful
 * verifyOtp({type: "recovery"}) call, which already established a real
 * session via cookies -- by the time this page renders, the visitor is
 * authenticated (as themselves, via the one-time reset link) and
 * updatePassword() (a plain authenticated Server Action) can act on that
 * session directly. src/proxy.ts does not treat this route as public, so a
 * direct/unauthenticated visit is redirected to sign-in instead of showing
 * a form that could never work anyway.
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const [state, action, pending] = useActionState(
    updatePassword,
    initialState,
  );

  useEffect(() => {
    if (state.ok) {
      router.push("/dashboard");
    }
  }, [state, router]);

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center p-6">
      <form
        action={action}
        className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-200 p-6 dark:border-neutral-800"
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Set a new password
          </h1>
        </div>

        <div>
          <label className="block text-xs font-medium text-neutral-500">
            New password
            <input
              type="password"
              name="password"
              required
              minLength={8}
              autoComplete="new-password"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <p className="mt-1 text-xs text-neutral-500">At least 8 characters.</p>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Saving…" : "Save new password"}
        </button>

        {!state.ok && state.error && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {state.error}
          </p>
        )}
      </form>
    </div>
  );
}
