import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/",
  "/sign-in",
  "/sign-up",
  "/auth/confirm",
  "/auth/forgot-password",
  "/auth/error",
  // Deliberately NOT /auth/reset-password: a legitimate visit always
  // arrives already-authenticated (via /auth/confirm's verifyOtp
  // establishing a recovery session before redirecting here) -- requiring
  // auth is correct, not a gap, since an unauthenticated direct visit would
  // just fail on submit anyway. Making it public would only let someone see
  // a form that can't work for them.
];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * Session-refresh + route-protection layer, called from `src/proxy.ts`
 * (Next.js 16's `middleware.ts` rename). Server Components can't write
 * cookies themselves, so this is what actually keeps the Supabase Auth
 * session cookie current across requests -- without it, a session could
 * silently expire mid-visit with no refresh ever happening.
 *
 * The `setAll` callback's dance (set on `request.cookies`, rebuild
 * `NextResponse.next()`, then set on the new response's cookies too) is
 * @supabase/ssr's documented pattern for this exact spot -- it's not
 * arbitrary duplication, it's what makes the refreshed cookie visible both
 * to the Server Components rendering *this* request and to the browser on
 * the response.
 *
 * Uses `getClaims()`, not `getUser()`/`getSession()`: current Supabase
 * guidance (checked live against their docs while building this) is that
 * `getClaims()` is now the right call for protecting pages/data -- it
 * validates the JWT signature locally against the project's published
 * public keys on every call, so it's as trustworthy as `getUser()` without
 * that function's extra Auth-server round-trip. `getSession()`'s embedded
 * user object is explicitly documented as untrustworthy for authorization
 * (it's just whatever's in the client-controllable cookie, unverified).
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set -- see .env.example.",
    );
  }

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
        Object.entries(headers ?? {}).forEach(([key, value]) =>
          supabaseResponse.headers.set(key, value),
        );
      },
    },
  });

  // Do not run code between createServerClient() and getClaims() -- do not
  // remove this call or reorder it below the route-matching logic. This is
  // what actually performs the token refresh this whole function exists
  // for.
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims;

  if (!user && !isPublicRoute(request.nextUrl.pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/sign-in";
    redirectUrl.search = "";
    redirectUrl.searchParams.set("redirect_to", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}
