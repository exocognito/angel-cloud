// The google-discovery@1 adapter edge: interprets the request template the
// artifact sealed for an allowed tool call, mints an access token from the
// leased refresh token, and forwards exactly that request to the pinned
// origin. It enumerates no operations — everything executable comes from the
// sealed data the gate hands over (ADR 0005). Behaviorally ported from the
// legacy comparison runtime's buildHttpCall hardening.

import type { ConnectionCredentialLease } from "./custody";
import type { GoogleFetch } from "./google-oauth";
import type { ToolRequest } from "./domain";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface SealedInvocation {
  operation: string;
  origin: string;
  request: ToolRequest;
  args: Record<string, unknown>;
}

// prepare maps args onto the sealed template and throws on anything the
// request cannot express — it runs BEFORE custody is touched, so a malformed
// call never reaches the vault or mints a token. invoke performs the
// credentialed exchange. Deterministic test providers substitute their own
// pair; `call` is null on that path.
export interface PreparedInvocation {
  operation: string;
  args: Record<string, unknown>;
  call: HttpCall | null;
}

export interface GoogleProvider {
  prepare(invocation: SealedInvocation): PreparedInvocation;
  invoke(prepared: PreparedInvocation, lease: ConnectionCredentialLease): Promise<Record<string, unknown>>;
}

export class GoogleRefreshAuthorizationError extends Error {
  constructor() {
    super("Google refresh authorization failed");
    this.name = "GoogleRefreshAuthorizationError";
  }
}

export class GoogleProviderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "GoogleProviderError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
        writable: true,
      });
    }
  }
}

export function createGoogleProvider(fetcher: GoogleFetch = globalThis.fetch): GoogleProvider {
  return {
    prepare(invocation) {
      return {
        operation: invocation.operation,
        args: invocation.args,
        call: buildHttpCall(invocation),
      };
    },
    async invoke(prepared, lease) {
      if (prepared.call === null) {
        throw new GoogleProviderError("prepared invocation is missing its http call");
      }
      const accessToken = await refreshAccessToken(lease, fetcher);
      const response = await fetchProvider(prepared.operation, prepared.call, accessToken, fetcher);
      if (!response.ok) {
        throw new GoogleProviderError(`Google ${prepared.operation} request failed with status ${response.status}`);
      }
      // Deletes answer 204 No Content — the mutation succeeded, so failing on
      // the empty body would invite a harmful retry.
      if (response.status === 204) return {};
      return parseJsonRecord(response, `Google ${prepared.operation} response`);
    },
  };
}

export interface HttpCall {
  method: string;
  url: string;
  body?: string;
}

// Args arrive as one flat object (the same surface the guards evaluated).
// Path params are required (template defaults fill absences), query params
// are optional, and everything left over IS the request body when the
// operation takes one — and an error when it doesn't: an argument the
// request can't express must fail, never vanish.
function buildHttpCall(invocation: SealedInvocation): HttpCall {
  const { origin, request, args } = invocation;
  const used = new Set<string>();

  let path = request.pathTemplate;
  for (const name of request.pathParams) {
    const value = args[name] ?? request.pathDefaults[name];
    if (value === undefined) {
      throw new GoogleProviderError(`missing required path parameter: ${name}`);
    }
    if (!isScalar(value)) {
      throw new GoogleProviderError(`path parameter ${name} must be a string, number, or boolean`);
    }
    const encoded = encodeURIComponent(String(value));
    // encodeURIComponent leaves "." and ".." untouched, and URL parsing then
    // normalizes `.../x/..` up a segment — a value that would send Google a
    // DIFFERENT path than the allowlisted operation. Reject the dot segments
    // outright (every legitimate id encodes to something else).
    // An empty value collapses the whole segment — a different resource
    // than the allowlisted operation, same class as the dot segments.
    if (encoded === "" || encoded === "." || encoded === "..") {
      throw new GoogleProviderError(`path parameter ${name} may not be empty, ".", or ".."`);
    }
    path = path.replace(`{${name}}`, encoded);
    used.add(name);
  }

  const query = new URLSearchParams();
  for (const name of request.queryParams) {
    const value = args[name];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (!isScalar(entry)) {
          throw new GoogleProviderError(`query parameter ${name} entries must be strings, numbers, or booleans`);
        }
        query.append(name, String(entry));
      }
    } else {
      if (!isScalar(value)) {
        throw new GoogleProviderError(`query parameter ${name} must be a string, number, or boolean`);
      }
      query.append(name, String(value));
    }
    used.add(name);
  }

  // Null prototype: a `__proto__` key on a plain object hits the prototype
  // setter and silently vanishes from the forwarded request.
  const body: Record<string, unknown> = Object.create(null);
  for (const [name, value] of Object.entries(args)) {
    if (used.has(name)) continue;
    if (!invocation.request.hasBody) {
      throw new GoogleProviderError(`argument ${name} is not expressible by ${invocation.operation}`);
    }
    body[name] = value;
  }

  const queryText = query.toString();
  return {
    method: request.method,
    url: `${origin}${path}${queryText === "" ? "" : `?${queryText}`}`,
    // A body-capable operation always carries a JSON body — several reviewed
    // operations seal a REQUIRED body, and omitting it would 400 upstream.
    ...(invocation.request.hasBody ? { body: JSON.stringify(body) } : {}),
  };
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

async function refreshAccessToken(
  lease: ConnectionCredentialLease,
  fetcher: GoogleFetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: lease.clientId,
        client_secret: lease.clientSecret,
        refresh_token: lease.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
  } catch (error) {
    throw new GoogleProviderError(
      "Google token refresh request failed",
      sanitizedCause(error, [lease.clientId, lease.clientSecret, lease.refreshToken]),
    );
  }

  if (response.status === 401) throw new GoogleRefreshAuthorizationError();
  if (!response.ok) {
    const payload = await parseOptionalJsonRecord(response);
    if (payload?.error === "invalid_grant") throw new GoogleRefreshAuthorizationError();
    throw new GoogleProviderError(`Google token refresh failed with status ${response.status}`);
  }
  const payload = await parseJsonRecord(response, "Google token refresh response");
  if (
    typeof payload.access_token !== "string"
    || payload.access_token === ""
    || payload.token_type !== "Bearer"
    || typeof payload.expires_in !== "number"
    || !Number.isFinite(payload.expires_in)
    || payload.expires_in <= 0
  ) {
    throw new GoogleProviderError("Google token refresh response is invalid");
  }
  return payload.access_token;
}

async function fetchProvider(
  operation: string,
  call: HttpCall,
  accessToken: string,
  fetcher: GoogleFetch,
): Promise<Response> {
  try {
    return await fetcher(call.url, {
      method: call.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(call.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(call.body !== undefined ? { body: call.body } : {}),
    });
  } catch (error) {
    throw new GoogleProviderError(
      `Google ${operation} request failed`,
      sanitizedCause(error, [accessToken]),
    );
  }
}

async function parseJsonRecord(response: Response, label: string): Promise<Record<string, unknown>> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error();
    return payload as Record<string, unknown>;
  } catch {
    throw new GoogleProviderError(`${label} is invalid`);
  }
}

async function parseOptionalJsonRecord(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
    return payload as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function sanitizedCause(error: unknown, secrets: readonly string[]): Error {
  let message = error instanceof Error ? error.message : "unknown network error";
  for (const secret of secrets) {
    if (secret !== "") message = message.replaceAll(secret, "[redacted]");
  }
  return new Error(message);
}
