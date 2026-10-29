import { createHash, timingSafeEqual } from "node:crypto";

export interface HttpBearerCredential {
  id: string;
  /** High-entropy opaque bearer value. It is never returned from this module. */
  token: string;
  /** Unix time in milliseconds. Expired credentials are retained but never accepted. */
  expiresAt: number;
}

interface CredentialRecord {
  readonly id: string;
  readonly digest: Buffer;
  readonly expiresAt: number;
  revoked: boolean;
}

export interface BearerCredentialStore {
  /** Checks every configured digest with a timing-safe comparison. */
  authenticate(token: string, nowMilliseconds: number): boolean;
  /** Atomically replaces the accepted set; pass old and new values for overlap. */
  replaceCredentials(credentials: readonly HttpBearerCredential[]): void;
  /** Revocation takes effect for the next request without restarting the server. */
  revoke(id: string): boolean;
}

const MAX_CREDENTIALS = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,512}$/u;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Creates a single-owner credential store with no environment-variable lookup.
 * Credential material is reduced to SHA-256 digests immediately and is never
 * exposed by the returned API. Rotation can preserve a short overlap by
 * replacing the set with both the old and new entries, then replacing it again.
 */
export function createBearerCredentialStore(
  initialCredentials: readonly HttpBearerCredential[],
): BearerCredentialStore {
  let records = validateCredentials(initialCredentials);

  return Object.freeze({
    authenticate(token: string, nowMilliseconds: number): boolean {
      if (typeof token !== "string" || !TOKEN_PATTERN.test(token) || !Number.isFinite(nowMilliseconds)) {
        // Still do a fixed-size comparison when records exist, avoiding a
        // different fast path for malformed attacker-controlled token text.
        const candidate = digestToken(typeof token === "string" ? token.slice(0, 512) : "");
        let matched = false;
        for (const record of records) matched = timingSafeEqual(record.digest, candidate) || matched;
        void matched;
        return false;
      }

      const candidate = digestToken(token);
      let accepted = false;
      for (const record of records) {
        const equal = timingSafeEqual(record.digest, candidate);
        accepted = (equal && !record.revoked && record.expiresAt > nowMilliseconds) || accepted;
      }
      return accepted;
    },
    replaceCredentials(credentials: readonly HttpBearerCredential[]): void {
      // Validate the complete replacement before making it visible.
      records = validateCredentials(credentials);
    },
    revoke(id: string): boolean {
      let found = false;
      for (const record of records) {
        if (record.id === id) {
          record.revoked = true;
          found = true;
        }
      }
      return found;
    },
  });
}

function validateCredentials(credentials: readonly HttpBearerCredential[]): CredentialRecord[] {
  if (!Array.isArray(credentials) || credentials.length < 1 || credentials.length > MAX_CREDENTIALS) {
    throw new RangeError(`credentials must contain between 1 and ${MAX_CREDENTIALS} entries`);
  }

  const ids = new Set<string>();
  const records: CredentialRecord[] = [];
  for (const input of credentials) {
    if (!input || typeof input !== "object" || typeof input.id !== "string" || !ID_PATTERN.test(input.id)) {
      throw new TypeError("credential id must be a short opaque identifier");
    }
    if (ids.has(input.id)) throw new TypeError("credential ids must be unique");
    if (typeof input.token !== "string" || !TOKEN_PATTERN.test(input.token)) {
      throw new TypeError("bearer credentials must be 32 to 512 URL-safe characters");
    }
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) {
      throw new TypeError("credential expiresAt must be a positive Unix time in milliseconds");
    }
    const digest = digestToken(input.token);
    for (const existing of records) {
      if (timingSafeEqual(existing.digest, digest)) throw new TypeError("bearer credential values must be unique");
    }
    ids.add(input.id);
    records.push({ id: input.id, digest, expiresAt: input.expiresAt, revoked: false });
  }
  return records;
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
