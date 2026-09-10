"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signIn, type AuthActionState } from "@/app/auth/actions";

const initialState: AuthActionState = { ok: false };

export function SignInForm({ redirectTo }: { redirectTo: string }) {
  const [state, action, pending] = useActionState(signIn, initialState);

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center p-6">
      <form
        action={action}
        className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-200 p-6 dark:border-neutral-800"
      >
        <input type="hidden" name="redirect_to" value={redirectTo} />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Hard Hat Portal
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-neutral-500">
            Email
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        </div>

        <div>
          <label className="block text-xs font-medium text-neutral-500">
            Password
            <input
              type="password"
              name="password"
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>

        {!state.ok && state.error && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {state.error}
          </p>
        )}

        <div className="flex justify-between text-xs text-neutral-500">
          <Link href="/sign-up" className="underline">
            Create an account
          </Link>
          <Link href="/auth/forgot-password" className="underline">
            Forgot password?
          </Link>
        </div>
      </form>
    </div>
  );
}
