import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Shared confirmation-link handler for BOTH signup confirmation and
 * password-reset (`type` distinguishes them: "email" vs "recovery") -- this
 * is Supabase's own current documented pattern (PKCE flow, token_hash +
 * verifyOtp), not something specific to either flow individually.
 *
 * IMPORTANT, easy to miss: Supabase's DEFAULT email templates do NOT point
 * here -- out of the box they link to Supabase's own hosted
 * `/auth/v1/verify` endpoint using `{{ .ConfirmationURL }}`, which delivers
 * the session via a URL fragment (`#access_token=...`) that a server-side
 * Next.js app can never see. Both the "Confirm signup" and "Reset password"
 * templates in Supabase Dashboard -> Authentication -> Email Templates MUST
 * be edited to use `{{ .TokenHash }}` and point at this route instead - see
 * the portal README's setup section for the exact template HTML. Without
 * this, confirmation/reset links will silently fail to log anyone in.
 *
 * A successful verifyOtp() call establishes a real session via cookies (the
 * server client's own `setAll`) -- the user is signed in by the time this
 * redirects.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const nextParam = searchParams.get("next");

  const redirectTo = request.nextUrl.clone();
  // Open-redirect guard: `next` is attacker-influenceable (it's a URL query
  // param on a link that gets emailed out) -- only ever follow it if it's a
  // same-origin relative path.
  redirectTo.pathname = nextParam?.startsWith("/") ? nextParam : "/dashboard";
  redirectTo.search = "";

  if (tokenHash && type) {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) {
      return NextResponse.redirect(redirectTo);
    }
  }

  const errorUrl = request.nextUrl.clone();
  errorUrl.pathname = "/auth/error";
  errorUrl.search = "";
  return NextResponse.redirect(errorUrl);
}
