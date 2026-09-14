import "server-only";

import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { StorageError } from "./types";

/**
 * Resolves a customer-supplied MinIO endpoint hostname and rejects it if any
 * resolved address is loopback/private/link-local/reserved/etc -- without
 * this, "Connect storage" would happily let an org_admin (or an attacker who
 * has compromised one) point capture uploads at an internal service (a
 * cloud metadata endpoint, an admin panel on the operator's own network)
 * and read back whatever error/response that produces through the
 * connection-test flow, a classic SSRF oracle.
 *
 * ipaddr.js's `process()` (not `parse()`) is what specifically matters here:
 * it normalizes an IPv4-mapped IPv6 literal (e.g. "::ffff:127.0.0.1") to
 * plain IPv4 before range-checking, closing the bypass a bare IPv6 parse
 * would miss.
 *
 * This validates at connection setup/test time, immediately before the real
 * test request -- it does not pin DNS for the ongoing, already-configured
 * upload path (lib/storage/index.ts's clientFor()), so a connection whose
 * hostname's DNS changes after being connected is a known, accepted gap,
 * not a rigor this pass claims. The setup-time window between this check
 * and the one real request that follows it is on the order of
 * milliseconds, not the "configured once, resolved fresh on every upload
 * for months" exposure a bare validate-then-never-recheck design would
 * have.
 */
export async function assertPublicEndpoint(endpoint: string): Promise<void> {
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    throw new StorageError("invalid_endpoint", "The storage endpoint is not a valid URL.", 422);
  }

  let records: { address: string }[];
  try {
    records = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new StorageError("invalid_endpoint", "Could not resolve the storage endpoint hostname.", 422);
  }
  if (records.length === 0) {
    throw new StorageError("invalid_endpoint", "The storage endpoint hostname did not resolve to any address.", 422);
  }

  for (const { address } of records) {
    let range: string;
    try {
      range = ipaddr.process(address).range();
    } catch {
      throw new StorageError("invalid_endpoint", "The storage endpoint resolved to an unrecognized address.", 422);
    }
    if (range !== "unicast") {
      throw new StorageError(
        "invalid_endpoint",
        "The storage endpoint resolves to a private or reserved network address and cannot be used.",
        422,
      );
    }
  }
}
