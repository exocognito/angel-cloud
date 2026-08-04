import { createAuth, type AuthConfigEnv } from "../auth-config";
import { deriveLoginName, hashLoginEmail, normalizeLoginEmail } from "../login-names";
import { MAX_LINKS_PER_EMAIL, MAX_LINKS_PER_SOURCE } from "../login-throttle";
import type { EmailSender } from "../email-sender";
import { LoginThrottle } from "./login-throttle";

export { LoginThrottle };

/**
 * The public front door. It is a worker of its own precisely because it must
 * be public: the Control worker sits behind a Cloudflare Access application
 * that turns away every unauthenticated request at the edge, which is right
 * for the pilot Account and impossible for signup.
 *
 * Better Auth owns the link itself — minting it, storing it hashed, and
 * spending it exactly once. What is left here is what Better Auth does not do:
 * the per-address cap, and killing an address's older links when it asks for
 * a new one.
 */

const REQUEST_LINK_PATH = "/v1/auth/sign-in/magic-link";
const VERIFY_PATH = "/v1/auth/magic-link/verify";

export interface AuthRequestEnv extends AuthConfigEnv {
  THROTTLE: DurableObjectNamespace<LoginThrottle>;
  LOGIN_NAME_KEY: string;
}

export interface AuthDependencies {
  now?: () => number;
  sender?: EmailSender;
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

  if (url.pathname === REQUEST_LINK_PATH && request.method === "POST") {
    const refusal = await guardRequestLink(request, env, now());
    if (refusal !== null) return refusal;
  }

  const auth = createAuth(env, { sender: dependencies.sender, waitUntil });
  const response = await auth.handler(request);

  if (url.pathname === VERIFY_PATH) {
    // The token rode in on the query string, so keep it out of the Referer
    // header of whatever the browser loads next. O4 clause 8.
    const headers = new Headers(response.headers);
    headers.set("referrer-policy", "no-referrer");
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

/**
 * Everything O4 asks for that Better Auth does not. Returns a response to
 * refuse with, or null to let the request through.
 */
async function guardRequestLink(
  request: Request,
  env: AuthRequestEnv,
  now: number,
): Promise<Response | null> {
  // The source cap comes first, and counts malformed requests too: a flood is
  // a flood. Refusing by source names no address, so it can say what it is.
  //
  // Cloudflare always sets this header. If it is missing the request did not
  // come through the edge, and sharing one bucket between every such caller
  // would make the cap a global ten-per-window for the whole service.
  const source = request.headers.get("cf-connecting-ip");
  if (source === null) return Response.json({ error: "no source address" }, { status: 400 });
  const sourceAllowance = await env.THROTTLE
    .getByName(`source:${await deriveLoginName(env.LOGIN_NAME_KEY, "source", source)}`)
    .spend(MAX_LINKS_PER_SOURCE, now);
  if (!sourceAllowance) {
    return Response.json({ error: "too many sign-in requests" }, { status: 429 });
  }

  // A body Better Auth will reject anyway. Let it do the rejecting, so the
  // wording of a malformed request lives in one place.
  const body: unknown = await request.clone().json().catch(() => null);
  const email = normalizeLoginEmail((body as { email?: unknown } | null)?.email);
  if (email === null) return null;

  // The address cap refuses in silence. Saying "that address has had enough
  // links" would answer the question this endpoint must never answer, so a
  // capped address gets the same body and status as everyone else, and no
  // mail.
  const emailHash = await hashLoginEmail(env.LOGIN_NAME_KEY, email);
  const emailAllowance = await env.THROTTLE
    .getByName(`email:${emailHash}`)
    .spend(MAX_LINKS_PER_EMAIL, now);
  if (!emailAllowance) return Response.json({ status: true });

  // O4 clause 5: a new link kills this address's older unused ones. Better
  // Auth names a verification row after the token's own hash, so there is no
  // index by address to ask — the address sits inside the row's JSON, and
  // this is the query that reaches it.
  //
  // Two requests for one address at the same instant can both clear and then
  // both write, leaving two live links. The per-address cap above bounds that
  // at three, and closing it properly means serialising per address, which is
  // a Durable Object round trip on every sign-in. Not worth it yet; worth
  // knowing.
  await env.AUTH_DB
    .prepare("DELETE FROM verification WHERE json_extract(value, '$.email') = ?")
    .bind(email)
    .run();

  return null;
}

export default {
  fetch(request: Request, env: AuthRequestEnv, ctx: ExecutionContext): Promise<Response> {
    return handleAuthRequest(request, env, { waitUntil: (work) => ctx.waitUntil(work) });
  },
};
