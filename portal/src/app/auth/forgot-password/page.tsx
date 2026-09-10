"use client";

import { useActionState } from "react";
import Link from "next/link";
import { requestPasswordReset, type AuthActionState } from "@/app/auth/actions";

const initialState: AuthActionState = { ok: false };

export default function ForgotPasswordPage() {
  const [state, action, pending] = useActionState(
    requestPasswordReset,
    initialState,
  );

  if (state.ok) {
    return (
      <div className="flex min-h-screen flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          Check your email
        </h1>
        <p className="max-w-sm text-sm text-neutral-600 dark:text-neutral-400">
          If an account exists for that email, we sent a link to reset your
          password.
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
            Reset your password
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Enter your email and we&apos;ll send you a reset link.
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

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Sending…" : "Send reset link"}
        </button>

        <p className="text-center text-xs text-neutral-500">
          <Link href="/sign-in" className="underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
