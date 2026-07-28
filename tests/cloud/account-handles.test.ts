import { describe, expect, mock, test } from "bun:test";
import { sha256Hex } from "@smcllns/angel-core";
import {
  ACCOUNT_HANDLE_PATTERN,
  RESERVED_ACCOUNT_HANDLES,
  classifyAccountHandle,
  claimAccountHandle,
  emptyHandleDirectoryState,
  resolveAccountHandle,
  HandleError,
  HANDLE_DIRECTORY_REGISTRY,
} from "../../src/handles";

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

const { AccountRegistry } = await import("../../src/workers/account-registry");
const { handleControlRequest: handleControlRequestReal } = await import("../../src/workers/control");
const { handleGatewayRequest, HandleDirectory } = await import("../../src/workers/gateway");

const handleControlRequest = (request: Request, env: Record<string, unknown>) =>
  handleControlRequestReal(request, env as never, async () => ({
    accountId: env.ACCOUNT_ID as string,
    subject: "test-access-subject",
  }));

// PD 0001 account-segment grammar restricted by PD 0004 (four characters
// minimum) and the issue-#12 length cap.
describe("account handle grammar", () => {
  test("accepts grammar-conforming handles of four to thirty-two characters", () => {
    for (const handle of [
      "smcllns",
      "inbox-zero-4",
      "a234",
      "a".repeat(32),
      "exo-",
    ]) {
      expect(classifyAccountHandle(handle)).toEqual({ ok: true });
      expect(ACCOUNT_HANDLE_PATTERN.test(handle)).toBe(true);
    }
  });

  test("rejects handles outside the coordinate grammar as invalid", () => {
    for (const handle of [
      "",
      "Smcllns",
      "sam_collins",
      "acct_m1",
      "4chan",
      "-abcd",
      "sam.collins",
      "sam collins",
      "café-corner",
      "a".repeat(33),
      "@smcllns",
    ]) {
      expect(classifyAccountHandle(handle)).toMatchObject({ ok: false, kind: "invalid" });
    }
  });

  test("reserves one-to-three-character handles for the platform rather than calling them invalid", () => {
    for (const handle of ["x", "ai", "sam", "api"]) {
      expect(classifyAccountHandle(handle)).toMatchObject({ ok: false, kind: "reserved" });
    }
  });

  test("reserves exactly the authority words against impersonation", () => {
    expect([...RESERVED_ACCOUNT_HANDLES].sort()).toEqual([
      "admin",
      "angel",
      "angelmcp",
      "angels",
      "api",
      "billing",
      "help",
      "official",
      "root",
      "security",
      "staff",
      "support",
      "system",
      "team",
    ]);
    for (const handle of RESERVED_ACCOUNT_HANDLES) {
      expect(classifyAccountHandle(handle)).toMatchObject({ ok: false, kind: "reserved" });
    }
  });

  test("does not reserve product path words because the sigil already separates them", () => {
    for (const handle of ["pricing", "docs", "blog"]) {
      expect(classifyAccountHandle(handle)).toEqual({ ok: true });
    }
  });
});

