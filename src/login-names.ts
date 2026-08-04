/**
 * Folding an address to one form, and naming storage after it without storing
 * it. Better Auth owns the magic-link rules now; these two jobs stay ours
 * because the per-address throttle is ours.
 */

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
 * Names the throttle's storage. Keyed, not a bare digest: an email address is
 * dictionary-sized, so an unkeyed hash would let anyone who can list stored
 * object names — a dashboard, an export, a point-in-time restore — recover
 * exactly which addresses have been asking for links. That is the enumeration
 * O4 forbids, reached through a different door.
 *
 * Better Auth's own tables now hold addresses in the clear, which is a
 * deliberate trade recorded with the cutover. It is not a reason to give this
 * up too: the throttle names sit in a different store with different reach.
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
