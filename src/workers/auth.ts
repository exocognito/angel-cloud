import {
  deriveLoginName,
  hashLoginEmail,
  hashMagicLinkVerifier,
  mintMagicLink,
  normalizeLoginEmail,
  parseMagicLinkToken,
} from "../magic-link";
import { MAX_LINKS_PER_EMAIL, MAX_LINKS_PER_SOURCE } from "../login-throttle";
import { LoginThrottle } from "./login-throttle";
import {
  hashSessionToken,
  mintSessionToken,
  newSession,
} from "../login-account";
import { EmailSendError, loginLinkEmail, resendSender, type EmailSender } from "../email-sender";
import { LoginAttempt } from "./login-attempt";
import { LoginIdentity } from "./login-identity";
import { LoginSession } from "./login-session";

export { LoginAttempt, LoginIdentity, LoginSession, LoginThrottle };

/**
 * The public front door. It is a worker of its own precisely because it must
 * be public: the Control worker sits behind a Cloudflare Access application
 * that turns away every unauthenticated request at the edge, which is right
 * for the pilot Account and impossible for signup.
 */

export interface AuthRequestEnv {
  LOGIN: DurableObjectNamespace<LoginAttempt>;
  IDENTITY: DurableObjectNamespace<LoginIdentity>;
  SESSION: DurableObjectNamespace<LoginSession>;
  THROTTLE: DurableObjectNamespace<LoginThrottle>;
  RESEND_API_KEY: string;
  LOGIN_NAME_KEY: string;
  LOGIN_FROM_ADDRESS: string;
  AUTH_BASE_URL: string;
}

export interface AuthDependencies {
  now?: () => number;
  sender?: EmailSender;
  /** Where a send is handed to so it does not sit on the response path. */
  waitUntil?: (work: Promise<unknown>) => void;
}

export async function handleAuthRequest(
  request: Request,
  env: AuthRequestEnv,
  dependencies: AuthDependencies = {},
): Promise<Response> {
  const now = dependencies.now ?? (() => Date.now());
  const waitUntil = dependencies.waitUntil ?? ((work: Promise<unknown>) => void work);
  const url = new URL(request.url);

  if (url.pathname === "/v1/auth/request-link" && request.method === "POST") {
    return requestLink(request, env, now(), dependencies.sender, waitUntil);
  }
  if (url.pathname === "/v1/auth/callback" && request.method === "GET") {
    return callback(url, env, now());
  }
  if (url.pathname === "/v1/auth/session" && request.method === "GET") {
    return session(request, env, now());
  }
  return json({ error: "not found" }, 404);
}

/**
 * Always the same answer. Whether the address is new, known, or nobody's, the
 * caller learns only that we accepted the request — so this endpoint cannot
 * be used to ask whether a person has an Account.
 */
async function requestLink(
  request: Request,
  env: AuthRequestEnv,
  now: number,
  sender: EmailSender | undefined,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<Response> {
  // The source cap comes first, and counts malformed requests too: a flood is
  // a flood. Refusing by source names no address, so it can say what it is.
  //
  // Cloudflare always sets this header. If it is missing the request did not
  // come through the edge, and sharing one bucket between every such caller
  // would make the cap a global ten-per-window for the whole service.
  const source = request.headers.get("cf-connecting-ip");
  if (source === null) return json({ error: "no source address" }, 400);
  const sourceAllowance = await env.THROTTLE
    .getByName(`source:${await deriveLoginName(env.LOGIN_NAME_KEY, "source", source)}`)
    .spend(MAX_LINKS_PER_SOURCE, now);
  if (!sourceAllowance) return json({ error: "too many sign-in requests" }, 429);

  const body: unknown = await request.json().catch(() => null);
  const email = normalizeLoginEmail((body as { email?: unknown } | null)?.email);
  if (email === null) return json({ error: "a single email address is required" }, 400);

  // The address cap refuses in silence. Saying "that address has had enough
  // links" would answer the question this endpoint must never answer, so a
  // throttled address gets everyone's 202 and no mail.
  const emailHash = await hashLoginEmail(env.LOGIN_NAME_KEY, email);
  const emailAllowance = await env.THROTTLE
    .getByName(`email:${emailHash}`)
    .spend(MAX_LINKS_PER_EMAIL, now);
  if (!emailAllowance) return json({ status: "accepted" }, 202);

  const minted = await mintMagicLink(env.LOGIN_NAME_KEY, email, now);
  await env.LOGIN.getByName(minted.selector).issue(minted.record);

  const link = new URL("/v1/auth/callback", env.AUTH_BASE_URL);
  link.searchParams.set("token", minted.token);

  // The send happens after the answer, not before it. A capped address never
  // reaches the sender, so waiting on Resend here would make "not capped" the
  // slow answer and "capped" the fast one — the same thing the matching bodies
  // exist to prevent. Every outcome is logged; none of them reaches the caller.
  waitUntil((async () => {
    try {
      await (sender ?? resendSender({ apiKey: env.RESEND_API_KEY, from: env.LOGIN_FROM_ADDRESS }))
        .send(loginLinkEmail({ to: email, url: link.toString() }));
    } catch (error) {
      const failure = error instanceof EmailSendError ? error.failure : "unknown";
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`sign-in mail failed (${failure}) for selector ${minted.selector}: ${detail}`);
    }
  })());

  return json({ status: "accepted" }, 202);
}