describe("handle directory policy (PD 0004)", () => {
  test("first claim binds the handle and resolves canonically", () => {
    const { state, account } = claimAccountHandle(emptyHandleDirectoryState(), "acct_m1", "smcllns");
    expect(account).toEqual({ accountId: "acct_m1", handle: "smcllns", retiredHandle: null });
    expect(resolveAccountHandle(state, "smcllns")).toEqual({
      accountId: "acct_m1",
      canonicalHandle: "smcllns",
      retired: false,
    });
  });

  test("an unknown handle resolves to nothing", () => {
    expect(resolveAccountHandle(emptyHandleDirectoryState(), "nobody-here")).toBeNull();
  });

  test("re-claiming the current handle is a no-op", () => {
    const first = claimAccountHandle(emptyHandleDirectoryState(), "acct_m1", "smcllns");
    const second = claimAccountHandle(first.state, "acct_m1", "smcllns");
    expect(second.account).toEqual(first.account);
    expect(second.state).toEqual(first.state);
  });

  test("a handle held by another Account cannot be claimed", () => {
    const { state } = claimAccountHandle(emptyHandleDirectoryState(), "acct_m1", "smcllns");
    expect(() => claimAccountHandle(state, "acct_demo", "smcllns")).toThrow(HandleError);
    try {
      claimAccountHandle(state, "acct_demo", "smcllns");
    } catch (error) {
      expect((error as HandleError).status).toBe(409);
    }
  });

  test("a rename retires the old handle, which keeps resolving to the same Account", () => {
    const first = claimAccountHandle(emptyHandleDirectoryState(), "acct_m1", "smcllns");
    const renamed = claimAccountHandle(first.state, "acct_m1", "sam-collins");
    expect(renamed.account).toEqual({
      accountId: "acct_m1",
      handle: "sam-collins",
      retiredHandle: "smcllns",
    });
    expect(resolveAccountHandle(renamed.state, "sam-collins")).toEqual({
      accountId: "acct_m1",
      canonicalHandle: "sam-collins",
      retired: false,
    });
    expect(resolveAccountHandle(renamed.state, "smcllns")).toEqual({
      accountId: "acct_m1",
      canonicalHandle: "sam-collins",
      retired: true,
    });
  });

  test("a retired handle is never released to another Account", () => {
    const { state } = claimAccountHandle(
      claimAccountHandle(emptyHandleDirectoryState(), "acct_m1", "smcllns").state,
      "acct_m1",
      "sam-collins",
    );
    expect(() => claimAccountHandle(state, "acct_demo", "smcllns")).toThrow(HandleError);
  });

  test("one rename, ever: a second rename is rejected, including back to the retired handle", () => {
    const renamed = claimAccountHandle(
      claimAccountHandle(emptyHandleDirectoryState(), "acct_m1", "smcllns").state,
      "acct_m1",
      "sam-collins",
    );
    for (const next of ["third-name", "smcllns"]) {
      try {
        claimAccountHandle(renamed.state, "acct_m1", next);
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(HandleError);
        expect((error as HandleError).status).toBe(409);
      }
    }
  });

  test("claims carry the validation statuses: 400 invalid, 403 reserved", () => {
    for (const [handle, status] of [["Bad_Handle", 400], ["support", 403], ["sam", 403]] as const) {
      try {
        claimAccountHandle(emptyHandleDirectoryState(), "acct_m1", handle);
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(HandleError);
        expect((error as HandleError).status).toBe(status);
      }
    }
  });
});

function directoryRegistry() {
  const storage = new Map<string, unknown>();
  const registry = new AccountRegistry({
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => storage.set(key, structuredClone(value)),
    },
  } as never, { ACCOUNT_ID: "acct_demo" } as never);
  return { registry, storage };
}

describe("AccountRegistry handle operations", () => {
  test("claims and resolves through the registry, persisting directory state", async () => {
    const { registry, storage } = directoryRegistry();
    const claim = JSON.parse(await registry.dispatchJson({
      operation: "claim_handle",
      accountId: "acct_m1",
      handle: "smcllns",
    } as never));
    expect(claim).toEqual({
      ok: true,
      value: { accountId: "acct_m1", handle: "smcllns", retiredHandle: null },
    });
    expect(storage.get("handles")).toMatchObject({ claims: { smcllns: "acct_m1" } });

    const resolved = JSON.parse(await registry.dispatchJson({
      operation: "resolve_handle",
      handle: "smcllns",
    } as never));
    expect(resolved).toEqual({
      ok: true,
      value: { accountId: "acct_m1", canonicalHandle: "smcllns", retired: false },
    });
  });

  test("maps policy failures to statuses and unknown handles to 404", async () => {
    const { registry } = directoryRegistry();
    const reserved = JSON.parse(await registry.dispatchJson({
      operation: "claim_handle",
      accountId: "acct_m1",
      handle: "support",
    } as never));
    expect(reserved).toMatchObject({ ok: false, status: 403 });

    const missing = JSON.parse(await registry.dispatchJson({
      operation: "resolve_handle",
      handle: "nobody-here",
    } as never));
    expect(missing).toMatchObject({ ok: false, status: 404 });
  });
});

function controlHarness() {
  const directory = directoryRegistry();
  const accountCommands: unknown[] = [];
  const gatewayPushes: Array<{ path: string; authorization: string | null; body: unknown }> = [];
  const env = {
    ACCOUNT_ID: "acct_demo",
    MANAGEMENT_API_TOKEN: "management-secret",
    CONTROL_RESPONSE_KEK: "response-replay-kek",
    DEMO_ADMIN_TOKEN: "admin-secret",
    CONTROL_GATEWAY_TOKEN: "control-gateway-secret",
    CONTROL_BROKER_TOKEN: "control-broker-secret",
    GATEWAY_BASE_URL: "https://gateway.example",
    ACCOUNTS: {
      getByName(name: string) {
        if (name === HANDLE_DIRECTORY_REGISTRY) return directory.registry;
        expect(name).toBe("acct_demo");
        return {
          async dispatchJson(input: unknown) {
            accountCommands.push(input);
            return JSON.stringify({ ok: true, value: { routed: true } });
          },
        };
      },
    },
    GATEWAY: {
      async fetch(input: string | URL | Request, init?: RequestInit) {
        const request = input instanceof Request ? input : new Request(String(input), init);
        gatewayPushes.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return Response.json({ bound: true });
      },
    },
    ASSETS: { fetch: async () => new Response("asset") },
    BROKER: { fetch: async () => { throw new Error("Broker must not be reached"); } },
  };
  return { env, directory, accountCommands, gatewayPushes };
}

