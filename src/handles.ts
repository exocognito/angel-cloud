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
  if (handle.length <= 3) {
    return {
      ok: false,
      kind: "reserved",
      message: "one-to-three-character handles are reserved for the platform",
    };
  }
  if (RESERVED_ACCOUNT_HANDLES.has(handle)) {
    return { ok: false, kind: "reserved", message: `"${handle}" is reserved for the platform` };
  }
  return { ok: true };
}

export class HandleError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface HandleAccountRecord {
  handle: string;
  retiredHandle: string | null;
}

export interface HandleDirectoryState {
  schemaVersion: 1;
  /** Every name ever claimed, mapped to its Account — entries are never removed. */
  claims: Record<string, string>;
  accounts: Record<string, HandleAccountRecord>;
}

export function emptyHandleDirectoryState(): HandleDirectoryState {
  return { schemaVersion: 1, claims: {}, accounts: {} };
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
 * uniqueness, names never released, one rename ever. Pure — returns the next
 * state, throws HandleError (400 invalid, 403 reserved, 409 conflict).
 */
export function claimAccountHandle(
  state: HandleDirectoryState,
  accountId: string,
  handle: string,
): { state: HandleDirectoryState; account: HandleClaim } {
  const classification = classifyAccountHandle(handle);
  if (!classification.ok) {
    throw new HandleError(classification.kind === "invalid" ? 400 : 403, classification.message);
  }
  const record = state.accounts[accountId];
  if (record?.handle === handle) {
    return { state, account: { accountId, handle, retiredHandle: record.retiredHandle } };
  }
  const owner = state.claims[handle];
  if (owner !== undefined && owner !== accountId) {
    throw new HandleError(409, "handle is taken, and handles are never released");
  }
  if (record !== undefined && record.retiredHandle !== null) {
    throw new HandleError(409, "an Account renames once, ever");
  }
  if (owner === accountId) {
    // The Account's own retired name: making it current again would be a
    // second rename, which the cap forbids.
    throw new HandleError(409, "an Account renames once, ever");
  }
  const next = structuredClone(state);
  next.claims[handle] = accountId;
  next.accounts[accountId] = {
    handle,
    retiredHandle: record === undefined ? null : record.handle,
  };
  return {
    state: next,
    account: { accountId, handle, retiredHandle: next.accounts[accountId]!.retiredHandle },
  };
}

/** Resolve any claimed name — current or retired — to its Account. */
export function resolveAccountHandle(
  state: HandleDirectoryState,
  handle: string,
): HandleResolution | null {
  const accountId = state.claims[handle];
  if (accountId === undefined) return null;
  const record = state.accounts[accountId];
  if (record === undefined) return null;
  return { accountId, canonicalHandle: record.handle, retired: record.handle !== handle };
}
