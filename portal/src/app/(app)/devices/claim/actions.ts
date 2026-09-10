"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/org-context";
import { canClaimDevice } from "@/lib/roles";
import type { DeviceLookupResult, ClaimDeviceResult } from "@/lib/supabase/types";

const GENERIC_CLAIM_FAILURE =
  "No matching unclaimed device found for that serial number and claim code. Double-check the physical label and try again.";

const GENERIC_UNEXPECTED_FAILURE =
  "Something went wrong claiming this device. Try again.";

// SQLSTATEs claim_device() deliberately raises for (0003_claim_function.sql):
// 28000 = no active org, 42501 = insufficient role / site not in your org,
// 22004 = missing required param. These are safe to show verbatim - they're
// caller/programming errors, not part of the anti-enumeration surface (they
// never touch device_auth_failures). Anything else (a malformed site_id
// UUID failing at parameter-binding with 22P02, a deadlock from the
// function's own `for update` row lock, connection/pool issues, etc.) is
// NOT one of those intentional raises and must not be shown verbatim -
// unlike lookupDevice's single RPC-error branch above, claimDevice can't
// just wrap every error the same way, because these three codes' messages
// genuinely are meant to reach the user.
const EXPECTED_CLAIM_ERROR_CODES = new Set(["28000", "42501", "22004"]);

export interface LookupState {
  ok: boolean;
  error?: string;
  device?: DeviceLookupResult;
  serialNumber?: string;
  claimCode?: string;
}

/**
 * Preview step: calls lookup_device_by_claim_code(). Per the RPC contract
 * (supabase/README.md, "Anti-enumeration hardening"), a non-match --
 * whether the serial doesn't exist, the code is wrong, the device is
 * already claimed, or the per-serial throttle has tripped -- comes back as
 * an EMPTY RESULT SET, never a thrown error and never a distinguishable
 * reason. This function checks for zero rows, not a caught exception, and
 * deliberately shows exactly one generic message for all of those cases --
 * do not try to guess or split this into more specific messages, that
 * would reintroduce the enumeration signal the backend was built to avoid.
 */
export async function lookupDevice(
  _prev: LookupState,
  formData: FormData,
): Promise<LookupState> {
  const supabase = await createServerSupabaseClient();
  const { orgId, role } = await getOrgContext(supabase);
  if (!orgId) return { ok: false, error: "No active organization." };
  if (!canClaimDevice(role)) {
    return {
      ok: false,
      error: "You don't have permission to claim devices.",
    };
  }

  const serialNumber = String(formData.get("serial_number") ?? "").trim();
  const claimCode = String(formData.get("claim_code") ?? "").trim();

  if (!serialNumber || !claimCode) {
    return { ok: false, error: "Serial number and claim code are required." };
  }

  const { data, error } = await supabase.rpc("lookup_device_by_claim_code", {
    p_serial_number: serialNumber,
    p_claim_code: claimCode,
  });

  if (error) {
    return {
      ok: false,
      error: "Something went wrong looking up this device. Try again.",
    };
  }

  const rows = (data ?? []) as DeviceLookupResult[];
  if (rows.length === 0) {
    return { ok: false, error: GENERIC_CLAIM_FAILURE };
  }

  return { ok: true, device: rows[0], serialNumber, claimCode };
}

export interface ClaimState {
  ok: boolean;
  error?: string;
  claimed?: ClaimDeviceResult;
}

/**
 * Confirm step: calls claim_device(). Same empty-result-set-means-failure
 * contract as lookupDevice above -- a failed claim (wrong code, already
 * claimed by someone else in the moment between preview and confirm,
 * throttled) is zero rows, not an exception, and gets the same generic
 * message. claim_device() DOES still raise for genuine caller/programming
 * errors (no active org, insufficient role, a site_id that isn't in your
 * org) since those never touch the anti-enumeration audit log -- those are
 * surfaced directly since they're not part of the enumeration surface.
 */
export async function claimDevice(
  _prev: ClaimState,
  formData: FormData,
): Promise<ClaimState> {
  const supabase = await createServerSupabaseClient();
  const { orgId, role } = await getOrgContext(supabase);
  if (!orgId) return { ok: false, error: "No active organization." };
  if (!canClaimDevice(role)) {
    return {
      ok: false,
      error: "You don't have permission to claim devices.",
    };
  }

  const serialNumber = String(formData.get("serial_number") ?? "").trim();
  const claimCode = String(formData.get("claim_code") ?? "").trim();
  const siteId = String(formData.get("site_id") ?? "");
  const displayName = String(formData.get("display_name") ?? "").trim();

  if (!serialNumber || !claimCode) {
    return { ok: false, error: "Serial number and claim code are required." };
  }

  const { data, error } = await supabase.rpc("claim_device", {
    p_serial_number: serialNumber,
    p_claim_code: claimCode,
    p_site_id: siteId || null,
    p_display_name: displayName || null,
  });

  if (error) {
    return {
      ok: false,
      error: EXPECTED_CLAIM_ERROR_CODES.has(error.code ?? "")
        ? error.message
        : GENERIC_UNEXPECTED_FAILURE,
    };
  }

  const rows = (data ?? []) as ClaimDeviceResult[];
  if (rows.length === 0) {
    return { ok: false, error: GENERIC_CLAIM_FAILURE };
  }

  revalidatePath("/devices");
  return { ok: true, claimed: rows[0] };
}
