/**
 * What a first successful login creates: one Account, and nothing else. No
 * Angel, no Connection, no handle. Naming happens later, deliberately, so an
 * abandoned signup leaves nothing occupying the platform-wide handle space.
 *
 * The id is minted inside the same insert that creates the person, so unlike
 * the two-write version this replaces there is no moment where one exists
 * without the other.
 */

export function mintAccountId(
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): string {
  return `acct_${hex(randomBytes(16))}`;
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
