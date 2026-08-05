import { describe, expect, mock, test } from "bun:test";
import { SessionAuthenticationError, type SessionIdentity } from "../../src/session-identity";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected readonly ctx: unknown;
    protected readonly env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { AccountRegistry, handleControlRequest } = await import("../../src/workers/control");

/**
 * Two people, one Worker. Every registry here is a real `AccountRegistry` over
 * its own storage, reached by name exactly as Control reaches it in production,
 * so the Account a request lands in is decided by the same code path that
 * decides it live.
 */
function twoTenantEnv() {
  const stores = new Map<string, Map<string, unknown>>();
  const registries = new Map<string, InstanceType<typeof AccountRegistry>>();
  const reached: string[] = [];

  function registry(name: string): InstanceType<typeof AccountRegistry> {
    let instance = registries.get(name);
    if (instance === undefined) {
      const storage = new Map<string, unknown>();
      stores.set(name, storage);
      instance = new AccountRegistry({
        id: { name },
        storage: {
          get: async (key: string) => structuredClone(storage.get(key)),
          put: async (key: string | Record<string, unknown>, value?: unknown) => {
            if (typeof key === "string") {
              storage.set(key, structuredClone(value));
              return;
            }
            for (const [entryKey, entryValue] of Object.entries(key)) {
              storage.set(entryKey, structuredClone(entryValue));
            }
          },
        },
      } as never, env as never);
      registries.set(name, instance);
    }
    return instance;
  }

  const env = {
    CONTROL_RESPONSE_KEK: "response-replay-kek",
    DEMO_ADMIN_TOKEN: "admin-secret",
    CONTROL_GATEWAY_TOKEN: "control-gateway-secret",
    CONTROL_BROKER_TOKEN: "control-broker-secret",
    GATEWAY_BASE_URL: "https://gateway.example",
    ACCOUNTS: {
      getByName(name: string) {
        reached.push(name);
        return registry(name);
      },
    },
    ASSETS: {
      async fetch(request: Request) {
        return new Response(`asset:${new URL(request.url).pathname}`);
      },
    },
  };

  return { env, reached, stores };
}

function signedInAs(accountId: string) {
  return async (): Promise<SessionIdentity> => ({
    accountId,
    subject: `user-of-${accountId}`,
    email: `${accountId}@example.invalid`,
  });
}

/** Whoever is asking for a sign-in link, by definition. */
const signedInAsNobody = async (): Promise<SessionIdentity> => {
  throw new SessionAuthenticationError("sign-in required");
};