/**
 * Spend the link, then open a session — never the other way round. If the
 * spend fails for any reason the caller gets one generic refusal, so a link
 * that was already used is indistinguishable from one that never existed.
 */
async function callback(url: URL, env: AuthRequestEnv, now: number): Promise<Response> {
  const token = parseMagicLinkToken(url.searchParams.get("token"));
  if (token === null) return refuseLink();

  // No clock is passed: the object reads its own, immediately before it
  // decides, so nothing spends a link using a timestamp taken before the hash
  // and the queue.
  const spent = await env.LOGIN.getByName(token.selector)
    .consume(await hashMagicLinkVerifier(token.verifier));
  if (!spent.ok) return refuseLink();

  // The session names the identity, not the Account, and is written before the
  // Account exists. That ordering is what makes a half-finished login safe: if
  // the Account write below fails, the session resolves to nothing and answers
  // 401, and no Account has been created that nothing can reach. The reverse
  // order cannot say that.
  const sessionToken = mintSessionToken();
  const record = newSession(spent.emailHash, now);
  const sessionName = await hashSessionToken(sessionToken);
  await env.SESSION.getByName(sessionName).open(record);

  let account: { accountId: string; created: boolean };
  try {
    account = await env.IDENTITY.getByName(spent.emailHash).accountFor(now);
  } catch (error) {
    // One of the two writes has to go first, and this order is the lesser
    // harm: an unreachable session grants nothing and expires, where an
    // unreachable Account would be a real Account nothing could reach. Clear
    // it anyway so the failed login leaves nothing at all; if even that fails,
    // the object's own alarm sweeps it.
    await env.SESSION.getByName(sessionName).close().catch(() => {});
    throw error;
  }

  return json(
    { accountId: account.accountId, session: sessionToken, accountCreated: account.created },
    200,
    {
      // The token rode in on the query string, so keep it out of the Referer
      // header of whatever the browser loads next.
      "referrer-policy": "no-referrer",
      "set-cookie": `angel_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${
        Math.floor((record.expiresAt - now) / 1_000)
      }`,
    },
  );
}

async function session(request: Request, env: AuthRequestEnv, now: number): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (presented === "") return json({ error: "sign in required" }, 401);

  // Falsy-wide for the same reason as `account()` below: a rolling deploy can
  // put an older object on the far side of this call, and `=== null` would let
  // an `undefined` through to `record.emailHash` and answer 500 instead of 401.
  const record = await env.SESSION.getByName(await hashSessionToken(presented)).resolve(now);
  if (!record) return json({ error: "sign in required" }, 401);

  // A session written by a login whose Account write then failed resolves to
  // nothing, and is refused exactly like an unknown one.
  // Anything falsy means no Account, `undefined` included: a rolling deploy
  // can put an older object on the other side of this call, and `=== null`
  // would let that answer 200 with no Account named.
  const accountId = await env.IDENTITY.getByName(record.emailHash).account();
  if (!accountId) return json({ error: "sign in required" }, 401);
  return json({ accountId, expiresAt: record.expiresAt });
}

function refuseLink(): Response {
  return json({ error: "this sign-in link is not valid" }, 400, { "referrer-policy": "no-referrer" });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

export default {
  fetch(request: Request, env: AuthRequestEnv, ctx: ExecutionContext): Promise<Response> {
    return handleAuthRequest(request, env, { waitUntil: (work) => ctx.waitUntil(work) });
  },
};
