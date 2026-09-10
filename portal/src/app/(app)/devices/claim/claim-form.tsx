"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { lookupDevice, claimDevice, type LookupState, type ClaimState } from "./actions";
import type { Site, DeviceLookupResult, ClaimDeviceResult } from "@/lib/supabase/types";

const initialLookupState: LookupState = { ok: false };
const initialClaimState: ClaimState = { ok: false };

interface FoundDevice {
  serialNumber: string;
  claimCode: string;
  device: DeviceLookupResult;
}

/**
 * Two-step claim flow: SearchStep (preview via lookup_device_by_claim_code)
 * -> ConfirmStep (actually claim via claim_device). Each step is its own
 * component with its own useActionState, so "start over" can just unmount
 * SearchStep back into existence rather than trying to reset action state
 * by hand.
 */
export function ClaimForm({ sites, initialSerial, initialCode }: { sites: Site[]; initialSerial: string; initialCode: string }) {
  const router = useRouter();
  const [found, setFound] = useState<FoundDevice | null>(null);
  const [claimed, setClaimed] = useState<ClaimDeviceResult | null>(null);

  if (claimed) {
    return (
      <div className="rounded-lg border border-green-300 bg-green-50 p-6 text-center dark:border-green-900 dark:bg-green-950">
        <p className="text-lg font-semibold text-green-800 dark:text-green-300">
          Device claimed
        </p>
        <p className="mt-1 text-sm text-green-700 dark:text-green-400">
          {claimed.display_name || claimed.serial_number} is now part of your
          organization&apos;s fleet.
        </p>
        <button
          onClick={() => router.push("/devices")}
          className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          Go to devices
        </button>
      </div>
    );
  }

  if (found) {
    return (
      <ConfirmStep
        found={found}
        sites={sites}
        onRestart={() => setFound(null)}
        onClaimed={setClaimed}
      />
    );
  }

  return <SearchStep onFound={setFound} initialSerial={initialSerial} initialCode={initialCode} />;
}

function SearchStep({ onFound, initialSerial, initialCode }: { onFound: (found: FoundDevice) => void; initialSerial: string; initialCode: string }) {
  const [state, action, pending] = useActionState(
    lookupDevice,
    initialLookupState,
  );

  useEffect(() => {
    if (state.ok && state.device && state.serialNumber && state.claimCode) {
      onFound({
        serialNumber: state.serialNumber,
        claimCode: state.claimCode,
        device: state.device,
      });
    }
    // Only re-run when the action state itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      action={action}
      className="space-y-4 rounded-lg border border-neutral-200 p-6 dark:border-neutral-800"
    >
      <div>
        <label className="block text-xs font-medium text-neutral-500">
          Serial number
          <input
            name="serial_number"
            defaultValue={initialSerial}
            required
            autoComplete="off"
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-mono dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="PI-SN-4C1A9F2B"
          />
        </label>
      </div>
      <div>
        <label className="block text-xs font-medium text-neutral-500">
          Claim code
          <input
            name="claim_code"
            defaultValue={initialCode}
            required
            autoComplete="off"
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-mono dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="Printed on the device label"
          />
        </label>
      </div>
      <p className="text-xs text-neutral-500">
        Both values are printed on the physical device label.
      </p>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {pending ? "Looking up…" : "Look up device"}
      </button>
      {!state.ok && state.error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </form>
  );
}

function ConfirmStep({
  found,
  sites,
  onRestart,
  onClaimed,
}: {
  found: FoundDevice;
  sites: Site[];
  onRestart: () => void;
  onClaimed: (claimed: ClaimDeviceResult) => void;
}) {
  const [state, action, pending] = useActionState(
    claimDevice,
    initialClaimState,
  );

  useEffect(() => {
    if (state.ok && state.claimed) {
      onClaimed(state.claimed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      action={action}
      className="space-y-4 rounded-lg border border-neutral-200 p-6 dark:border-neutral-800"
    >
      <input type="hidden" name="serial_number" value={found.serialNumber} />
      <input type="hidden" name="claim_code" value={found.claimCode} />

      <div className="rounded-md bg-neutral-100 p-3 text-sm dark:bg-neutral-900">
        <p className="font-medium">Device found</p>
        <p className="font-mono text-xs text-neutral-600 dark:text-neutral-400">
          {found.device.serial_number}
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-500">
          Display name (optional)
          <input
            name="display_name"
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="Helmet #12"
          />
        </label>
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-500">
          Site (optional)
          <select
            name="site_id"
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="">Unassigned</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Claiming…" : "Confirm claim"}
        </button>
        <button
          type="button"
          onClick={onRestart}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
        >
          Start over
        </button>
      </div>

      {!state.ok && state.error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </form>
  );
}