describe("Control serves whoever signed in", () => {
  test("sends two people to two different Accounts", async () => {
    const { env, reached } = twoTenantEnv();

    await handleControlRequest(
      new Request("https://dash.test/api/demo/state"),
      env as never,
      signedInAs("acct_one"),
    );
    await handleControlRequest(
      new Request("https://dash.test/api/demo/state"),
      env as never,
      signedInAs("acct_two"),
    );

    // Before the session decided this, both requests reached the one Account
    // named by configuration, whoever was asking.
    expect(reached).toEqual(["acct_one", "acct_two"]);
  });

  test("keeps one person's Angels out of the other's dashboard", async () => {
    const { env } = twoTenantEnv();
    const reset = (accountId: string) =>
      handleControlRequest(
        new Request("https://dash.test/api/demo/reset", {
          method: "POST",
          headers: { authorization: "Bearer admin-secret" },
        }),
        env as never,
        signedInAs(accountId),
      );

    const one = await reset("acct_one");
    const two = await reset("acct_two");
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);

    // Each Account's own view must name itself. A registry reading its Account
    // from configuration stamps the same id into both, which is the bug this
    // guards: two tenants, one identity, and no way to tell them apart.
    const viewOne = await one.json() as { account: { id: string } };
    const viewTwo = await two.json() as { account: { id: string } };
    expect(viewOne.account.id).toBe("acct_one");
    expect(viewTwo.account.id).toBe("acct_two");
  });

  test("decides where a spent link lands, whatever the caller asked for", async () => {
    // A relative callbackURL resolves against the sign-in Worker's own origin,
    // so the live run stranded people on a Worker that serves nothing. O4
    // clause 8 wants an allowlisted redirect; the narrowest allowlist is one
    // entry nobody outside can name.
    const { env } = twoTenantEnv();
    const sent: Array<{ url: string; body: unknown }> = [];
    const withAuth = {
      ...env,
      CONTROL_BASE_URL: "https://dash.test",
      AUTH: {
        async fetch(input: string | URL | Request, init?: RequestInit) {
          sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
          return Response.json({ status: true });
        },
      },
    };

    // Asked by somebody with no session, because that is the only kind of
    // person who needs one. A verifier that succeeds here would let the route
    // drift behind the session check and the test would not notice.
    const response = await handleControlRequest(
      new Request("https://dash.test/api/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "stranger@example.invalid", callbackURL: "https://evil.test/" }),
      }),
      withAuth as never,
      signedInAsNobody,
    );

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({
      email: "stranger@example.invalid",
      callbackURL: "https://dash.test",
    });
  });

  test("answers a stranger's malformed sign-in body with 400, not a runtime 500", async () => {
    // This route sits outside the guarded block, so an uncaught throw here
    // escapes handleControlRequest and the deployed Worker answers a bare 500
    // on the one path a stranger can reach.
    const { env } = twoTenantEnv();
    const withAuth = {
      ...env,
      CONTROL_BASE_URL: "https://dash.test",
      AUTH: { async fetch() { return Response.json({ status: true }); } },
    };

    const response = await handleControlRequest(
      new Request("https://dash.test/api/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json at all",
      }),
      withAuth as never,
      signedInAsNobody,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "request body must be valid JSON" });
  });

  test("refuses a session whose Account is not an internal id", async () => {
    const { env, reached } = twoTenantEnv();
    // A handle where an id belongs would 404 every resolution downstream.
    const response = await handleControlRequest(
      new Request("https://dash.test/api/demo/state"),
      env as never,
      signedInAs("my-handle"),
    );

    expect(response.status).toBe(500);
    expect(reached).toEqual([]);
  });

  // The dashboard's half of this contract is pinned in www-contract.test.ts.
  // Both sides key off the same two literals; delete either and the redirect
  // loop CL10 fixed comes back silently, because the behaviour is carried by a
  // string rather than by a type.
  test("names the refusal in x-angel-session so the dashboard can tell them apart", async () => {
    const { env } = twoTenantEnv();
    const refuse = (code: "sign-in-required" | "no-account") =>
      handleControlRequest(
        new Request("https://dash.test/api/demo/state"),
        env as never,
        async () => {
          throw new SessionAuthenticationError("refused", code);
        },
      );

    const noAccount = await refuse("no-account");
    const noSession = await refuse("sign-in-required");

    // Same status and same body either way — only the header differs, so
    // nothing here tells a stranger which of their guesses was closer.
    expect(noAccount.status).toBe(401);
    expect(noSession.status).toBe(401);
    expect(await noAccount.json()).toEqual({ error: "sign-in required" });
    expect(await noSession.json()).toEqual({ error: "sign-in required" });
    expect(noAccount.headers.get("x-angel-session")).toBe("no-account");
    expect(noSession.headers.get("x-angel-session")).toBe("sign-in-required");
  });

  test("sends an expired Google callback to sign-in rather than JSON in the address bar", async () => {
    const { env } = twoTenantEnv();
    const callback = (code: "sign-in-required" | "no-account") =>
      handleControlRequest(
        new Request("https://dash.test/oauth/google/callback?code=abc&state=xyz"),
        env as never,
        async () => {
          throw new SessionAuthenticationError("refused", code);
        },
      );

    // Google returns from consent as a top-level navigation, so this response
    // is what the person sees, not something a fetch handler can rescue.
    const expired = await callback("sign-in-required");
    expect(expired.status).toBe(302);
    expect(expired.headers.get("location")).toBe("https://dash.test/sign-in.html");

    // Signing in again cannot attach an Account, so redirecting there would
    // only rebuild the loop CL10 removed. This one stays a refusal.
    const noAccount = await callback("no-account");
    expect(noAccount.status).toBe(401);
    expect(noAccount.headers.get("x-angel-session")).toBe("no-account");
  });
});
