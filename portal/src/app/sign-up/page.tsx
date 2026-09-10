"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signUp, type AuthActionState } from "@/app/auth/actions";

const initialState: AuthActionState = { ok: false };

export default function SignUpPage() {
  const [state, action, pending] = useActionState(signUp, initialState);

  if (state.ok) {
    return (
      <div className="flex min-h-screen flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          Check your email
        </h1>
        <p className="max-w-sm text-sm text-neutral-600 dark:text-neutral-400">
          We sent a confirmation link. Click it to activate your account,
          then come back and sign in.
        </p>
        <Link href="/sign-in" className="text-sm underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center p-6">
      <form
        action={action}
        className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-200 p-6 dark:border-neutral-800"
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Create an account
          </h1>
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
          {pending ? "Creating account…" : "Create account"}
        </button>

        {!state.ok && state.error && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {state.error}
          </p>
        )}

        <p className="text-center text-xs text-neutral-500">
          Already have an account?{" "}
          <Link href="/sign-in" className="underline">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
