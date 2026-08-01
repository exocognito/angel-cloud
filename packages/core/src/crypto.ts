// Web-Crypto primitives, portable across Workers / Durable Objects / Bun.
// Copied verbatim into every built angel — no imports.

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time comparison of two strings. Both sides are hashed to fixed
// 32-byte digests first so inputs of different lengths never leak length via
// an early exit — a direct byte compare of variable-length strings would.
export async function timingSafeEqualText(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) {
    diff |= da.charCodeAt(i) ^ db.charCodeAt(i);
  }
  return diff === 0;
}
