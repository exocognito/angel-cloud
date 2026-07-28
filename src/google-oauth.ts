// The scope set a Provider App gets when its registration names none. Only a
// default — each Provider App carries its own set, and consent requests that.
export const DEFAULT_GOOGLE_PROVIDER_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
];

const GOOGLE_IDENTITY_SCOPES = ["openid", "email"] as const;

// Every consent needs the identity scopes: exchangeGoogleCode verifies the
// subject and email from the id_token they produce.
export function googleConsentScopes(providerScopes: readonly string[]): string[] {
  return [...new Set<string>([...GOOGLE_IDENTITY_SCOPES, ...providerScopes])];
}

// Scopes are space-joined into the authorize URL, so a value containing
// whitespace would smuggle extra scopes past whoever reviewed the list.
export function parseProviderScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("scopes must be a non-empty array of scope strings");
  }
  for (const scope of value) {
    if (typeof scope !== "string" || !/^[\x21-\x7e]+$/.test(scope)) {
      throw new Error("scopes entries must be non-empty strings without whitespace");
    }
  }
  return [...new Set<string>(value)].sort();
}

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export interface GoogleJwk {
  kty: "RSA";
  n: string;
  e: string;
  kid?: string;
  alg?: string;
  use?: string;
}

export interface GoogleJwks {
  keys: GoogleJwk[];
}

export interface GoogleCodeExchangeInput {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  requiredScopes: readonly string[];
}

export interface GoogleConnectionCredential {
  subject: string;
  email: string;
  refreshToken: string;
  grantedScopes: string[];
}

export type GoogleFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function buildGoogleAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: readonly string[];
}): string {
  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: googleConsentScopes(input.scopes).join(" "),
    access_type: "offline",
    prompt: "consent",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function exchangeGoogleCode(
  input: GoogleCodeExchangeInput,
  fetcher: GoogleFetch = globalThis.fetch,
): Promise<GoogleConnectionCredential> {
  const form = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  });
  let response: Response;
  try {
    response = await fetcher(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch {
    throw new Error("Google OAuth token exchange failed");
  }
  if (!response.ok) throw new Error("Google OAuth token exchange failed");
  const token = await jsonRecord(response, "Google OAuth token response");
  if (typeof token.refresh_token !== "string" || token.refresh_token === "") {
    throw new Error("Google OAuth response did not include a refresh token");
  }
  if (typeof token.id_token !== "string" || token.id_token === "") {
    throw new Error("Google OAuth response did not include an id_token");
  }
  const scopes = parseGrantedScopes(token.scope);
  // The floor is what this Provider App was configured to request — a partial
  // grant (the user unchecked a box on the consent screen) fails here rather
  // than surfacing later as a Connection that cannot run its operations.
  if (input.requiredScopes.some((scope) => !scopes.includes(scope))) {
    throw new Error("Google OAuth response omitted a required scope");
  }
  const identity = await verifyGoogleIdToken(token.id_token, input.clientId, fetcher);
  return {
    ...identity,
    refreshToken: token.refresh_token,
    grantedScopes: scopes,
  };
}

export async function revokeGoogleRefreshToken(
  refreshToken: string,
  fetcher: GoogleFetch = globalThis.fetch,
): Promise<void> {
  const response = await fetcher("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken }).toString(),
  });
  if (!response.ok) throw new Error("Google OAuth revocation failed");
}

async function verifyGoogleIdToken(
  token: string,
  clientId: string,
  fetcher: GoogleFetch,
): Promise<{ subject: string; email: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Google OAuth id_token is malformed");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJson(encodedHeader!, "Google OAuth id_token header");
  const payload = parseJson(encodedPayload!, "Google OAuth id_token payload");
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid === "") {
    throw new Error("Google OAuth id_token algorithm or key is invalid");
  }
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
    throw new Error("Google OAuth id_token issuer is invalid");
  }
  if (payload.aud !== clientId) throw new Error("Google OAuth id_token audience is invalid");
  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Google OAuth id_token is expired");
  }
  if (payload.email_verified !== true) throw new Error("Google OAuth email is not verified");
  if (typeof payload.sub !== "string" || payload.sub === "") throw new Error("Google OAuth subject is missing");
  if (typeof payload.email !== "string" || payload.email === "") throw new Error("Google OAuth email is missing");

  const response = await fetcher(GOOGLE_JWKS_URL);
  if (!response.ok) throw new Error("Google OAuth signing keys are unavailable");
  const jwks = await response.json() as unknown;
  if (!isJwks(jwks)) throw new Error("Google OAuth signing keys are invalid");
  const jwk = jwks.keys.find((candidate) => candidate.kid === header.kid);
  if (jwk === undefined) throw new Error("Google OAuth signing key is unknown");
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
  if (!valid) throw new Error("Google OAuth id_token signature is invalid");
  return { subject: payload.sub, email: payload.email };
}

function parseGrantedScopes(value: unknown): string[] {
  if (typeof value !== "string") throw new Error("Google OAuth response did not include granted scopes");
  const scopes = [...new Set(value.split(/\s+/).filter((scope) => scope !== ""))].sort();
  if (scopes.length === 0) throw new Error("Google OAuth response did not include granted scopes");
  return scopes;
}

async function jsonRecord(response: Response, label: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function parseJson(encoded: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded)));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function isJwks(value: unknown): value is GoogleJwks {
  return typeof value === "object"
    && value !== null
    && Array.isArray((value as { keys?: unknown }).keys)
    && (value as { keys: unknown[] }).keys.every((key) => typeof key === "object" && key !== null);
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy.buffer;
}
