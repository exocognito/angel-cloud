import { describe, expect, mock, test } from "bun:test";
import type { SessionIdentity } from "../../src/session-identity";

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
    MANAGEMENT_API_TOKEN: "management-secret",
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
});
