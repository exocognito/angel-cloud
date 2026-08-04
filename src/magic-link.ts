import { sha256Hex } from "@smcllns/angel-core";

/**
 * The magic-link rules from owner decision O4, kept pure so the storage layer
 * decides nothing. A link lives ten minutes on the server clock, is spendable
 * once, and is bound to the one email address that asked for it.
 */

export const MAGIC_LINK_TTL_MS = 600_000;

/** Bytes of entropy either half of a token carries. */
const SELECTOR_BYTES = 16;
const VERIFIER_BYTES = 32;

export type MagicLinkFailure = "unknown" | "mismatched" | "consumed" | "expired";

export class MagicLinkError extends Error {
  constructor(readonly failure: MagicLinkFailure) {
    super(failure);
  }
}

/**
 * What survives issuing a link. The verifier is deliberately absent: it exists
 * only in the mail we send, so a reader of our storage cannot log in.
 */
export interface MagicLinkRecord {
  emailHash: string;
  verifierHash: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface MintedMagicLink {
  /** `selector.verifier` — the only copy, and it leaves in the mail. */
  token: string;
  /** Names the record's storage, and is safe to log. */
  selector: string;
  record: MagicLinkRecord;
}

export interface MagicLinkToken {
  selector: string;
  verifier: string;
}

/**
 * Fold an address to the one form we hash and compare. Case is folded because
 * mail domains are case-insensitive; nothing else is, so `sam+angel@x` stays
 * distinct from `sam@x` — collapsing those would let one person hold another's
 * links.
 */
export function normalizeLoginEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return null;
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  if (/[\s<>",;]/.test(trimmed)) return null;
  const domain = trimmed.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;
  return trimmed.toLowerCase();
}

/**
 * Names the identity's storage. Keyed, not a bare digest: an email address is
 * dictionary-sized, so an unkeyed hash would let anyone who can list stored
 * object names — a dashboard, an export, a point-in-time restore — recover
 * exactly which addresses hold Accounts. That is the enumeration O4 forbids,
 * reached through a different door.
 */
export async function hashLoginEmail(key: string, normalizedEmail: string): Promise<string> {
  return deriveLoginName(key, "email", normalizedEmail);
}

/** Same reasoning for every other low-entropy value we name storage after. */
export async function deriveLoginName(
  key: string,
  kind: string,
  value: string,
): Promise<string> {
  // Falsy, not empty-string: an unset Worker secret arrives as undefined, and
  // TextEncoder turns that into a zero-length key that slips past `=== ""`.
  if (!key) throw new Error("LOGIN_NAME_KEY must be set");
  const mac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    mac,
    new TextEncoder().encode(`angel.login.${kind}.v1:${value}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The verifier is 256 random bits, so a bare digest is enough — there is no
 * dictionary to run against it. Same for the session token.
 */
export async function hashMagicLinkVerifier(verifier: string): Promise<string> {
  return sha256Hex(`angel.login.verifier.v1:${verifier}`);
}

export async function mintMagicLink(
  key: string,
  normalizedEmail: string,
  now: number,
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): Promise<MintedMagicLink> {
  const selector = base64Url(randomBytes(SELECTOR_BYTES));
  const verifier = base64Url(randomBytes(VERIFIER_BYTES));
  const [emailHash, verifierHash] = await Promise.all([
    hashLoginEmail(key, normalizedEmail),
    hashMagicLinkVerifier(verifier),
  ]);
  return {
    token: `${selector}.${verifier}`,
    selector,
    record: {
      emailHash,
      verifierHash,
      issuedAt: now,
      expiresAt: now + MAGIC_LINK_TTL_MS,
      consumedAt: null,
    },
  };
}

export function parseMagicLinkToken(raw: unknown): MagicLinkToken | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [selector, verifier] = parts as [string, string];
  if (!isBase64Url(selector) || !isBase64Url(verifier)) return null;
  return { selector, verifier };
}

/**
 * Decide a single spend against an already-hashed verifier. Both hashes are
 * digests, so the caller has done every variable-time step before the record
 * is read — see `LoginAttempt.consume`, where that ordering is what keeps the
 * read-modify-write atomic.
 *
 * Authenticate before reporting state: a caller holding the wrong verifier
 * learns "mismatched" whether or not the link was already spent.
 */
export function consumeMagicLink(
  record: MagicLinkRecord | undefined,
  presentedVerifierHash: string,
  now: number,
): MagicLinkRecord {
  if (record === undefined) throw new MagicLinkError("unknown");
  if (!constantTimeEqual(record.verifierHash, presentedVerifierHash)) {
    throw new MagicLinkError("mismatched");
  }
  if (record.consumedAt !== null) throw new MagicLinkError("consumed");
  // O4 sets no grace: the instant the clock reaches expiry the link is dead.
  if (now >= record.expiresAt) throw new MagicLinkError("expired");
  return { ...record, consumedAt: now };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function isBase64Url(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}
