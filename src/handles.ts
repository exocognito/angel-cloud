/**
 * Account handles: the public name in the PD 0001 coordinate
 * `@<account>/<angel>[@<suffix>]`, governed by PD 0004 — permanent,
 * renameable once, never released.
 *
 * The opaque `acct_*` identifier stays the internal key. The underscore in
 * that shape is outside the handle grammar, so the two namespaces can never
 * collide and a request-path segment is unambiguous: handle-shaped means
 * handle, anything else means internal id.
 */

/** PD 0001 account-segment grammar, before platform policy. */
export const ACCOUNT_HANDLE_GRAMMAR = /^[a-z][a-z0-9-]*$/;

/** Issue #12 asks for a length cap the grammar lacks; 32 is the ceiling. */
export const ACCOUNT_HANDLE_MAX_LENGTH = 32;

/** A claimable handle: the grammar, PD 0004's four-character floor, the cap. */
export const ACCOUNT_HANDLE_PATTERN = /^[a-z][a-z0-9-]{3,31}$/;

/**
 * The internal identifier shape. Its `_` is outside the handle grammar, so
 * this test and ACCOUNT_HANDLE_GRAMMAR can never both accept one string —
 * request-path segments stay unambiguous by shape.
 */
export function isInternalAccountId(id: string): boolean {
  return id.startsWith("acct_");
}

/**
 * Authority words, reserved against impersonation — `@support/password-reset`
 * reads as platform-issued precisely because the sigil marks an Account.
 * Product paths (`pricing`, `docs`, `blog`) are NOT here: `@pricing` and
 * `/pricing` are different paths by construction of the sigil.
 */
export const RESERVED_ACCOUNT_HANDLES: ReadonlySet<string> = new Set([
  "admin",
  "support",
  "help",
  "security",
  "official",
  "staff",
  "team",
  "billing",
  "angel",
  "angels",
  "angelmcp",
  "system",
  "root",
  "api",
]);

/**
 * Name of the singleton AccountRegistry instance holding the authoritative
 * handle directory. `acct_*` internal ids can never collide with it.
 */
export const HANDLE_DIRECTORY_REGISTRY = "handle-directory";

export type HandleClassification =
  | { ok: true }
  | { ok: false; kind: "invalid" | "reserved"; message: string };

export function classifyAccountHandle(handle: string): HandleClassification {
  if (!ACCOUNT_HANDLE_GRAMMAR.test(handle) || handle.length > ACCOUNT_HANDLE_MAX_LENGTH) {
    return {
      ok: false,
      kind: "invalid",
      message: `handle must match ${ACCOUNT_HANDLE_GRAMMAR.source} and be at most ${ACCOUNT_HANDLE_MAX_LENGTH} characters`,
    };
  }
  if (RESERVED_ACCOUNT_HANDLES.has(handle)) {
    return { ok: false, kind: "reserved", message: `"${handle}" is reserved for the platform` };
  }
  if (!ACCOUNT_HANDLE_PATTERN.test(handle)) {
    // Grammar-valid but under the pattern's four-character floor.
    return {
      ok: false,
      kind: "reserved",
      message: "one-to-three-character handles are reserved for the platform",
    };
  }
  return { ok: true };
}

export class HandleError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** An Account's naming history: the current handle and its one retired name. */
export interface HandleAccountRecord {
  handle: string;
  retiredHandle: string | null;
}

export interface HandleClaim {
  accountId: string;
  handle: string;
  retiredHandle: string | null;
}

export interface HandleResolution {
  accountId: string;
  canonicalHandle: string;
  retired: boolean;
}

/**
 * Claim `handle` for `accountId`, enforcing PD 0004: platform-wide
 * uniqueness, names never released, one rename ever.
 *
 * Pure over the two directory entries the decision needs — `owner` is the
 * Account currently holding `handle` (from the per-handle key) and `account`
 * is the claiming Account's record (from the per-account key). The store
 * keys one entry per name and per Account, so no record ever accumulates the
 * whole platform and prototype names like `constructor` are ordinary keys.
 * Throws HandleError: 400 invalid, 403 reserved, 409 conflict.
 */
export function claimAccountHandle(input: {
  accountId: string;
  handle: string;
  owner: string | undefined;
  account: HandleAccountRecord | undefined;
}): { account: HandleClaim; changed: boolean } {
  const { accountId, handle, owner, account } = input;
  const classification = classifyAccountHandle(handle);
  if (!classification.ok) {
    throw new HandleError(classification.kind === "invalid" ? 400 : 403, classification.message);
  }
  if (account?.handle === handle) {
    return {
      account: { accountId, handle, retiredHandle: account.retiredHandle },
      changed: false,
    };
  }
  if (owner !== undefined && owner !== accountId) {
    throw new HandleError(409, "handle is taken, and handles are never released");
  }
  if (account !== undefined && account.retiredHandle !== null) {
    throw new HandleError(409, "an Account renames once, ever");
  }
  if (owner === accountId) {
    // The Account's own retired name: making it current again would be a
    // second rename, which the cap forbids.
    throw new HandleError(409, "an Account renames once, ever");
  }
  return {
    account: {
      accountId,
      handle,
      retiredHandle: account === undefined ? null : account.handle,
    },
    changed: true,
  };
}

/**
 * Resolve a claimed name — current or retired — to its Account. `owner` is
 * the per-handle entry for `handle`; `account` is that owner's record.
 */
export function resolveAccountHandle(
  handle: string,
  owner: string | undefined,
  account: HandleAccountRecord | undefined,
): HandleResolution | null {
  if (owner === undefined || account === undefined) return null;
  return { accountId: owner, canonicalHandle: account.handle, retired: account.handle !== handle };
}
