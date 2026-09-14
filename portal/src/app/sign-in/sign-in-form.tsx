"use client";

import { Brand } from "@/components/brand";
import { useActionState } from "react";
import Link from "next/link";
import { signIn, type AuthActionState } from "@/app/auth/actions";

const initialState: AuthActionState = { ok: false };

export function SignInForm({ redirectTo }: { redirectTo: string }) {
  const [state, action, pending] = useActionState(signIn, initialState);

  return (
    <div role="main" className="auth-page">
      <form
        action={action}
        className="auth-card space-y-6"
      >
        <input type="hidden" name="redirect_to" value={redirectTo} />
        <Brand />
        <div>
          <h1 className="page-title">Welcome back.</h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Sign in to your fleet workspace.
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
              autoComplete="current-password"
              className="mt-1 w-full control px-3 py-2 text-sm"
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="button-primary w-full disabled:opacity-50"
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