const managementHeaders = {
  authorization: "Bearer management-secret",
  "content-type": "application/json",
};

describe("Control handle routes", () => {
  test("PUT /v1/accounts/{id}/handle claims the handle and pushes the binding to the Gateway", async () => {
    const harness = controlHarness();
    const response = await handleControlRequest(new Request(
      "https://control.test/v1/accounts/acct_demo/handle",
      { method: "PUT", headers: managementHeaders, body: JSON.stringify({ handle: "smcllns" }) },
    ), harness.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accountId: "acct_demo",
      handle: "smcllns",
      retiredHandle: null,
    });
    expect(harness.gatewayPushes).toEqual([{
      path: "/internal/handles",
      authorization: "Bearer control-gateway-secret",
      body: { handle: "smcllns", accountId: "acct_demo" },
    }]);
  });

  test("rejects reserved and invalid handles with their statuses", async () => {
    const harness = controlHarness();
    for (const [handle, status] of [["support", 403], ["sam", 403], ["Bad_Handle", 400]] as const) {
      const response = await handleControlRequest(new Request(
        "https://control.test/v1/accounts/acct_demo/handle",
        { method: "PUT", headers: managementHeaders, body: JSON.stringify({ handle }) },
      ), harness.env);
      expect(response.status).toBe(status);
    }
    expect(harness.gatewayPushes).toEqual([]);
  });

  test("refuses to set a handle for an Account the caller is not signed in to", async () => {
    const harness = controlHarness();
    const response = await handleControlRequest(new Request(
      "https://control.test/v1/accounts/acct_other/handle",
      { method: "PUT", headers: managementHeaders, body: JSON.stringify({ handle: "smcllns" }) },
    ), harness.env);
    expect(response.status).toBe(404);
    expect(harness.gatewayPushes).toEqual([]);
  });

  test("requires the management bearer", async () => {
    const harness = controlHarness();
    const response = await handleControlRequest(new Request(
      "https://control.test/v1/accounts/acct_demo/handle",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "smcllns" }),
      },
    ), harness.env);
    expect(response.status).toBe(401);
  });

  test("GET /v1/handles/{handle} resolves current and retired names, 404 for unknown", async () => {
    const harness = controlHarness();
    for (const handle of ["smcllns", "sam-collins"]) {
      await handleControlRequest(new Request(
        "https://control.test/v1/accounts/acct_demo/handle",
        { method: "PUT", headers: managementHeaders, body: JSON.stringify({ handle }) },
      ), harness.env);
    }
    const retired = await handleControlRequest(new Request(
      "https://control.test/v1/handles/smcllns",
      { headers: managementHeaders },
    ), harness.env);
    expect(await retired.json()).toEqual({
      accountId: "acct_demo",
      canonicalHandle: "sam-collins",
      retired: true,
    });
    const unknown = await handleControlRequest(new Request(
      "https://control.test/v1/handles/nobody-here",
      { headers: managementHeaders },
    ), harness.env);
    expect(unknown.status).toBe(404);
  });

  test("a handle names the Account on /v1/accounts paths", async () => {
    const harness = controlHarness();
    await handleControlRequest(new Request(
      "https://control.test/v1/accounts/acct_demo/handle",
      { method: "PUT", headers: managementHeaders, body: JSON.stringify({ handle: "smcllns" }) },
    ), harness.env);
    const response = await handleControlRequest(new Request(
      "https://control.test/v1/accounts/smcllns/angels/golden-assistant",
      { headers: managementHeaders },
    ), harness.env);
    expect(response.status).toBe(200);
    expect(harness.accountCommands).toEqual([{
      operation: "get_angel_by_slug",
      accountId: "acct_demo",
      slug: "golden-assistant",
    }]);
  });

  test("surfaces a failed Gateway binding push as a 502 after the claim commits", async () => {
    const harness = controlHarness();
    harness.env.GATEWAY = { fetch: async () => Response.json({ error: "boom" }, { status: 500 }) };
    const response = await handleControlRequest(new Request(
      "https://control.test/v1/accounts/acct_demo/handle",
      { method: "PUT", headers: managementHeaders, body: JSON.stringify({ handle: "smcllns" }) },
    ), harness.env);
    expect(response.status).toBe(502);
    // The claim is committed; retrying the same PUT is a no-op claim plus a fresh push.
    const resolved = JSON.parse(await harness.directory.registry.dispatchJson({
      operation: "resolve_handle",
      handle: "smcllns",
    } as never));
    expect(resolved).toMatchObject({ ok: true, value: { accountId: "acct_demo" } });
  });
});

