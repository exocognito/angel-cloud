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
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
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
