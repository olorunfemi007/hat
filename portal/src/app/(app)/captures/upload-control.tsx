"use client";

import { useActionState } from "react";
import { setDeviceUploads } from "./actions";
import type { ActionResult } from "../sites/actions";

export function UploadControl({ deviceId, disabled }: { deviceId: string; disabled: boolean }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(async () =>
    setDeviceUploads(deviceId, disabled), { ok: true });
  return (
    <form action={action} className="space-y-2">
      <button type="submit" className={disabled ? "button-secondary" : "button-danger"} disabled={pending}>
        {pending ? "Updating…" : disabled ? "Resume uploads" : "Pause uploads"}
      </button>
      {!state.ok && state.error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{state.error}</p>}
    </form>
  );
}
