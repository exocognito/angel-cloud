import { sha256Hex } from "@smcllns/angel-core";

/**
 * What a first successful login creates: one Account, and nothing else. The
 * Account is the identity's name for itself — no Angel, no Connection, no
 * handle. Naming happens later, deliberately, so an abandoned signup leaves
 * nothing occupying the platform-wide handle space.
 */

/** How long a session outlives the link that created it. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1_000;

export interface AccountIdentity {
  accountId: string;
  createdAt: number;
}

/**
 * A session names the identity that opened it, not the Account. The Account is
 * looked up through that identity on every use, so a session can be written
 * before the Account exists — which is what lets a login that half-fails leave
 * nothing behind.
 */
export interface SessionRecord {
  emailHash: string;
  issuedAt: number;
  expiresAt: number;
}

export function mintAccountId(
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): string {
  return `acct_${hex(randomBytes(16))}`;
}

export function mintSessionToken(
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): string {
  return hex(randomBytes(32));
}

export async function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(`angel.login.session.v1:${token}`);
}

export function newSession(emailHash: string, now: number): SessionRecord {
  return { emailHash, issuedAt: now, expiresAt: now + SESSION_TTL_MS };
}

/** Same no-grace rule as the link itself: at expiry the session is over. */
export function activeSession(record: SessionRecord | undefined, now: number): SessionRecord | null {
  if (record === undefined) return null;
  return now >= record.expiresAt ? null : record;
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
