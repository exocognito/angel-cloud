export interface AccessJwk {
  kty: "RSA";
  n: string;
  e: string;
  kid?: string;
  alg?: string;
  use?: string;
}

export interface AccessJwks {
  keys: AccessJwk[];
}

export interface AccessConfig {
  teamDomain: string;
  audience: string;
  accountId: string;
}

export interface AccessIdentity {
  accountId: string;
  subject: string;
  email?: string;
  commonName?: string;
}

export type AccessFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class AccessAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessAuthenticationError";
  }
}

export async function authenticateAccessRequest(
  request: Request,
  config: AccessConfig,
  fetcher: AccessFetch = globalThis.fetch,
): Promise<AccessIdentity> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (token === undefined || token === "") throw new AccessAuthenticationError("Access JWT is required");
  if (config.teamDomain.trim() === "" || config.audience.trim() === "" || config.accountId.trim() === "") {
    throw new Error("Access JWT verifier is not configured");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessAuthenticationError("Access JWT is malformed");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJson(encodedHeader!, "Access JWT header");
  const payload = parseJson(encodedPayload!, "Access JWT payload");
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid === "") {
    throw new AccessAuthenticationError("Access JWT algorithm or key is invalid");
  }
  if (payload.iss !== config.teamDomain) throw new AccessAuthenticationError("Access JWT issuer is invalid");
  if (!audienceIncludes(payload.aud, config.audience)) throw new AccessAuthenticationError("Access JWT audience is invalid");
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new AccessAuthenticationError("Access JWT is expired");
  }

  const jwksResponse = await fetcher(`${config.teamDomain.replace(/\/$/, "")}/cdn-cgi/access/certs`);
  if (!jwksResponse.ok) throw new Error("Access JWT signing keys are unavailable");
  const jwks = await jwksResponse.json() as unknown;
  if (!isJwks(jwks)) throw new Error("Access JWT signing keys are invalid");
  const jwk = jwks.keys.find((candidate) => candidate.kid === header.kid);
  if (jwk === undefined) throw new AccessAuthenticationError("Access JWT signing key is unknown");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    toArrayBuffer(decodeBase64Url(encodedSignature!)),
    toArrayBuffer(new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)),
  );
  if (!valid) throw new AccessAuthenticationError("Access JWT signature is invalid");

  const sub = typeof payload.sub === "string" ? payload.sub : undefined;
  const commonName = typeof payload.common_name === "string" ? payload.common_name : undefined;
  if ((sub === undefined || sub === "") && (commonName === undefined || commonName === "")) {
    throw new AccessAuthenticationError("Access JWT identity is missing");
  }
  const identity: AccessIdentity = {
    accountId: config.accountId,
    subject: sub === undefined || sub === "" ? commonName! : sub,
    ...(typeof payload.email === "string" && payload.email !== "" ? { email: payload.email } : {}),
    ...(commonName === undefined ? {} : { commonName }),
  };
  return identity;
}

function parseJson(encoded: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded)));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new AccessAuthenticationError(`${label} is invalid`);
  }
}

function audienceIncludes(value: unknown, expected: string): boolean {
  return typeof value === "string" ? value === expected : Array.isArray(value) && value.includes(expected);
}

function isJwks(value: unknown): value is AccessJwks {
  return typeof value === "object"
    && value !== null
    && Array.isArray((value as { keys?: unknown }).keys)
    && (value as { keys: unknown[] }).keys.every((key) => typeof key === "object" && key !== null);
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy.buffer;
}
