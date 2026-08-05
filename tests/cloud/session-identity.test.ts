import { describe, expect, test } from "bun:test";
import {
  SessionAuthenticationError,
  authenticateSessionRequest,
  type SessionFetcher,
} from "../../src/session-identity";

/** Stands in for the sign-in Worker over its service binding. */
function authService(reply: Response | (() => Response | Promise<Response>)): SessionFetcher & {
  seen: Array<{ url: string; headers: Record<string, string> }>;
} {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  return {
    seen,
    async fetch(input, init) {
      seen.push({
        url: String(input),
        headers: Object.fromEntries(init.headers.entries()),
      });
      return typeof reply === "function" ? await reply() : reply.clone();
    },
  };
}

const SESSION = {
  session: { id: "sess_1", expiresAt: "2026-08-18T00:00:00.000Z" },
  user: { id: "user_1", email: "owner@example.invalid", angelAccountId: "acct_one" },
};

describe("session identity", () => {
  test("reads the Account, the person and their address off a live session", async () => {
    const auth = authService(Response.json(SESSION));
    const identity = await authenticateSessionRequest(
      new Request("https://dash.test/api/demo/state", { headers: { cookie: "s=abc" } }),
      auth,
    );

    expect(identity).toEqual({
      accountId: "acct_one",
      subject: "user_1",
      email: "owner@example.invalid",
    });
  });

  test("forwards only the credential the caller presented", async () => {
    const auth = authService(Response.json(SESSION));
    await authenticateSessionRequest(
      new Request("https://dash.test/api/demo/state", {
        method: "POST",
        headers: { cookie: "s=abc", "x-tenant": "acct_two", "content-type": "application/json" },
        body: "{}",
      }),
      auth,
    );

    // A caller must not be able to colour the question it is being asked, so
    // nothing but the credential travels.
    expect(auth.seen).toHaveLength(1);
    expect(auth.seen[0]!.headers).toEqual({ cookie: "s=abc" });
  });

  test("prefers the cookie when an unrelated bearer rides along", async () => {
    // The golden runner's reset sends the admin token in `Authorization` while
    // the session rides as a cookie, exactly as a browser sends it. Forwarding
    // both makes Better Auth's bearer plugin read the admin token as the
    // session, fail, and refuse a caller who is signed in — which is how the
    // live run found this: reset answered 401 to a valid session.
    const auth = authService(Response.json(SESSION));
    const cookie = "__Secure-better-auth.session_token=abc.sig";
    await authenticateSessionRequest(
      new Request("https://dash.test/api/demo/reset", {
        method: "POST",
        headers: { cookie, authorization: "Bearer admin-token-not-a-session" },
      }),
      auth,
    );

    expect(auth.seen[0]!.headers).toEqual({ cookie });
  });

  test("keeps the bearer when the cookie jar carries no session", async () => {
    // The session cookie is scoped to `.angelmcp.ai`, so the browser attaches
    // whatever any host on the zone has set. If ANY cookie beat a bearer, one
    // unrelated zone cookie would suppress a real credential and refuse a
    // caller who is properly authenticated.
    const auth = authService(Response.json(SESSION));
    await authenticateSessionRequest(
      new Request("https://dash.test/v1/accounts/acct_one/angels", {
        headers: { cookie: "docs_theme=dark; ab_test=7", authorization: "Bearer real-session" },
      }),
      auth,
    );

    expect(auth.seen[0]!.headers).toEqual({ authorization: "Bearer real-session" });
  });

  test("matches the session cookie by name, not by a substring of some other value", async () => {
    // A cookie whose VALUE mentions the name must not pass for the cookie.
    const auth = authService(Response.json(SESSION));
    await authenticateSessionRequest(
      new Request("https://dash.test/api/demo/state", {
        headers: {
          cookie: "decoy=__Secure-better-auth.session_token",
          authorization: "Bearer real-session",
        },
      }),
      auth,
    );

    expect(auth.seen[0]!.headers).toEqual({ authorization: "Bearer real-session" });
  });

  test("classifies a subject-less session as terminal, not as sign in again", async () => {
    // Unreachable while Better Auth always returns user.id, which is why it is
    // worth pinning: a refusal signing in cannot fix must never send the person
    // back to the sign-in page, or the loop CL10 removed comes back.
    const auth = authService(Response.json({ user: { angelAccountId: "acct_one", id: "" } }));
    const refusal = await authenticateSessionRequest(
      new Request("https://dash.test/api/demo/state", { headers: { authorization: "Bearer t" } }),
      auth,
    ).then(() => null, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(SessionAuthenticationError);
    expect((refusal as SessionAuthenticationError).code).toBe("no-account");
  });

  test("refuses a lookalike cookie name invented by a sibling host", async () => {
    // Any host on the zone can set a cookie the browser will send here. A
    // suffix test would accept `evil-better-auth.session_token` and let that
    // host suppress a real bearer, so the two legitimate names are an exact set.
    const auth = authService(Response.json(SESSION));
    await authenticateSessionRequest(
      new Request("https://dash.test/api/demo/state", {
        headers: {
          cookie: "evil-better-auth.session_token=forged",
          authorization: "Bearer real-session",
        },
      }),
      auth,
    );

    expect(auth.seen[0]!.headers).toEqual({ authorization: "Bearer real-session" });
  });

  test("accepts the unprefixed cookie name, which is what a non-https base URL gets", async () => {
    const auth = authService(Response.json(SESSION));
    const cookie = "better-auth.session_token=abc.sig";
    await authenticateSessionRequest(
      new Request("https://dash.test/api/demo/state", {
        headers: { cookie, authorization: "Bearer not-a-session" },
      }),
      auth,
    );

    expect(auth.seen[0]!.headers).toEqual({ cookie });
  });

  test("carries a bearer token through, which is all the CLI will have", async () => {
    const auth = authService(Response.json(SESSION));
    await authenticateSessionRequest(
      new Request("https://dash.test/api/demo/state", { headers: { authorization: "Bearer tok" } }),
      auth,
    );

    expect(auth.seen[0]!.headers).toEqual({ authorization: "Bearer tok" });
  });

  test("refuses a caller with no credential without troubling the sign-in Worker", async () => {
    const auth = authService(Response.json(SESSION));
    await expect(authenticateSessionRequest(new Request("https://dash.test/api/demo/state"), auth))
      .rejects.toThrow(SessionAuthenticationError);
    expect(auth.seen).toEqual([]);
  });

  test("treats Better Auth's `200 null` for a spent session as a refusal", async () => {
    // The framework answers 200 with a null body when a session is absent or
    // expired. Read as success it would hand the caller somebody else's view.
    const auth = authService(Response.json(null));
    await expect(
      authenticateSessionRequest(
        new Request("https://dash.test/api/demo/state", { headers: { cookie: "s=stale" } }),
        auth,
      ),
    ).rejects.toThrow(SessionAuthenticationError);
  });

  test("refuses a session whose user carries no Account rather than guessing one", async () => {
    const auth = authService(Response.json({ session: SESSION.session, user: { id: "user_1" } }));
    await expect(
      authenticateSessionRequest(
        new Request("https://dash.test/api/demo/state", { headers: { cookie: "s=abc" } }),
        auth,
      ),
    ).rejects.toThrow(SessionAuthenticationError);
  });

  test("separates a refusal from an outage, so one does not read as the other", async () => {
    const refused = authService(new Response(null, { status: 401 }));
    const broken = authService(new Response("nope", { status: 503 }));
    const unreachable = authService(() => {
      throw new Error("no route to service");
    });
    const request = () => new Request("https://dash.test/api/demo/state", { headers: { cookie: "s=abc" } });

    await expect(authenticateSessionRequest(request(), refused)).rejects.toThrow(SessionAuthenticationError);
    // A broken verifier must not turn into a 401, which reads as "sign in
    // again" and sends a signed-in person round a loop they cannot leave.
    await expect(authenticateSessionRequest(request(), broken)).rejects.not.toThrow(SessionAuthenticationError);
    await expect(authenticateSessionRequest(request(), unreachable)).rejects.not.toThrow(SessionAuthenticationError);
  });
});

describe("telling a refusal apart from one signing in again cannot fix", () => {
  test("marks a session that carries no Account, so the dashboard stops looping", async () => {
    const auth = authService(Response.json({ session: SESSION.session, user: { id: "user_1" } }));
    const failure = await authenticateSessionRequest(
      new Request("https://dash.test/api/demo/state", { headers: { cookie: "s=abc" } }),
      auth,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionAuthenticationError);
    expect((failure as SessionAuthenticationError).code).toBe("no-account");
  });

  test("leaves an ordinary refusal unmarked", async () => {
    const auth = authService(Response.json(null));
    const failure = await authenticateSessionRequest(
      new Request("https://dash.test/api/demo/state", { headers: { cookie: "s=stale" } }),
      auth,
    ).catch((error: unknown) => error);

    expect((failure as SessionAuthenticationError).code).toBe("sign-in-required");
  });

  test("forwards the caller's address so the framework can bucket them apart", async () => {
    const auth = authService(Response.json(SESSION));
    await authenticateSessionRequest(
      new Request("https://dash.test/api/demo/state", {
        headers: { cookie: "s=abc", "cf-connecting-ip": "198.51.100.7" },
      }),
      auth,
    );

    expect(auth.seen[0]!.headers).toEqual({ cookie: "s=abc", "cf-connecting-ip": "198.51.100.7" });
  });
});
