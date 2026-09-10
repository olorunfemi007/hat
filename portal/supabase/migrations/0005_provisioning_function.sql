-- 0005_provisioning_function.sql
--
-- Device provisioning: generates the two distinct secrets a physical device
-- needs before it ships (claim_code for the human claiming flow,
-- device_identity_secret for the heartbeat flow), hashes them, inserts the
-- unclaimed device rows, and returns the plaintext exactly once so it can be
-- printed on a label / flashed into the device image. Nothing after this
-- function returns ever has the plaintext again -- see seed.sql for how
-- that return value should (and shouldn't) be handled.
--
-- service_role-only: this is a manufacturing/ops tool, never part of the
-- app's public surface. It takes real serial numbers as input rather than
-- generating them, because serial numbers come from the hardware batch
-- itself (e.g. a Pi's own serial or an asset tag already printed on the
-- case) -- inventing random serials here would produce rows that don't
-- correspond to any real device.

create or replace function public.provision_devices(
  p_serial_numbers text[]
)
returns table (
  serial_number text,
  claim_code text,
  device_identity_secret text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_serial text;
  v_claim_code text;
  v_identity_secret text;
begin
  if p_serial_numbers is null or array_length(p_serial_numbers, 1) is null then
    raise exception 'p_serial_numbers must be a non-empty array' using errcode = '22004';
  end if;

  foreach v_serial in array p_serial_numbers loop
    -- 20 random bytes -> 40 lowercase hex chars (160 bits of entropy).
    -- Hex rather than base64: no '+', '/', '=' to trip up printed labels,
    -- URL query params, or someone reading a code aloud/typing it in by
    -- hand. Distinct entropy source per secret per call -- claim_code and
    -- device_identity_secret for the same device are never derived from
    -- each other or from the serial number.
    v_claim_code      := encode(extensions.gen_random_bytes(20), 'hex');
    v_identity_secret := encode(extensions.gen_random_bytes(20), 'hex');

    insert into public.devices (serial_number, claim_code_hash, device_identity_hash)
    values (
      v_serial,
      extensions.crypt(v_claim_code, extensions.gen_salt('bf', 12)),
      extensions.crypt(v_identity_secret, extensions.gen_salt('bf', 10))
    );

    serial_number := v_serial;
    claim_code := v_claim_code;
    device_identity_secret := v_identity_secret;
    return next;
  end loop;
end;
$$;

comment on function public.provision_devices(text[]) is
  'Generates+hashes claim_code and device_identity_secret for each given serial number, inserts unclaimed device rows, and returns the plaintext ONCE. Caller (an operator running this via psql/SQL editor/seed script, never the app) is responsible for capturing this output for label printing/flashing -- it cannot be recovered afterward. service_role-only.';

revoke all on function public.provision_devices(text[]) from public;
grant execute on function public.provision_devices(text[]) to service_role;