function directoryObject() {
  const storage = new Map<string, unknown>();
  const directory = new HandleDirectory({
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => storage.set(key, structuredClone(value)),
    },
  } as never, {} as never);
  return { directory, storage };
}

describe("Gateway handle directory", () => {
  test("binds idempotently and refuses to rebind a name to a different Account", async () => {
    const { directory } = directoryObject();
    expect(await directory.bind("smcllns", "acct_m1")).toBe("bound");
    expect(await directory.bind("smcllns", "acct_m1")).toBe("bound");
    expect(await directory.bind("smcllns", "acct_demo")).toBe("conflict");
    expect(await directory.resolve("smcllns")).toBe("acct_m1");
    expect(await directory.resolve("nobody-here")).toBeNull();
  });

  test("POST /internal/handles requires the control token and binds", async () => {
    const { directory } = directoryObject();
    const env = {
      CONTROL_GATEWAY_TOKEN: "control-gateway",
      GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-invoke",
      GATES: { getByName: () => { throw new Error("gate state must not be reached"); } },
      HANDLES: { getByName: () => directory },
    } as never;
    const bind = (token?: string, body?: unknown) => handleGatewayRequest(new Request(
      "https://gateway.test/internal/handles",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body ?? { handle: "smcllns", accountId: "acct_m1" }),
      },
    ), env);

    expect((await bind("wrong-token")).status).toBe(401);
    expect((await bind("control-gateway")).status).toBe(200);
    expect(await directory.resolve("smcllns")).toBe("acct_m1");
    expect((await bind("control-gateway", { handle: "smcllns", accountId: "acct_other" })).status).toBe(409);
    expect((await bind("control-gateway", { handle: "smcllns" })).status).toBe(400);
  });
});

describe("Gateway handle resolution on the MCP request path", () => {
  const gatewayEnv = async (resolutions: Record<string, string>) => {
    const gateNames: string[] = [];
    const state = { gatewayKeyHash: await sha256Hex("angel-key") };
    return {
      names: gateNames,
      env: {
        CONTROL_GATEWAY_TOKEN: "control-gateway",
        GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-invoke",
        GATES: {
          getByName(name: string) {
            gateNames.push(name);
            return { snapshot: async () => state };
          },
        },
        HANDLES: {
          getByName: () => ({ resolve: async (handle: string) => resolutions[handle] ?? null }),
        },
      } as never,
    };
  };
  const initialize = (account: string) => new Request(
    `https://gateway.test/v1/a/${account}/angel_demo/production/mcp`,
    {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: "Bearer angel-key",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    },
  );

  test("a handle resolves to the canonical Account runtime", async () => {
    const { env, names } = await gatewayEnv({ smcllns: "acct_m1" });
    const response = await handleGatewayRequest(initialize("smcllns"), env);
    expect(response.status).toBe(200);
    expect(names).toEqual(["acct_m1:angel_demo:production"]);
  });

  test("a retired handle answers MCP directly with 200 on the same runtime — no redirect", async () => {
    const { env, names } = await gatewayEnv({ "old-name": "acct_m1" });
    const response = await handleGatewayRequest(initialize("old-name"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(names).toEqual(["acct_m1:angel_demo:production"]);
  });

  test("an unknown handle-shaped Account segment is 404 before any gate state is read", async () => {
    const { env, names } = await gatewayEnv({});
    const response = await handleGatewayRequest(initialize("ghost-name"), env);
    expect(response.status).toBe(404);
    expect(names).toEqual([]);
  });

  test("an internal acct_* segment never consults the handle directory", async () => {
    const { env, names } = await gatewayEnv({});
    (env as { HANDLES: unknown }).HANDLES = {
      getByName: () => { throw new Error("handle directory must not be reached"); },
    };
    const response = await handleGatewayRequest(initialize("acct_m1"), env);
    expect(response.status).toBe(200);
    expect(names).toEqual(["acct_m1:angel_demo:production"]);
  });
});
