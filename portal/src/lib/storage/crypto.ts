import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption for storage_connection_secrets.ciphertext -- the plaintext
 * MinIO/S3 static secret key a customer pastes into the "Connect storage"
 * form. AES-256-GCM: authenticated encryption, so a tampered or
 * wrong-key ciphertext fails loudly (decipher.final() throws) rather than
 * silently producing garbage credentials. A fresh random IV per call, never
 * reused -- GCM's security guarantee depends entirely on that.
 *
 * Key material is held OUTSIDE Postgres (env var, per 0015_storage_connections.sql's
 * own header comment) -- a database dump or read-only replica leak alone can
 * never decrypt anything stored here.
 *
 * Multiple keys are supported by design, not just one, so rotation never
 * requires a bulk re-encrypt migration: add a new id:key pair at the FRONT
 * of HARDHAT_STORAGE_ENCRYPTION_KEYS (it becomes the one used for all new
 * encryption) and leave old entries in place -- storage_connection_secrets.key_id
 * records which key encrypted each row, so old ciphertext stays decryptable
 * under its original key for as long as that entry remains in the list.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits -- the size GCM is designed for; other sizes are accepted but weaken the construction.
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256

interface KeyEntry {
  id: string;
  key: Buffer;
}

let cachedKeys: KeyEntry[] | null = null;

function loadKeys(): KeyEntry[] {
  const raw = process.env.HARDHAT_STORAGE_ENCRYPTION_KEYS;
  if (!raw) {
    throw new Error("HARDHAT_STORAGE_ENCRYPTION_KEYS must be set -- see .env.example.");
  }
  const entries = raw.split(",").map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => {
    const separator = chunk.indexOf(":");
    if (separator < 1) {
      throw new Error('HARDHAT_STORAGE_ENCRYPTION_KEYS entries must be "id:base64key", comma-separated.');
    }
    const id = chunk.slice(0, separator);
    const key = Buffer.from(chunk.slice(separator + 1), "base64");
    if (key.length !== KEY_LENGTH) {
      throw new Error(`HARDHAT_STORAGE_ENCRYPTION_KEYS key "${id}" must decode to ${KEY_LENGTH} bytes (AES-256); got ${key.length}.`);
    }
    return { id, key };
  });
  if (entries.length === 0) {
    throw new Error("HARDHAT_STORAGE_ENCRYPTION_KEYS must contain at least one id:base64key entry.");
  }
  const ids = new Set(entries.map((entry) => entry.id));
  if (ids.size !== entries.length) {
    throw new Error("HARDHAT_STORAGE_ENCRYPTION_KEYS has duplicate key ids.");
  }
  return entries;
}

function keys(): KeyEntry[] {
  if (!cachedKeys) cachedKeys = loadKeys();
  return cachedKeys;
}

export interface EncryptedSecret {
  keyId: string;
  ciphertext: string;
}

/** Encrypts under the CURRENT key (the first entry in HARDHAT_STORAGE_ENCRYPTION_KEYS). */
export function encryptStorageSecret(plaintext: string): EncryptedSecret {
  const active = keys()[0];
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, active.key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    keyId: active.id,
    ciphertext: Buffer.concat([iv, authTag, encrypted]).toString("base64"),
  };
}

/** Decrypts using whichever registered key produced this ciphertext (see storage_connection_secrets.key_id). */
export function decryptStorageSecret(keyId: string, ciphertext: string): string {
  const entry = keys().find((candidate) => candidate.id === keyId);
  if (!entry) {
    throw new Error(`No decryption key registered for key_id "${keyId}".`);
  }
  const payload = Buffer.from(ciphertext, "base64");
  if (payload.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Malformed storage secret ciphertext.");
  }
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, entry.key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
