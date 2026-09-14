"use client";

import { Brand } from "@/components/brand";
import { useActionState } from "react";
import Link from "next/link";
import { signUp, type AuthActionState } from "@/app/auth/actions";

const initialState: AuthActionState = { ok: false };

export default function SignUpPage() {
  const [state, action, pending] = useActionState(signUp, initialState);

  if (state.ok) {
    return (
      <div role="main" className="auth-page flex-col gap-4 text-center">
        <h1 className="page-title">
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
    <div role="main" className="auth-page">
      <form
        action={action}
        className="auth-card space-y-6"
      >
        <Brand />
        <div>
          <h1 className="page-title">
            Create an account
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            A connected workspace for your team and devices.
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
              className="mt-1 w-full control px-3 py-2 text-sm"
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
              className="mt-1 w-full control px-3 py-2 text-sm"
            />
          </label>
          <p className="mt-1 text-xs text-neutral-500">At least 8 characters.</p>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="button-primary w-full disabled:opacity-50"
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
