import "server-only";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import ipaddr from "ipaddr.js";
import { StorageError } from "./types";

function invalid(message: string): never { throw new StorageError("invalid_endpoint", message, 422); }

export function storageEndpointOrigin(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { return invalid("Enter a valid storage endpoint URL."); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && process.env.HARDHAT_ALLOW_INSECURE_STORAGE === "true")) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return invalid("Use an HTTPS endpoint without a path, query, or embedded credentials.");
  }
  return url.origin;
}

function approvedPrivateOrigin(origin: string): boolean {
  // Deployment-owned exception for explicitly approved self-hosted endpoints.
  // Never controlled by a form, connection row, or customer credential.
  try {
    const approved: unknown = JSON.parse(process.env.HARDHAT_STORAGE_PRIVATE_ENDPOINTS ?? "[]");
    return Array.isArray(approved) && approved.some(value => typeof value === "string" && value === origin);
  } catch { return false; }
}

async function resolvedEndpoint(endpoint: string) {
  const origin = storageEndpointOrigin(endpoint);
  const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, "");
  let records: { address: string; family: number }[];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("DNS timeout")), 5_000); }),
    ]);
  } catch { return invalid("Could not resolve the storage endpoint hostname."); }
  finally { if (timeout) clearTimeout(timeout); }
  if (!records.length) return invalid("The storage endpoint hostname did not resolve to any address.");
  for (const record of records) {
    let range: string;
    try { range = ipaddr.process(record.address).range(); }
    catch { return invalid("The storage endpoint resolved to an unrecognized address."); }
    if (range !== "unicast" && !approvedPrivateOrigin(origin)) {
      return invalid("The storage endpoint resolves to a private or reserved network address and cannot be used.");
    }
  }
  return { hostname, records };
}

export async function assertPublicEndpoint(endpoint: string): Promise<void> { await resolvedEndpoint(endpoint); }

/** Freeze the validated DNS result for this client. Actual socket creation,
 * retries and keep-alive all use these addresses, never a second DNS lookup.
 * The original URL hostname remains intact for SNI and certificate validation.
 * A fresh client resolves and validates again on the next operation. */
export async function pinnedStorageHandler(endpoint: string) {
  const { hostname, records } = await resolvedEndpoint(endpoint);
  const lookup: LookupFunction = (requested, options, callback) => {
    if (requested.replace(/^\[|\]$/g, "") !== hostname) {
      callback(new Error("Unexpected storage hostname"), "", 0); return;
    }
    const matches = records.filter(record => !options.family || record.family === options.family);
    if (!matches.length) { callback(new Error("No validated address for this address family"), "", 0); return; }
    if (options.all) callback(null, matches);
    else callback(null, matches[0].address, matches[0].family);
  };
  return new NodeHttpHandler({
    httpAgent: new HttpAgent({ keepAlive: true, lookup }),
    httpsAgent: new HttpsAgent({ keepAlive: true, lookup, rejectUnauthorized: true }),
    connectionTimeout: 5_000, requestTimeout: 30_000,
  });
}
