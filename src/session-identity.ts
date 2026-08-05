/**
 * Who is asking, according to the sign-in Worker.
 *
 * Control does not read Better Auth's tables and does not hold its secret. It
 * asks the Worker that owns sessions, forwarding whatever credential the caller
 * presented, and believes the answer. That keeps one authority over what a
 * session is, so a Better Auth upgrade stays a one-Worker problem.
 */

export interface SessionIdentity {
  accountId: string;
  subject: string;
  email?: string;
}

export class SessionAuthenticationError extends Error {
  /**
   * `no-account` is the one refusal signing in again cannot fix: the session
   * is real, it just names no Account. Without telling them apart the
   * dashboard sends that person to the sign-in page, they sign in, and the
   * same refusal comes back — a loop with no diagnostic in it.
   */
  readonly code: "sign-in-required" | "no-account";

  constructor(message: string, code: "sign-in-required" | "no-account" = "sign-in-required") {
    super(message);
    this.name = "SessionAuthenticationError";
    this.code = code;
  }
}

/**
 * Narrower than `fetch` on purpose: this is one service binding asked one
 * question, and the narrow shape is what lets a test fake read the headers
 * without reconciling Bun's `HeadersInit` with the Workers runtime's.
 */
export interface SessionFetcher {
  fetch(input: string, init: { headers: Headers }): Promise<Response>;
}

/** The session endpoint on the sign-in Worker, reached over a service binding. */
const SESSION_URL = "https://auth.internal/v1/auth/get-session";

export async function authenticateSessionRequest(
  request: Request,
  auth: SessionFetcher,
): Promise<SessionIdentity> {
  const headers = new Headers();
  // A browser presents the cookie, which spans the zone; the CLI presents a
  // bearer token. Forward whichever arrived and nothing else — passing the
  // whole request would hand the session Worker an unrelated method and body.
  //
  // The cookie wins when both are present, and that is not a preference. A
  // request can carry an `Authorization` header meant for something else
  // entirely — the golden runner's reset sends the admin token there while the
  // session rides as a cookie — and Better Auth's bearer plugin would read that
  // admin token as the session, fail to resolve it, and refuse a caller who is
  // properly signed in.
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  if (cookie !== null) headers.set("cookie", cookie);
  else if (authorization !== null) headers.set("authorization", authorization);
  else throw new SessionAuthenticationError("sign-in required");
  // The caller's address travels too, and only that. Without it the framework
  // resolves no IP and rate-limits every tenant out of one shared bucket, so
  // this is load-bearing rather than telemetry. It is Cloudflare's own header,
  // which a caller cannot forge past the edge.
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp !== null) headers.set("cf-connecting-ip", clientIp);

  let response: Response;
  try {
    response = await auth.fetch(SESSION_URL, { headers });
  } catch {
    throw new Error("session verifier is unreachable");
  }
  if (response.status === 401) throw new SessionAuthenticationError("sign-in required");
  if (!response.ok) throw new Error("session verifier failed");

  // Better Auth answers `200 null` for an absent or spent session, so an empty
  // body is a refusal rather than an error.
  const body = await response.json() as unknown;
  if (body === null || typeof body !== "object") {
    throw new SessionAuthenticationError("sign-in required");
  }
  const user = (body as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) {
    throw new SessionAuthenticationError("sign-in required");
  }
  const { angelAccountId, id, email } = user as Record<string, unknown>;
  // A signed-in person with no Account cannot be served as somebody: refuse
  // rather than fall back to a default, which is how one tenant reads another.
  if (typeof angelAccountId !== "string" || angelAccountId === "") {
    throw new SessionAuthenticationError("session carries no Account", "no-account");
  }
  if (typeof id !== "string" || id === "") {
    throw new SessionAuthenticationError("session carries no subject");
  }
  return {
    accountId: angelAccountId,
    subject: id,
    ...(typeof email === "string" && email !== "" ? { email } : {}),
  };
}
