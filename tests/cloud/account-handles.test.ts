import { describe, expect, mock, test } from "bun:test";
import { sha256Hex } from "@smcllns/angel-core";
import {
  ACCOUNT_HANDLE_PATTERN,
  RESERVED_ACCOUNT_HANDLES,
  classifyAccountHandle,
  isInternalAccountId,
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
const { SessionAuthenticationError } = await import("../../src/session-identity");

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

  test("recognizes internal acct_* identifiers, which the grammar can never match", () => {
    expect(isInternalAccountId("acct_m1")).toBe(true);
    expect(isInternalAccountId("acct_demo")).toBe(true);
    for (const value of ["smcllns", "m1", "acct-m1", ""]) {
      expect(isInternalAccountId(value)).toBe(false);
    }
  });
});

function directoryRegistry() {
  const storage = new Map<string, unknown>();
  const registry = new AccountRegistry({
    id: { name: "acct_demo" },
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "object") {
          for (const [entryKey, entryValue] of Object.entries(key)) {
            storage.set(entryKey, structuredClone(entryValue));
          }
        } else {
          storage.set(key, structuredClone(value));
        }
      },
    },
  } as never, { ACCOUNT_ID: "acct_demo" } as never);
  const claim = async (accountId: string, handle: string) =>
    JSON.parse(await registry.dispatchJson({ operation: "claim_handle", accountId, handle } as never));
  const resolve = async (handle: string) =>
    JSON.parse(await registry.dispatchJson({ operation: "resolve_handle", handle } as never));
  return { registry, storage, claim, resolve };
}

describe("handle directory policy (PD 0004)", () => {
  test("first claim binds the handle, persists per-key entries, and resolves canonically", async () => {
    const directory = directoryRegistry();
    expect(await directory.claim("acct_m1", "smcllns")).toEqual({
      ok: true,
      value: { accountId: "acct_m1", handle: "smcllns", retiredHandle: null },
    });
    // One key per claimed name and per account: no single record accumulates
    // the whole platform, and resolution reads exactly one key.
    expect(directory.storage.get("handle:smcllns")).toBe("acct_m1");
    expect(directory.storage.get("account:acct_m1")).toEqual({ handle: "smcllns", retiredHandle: null });
    expect(await directory.resolve("smcllns")).toEqual({
      ok: true,
      value: { accountId: "acct_m1", canonicalHandle: "smcllns", retired: false },
    });
  });

  test("an unknown handle resolves to 404", async () => {
    const directory = directoryRegistry();
    expect(await directory.resolve("nobody-here")).toMatchObject({ ok: false, status: 404 });
  });

  test("re-claiming the current handle is a no-op", async () => {
    const directory = directoryRegistry();
    const first = await directory.claim("acct_m1", "smcllns");
    const second = await directory.claim("acct_m1", "smcllns");
    expect(second).toEqual(first);
  });

  test("a handle held by another Account cannot be claimed", async () => {
    const directory = directoryRegistry();
    await directory.claim("acct_m1", "smcllns");
    expect(await directory.claim("acct_demo", "smcllns")).toMatchObject({ ok: false, status: 409 });
  });

  test("a rename retires the old handle, which keeps resolving to the same Account", async () => {
    const directory = directoryRegistry();
    await directory.claim("acct_m1", "smcllns");
    expect(await directory.claim("acct_m1", "sam-collins")).toEqual({
      ok: true,
      value: { accountId: "acct_m1", handle: "sam-collins", retiredHandle: "smcllns" },
    });
    expect(await directory.resolve("sam-collins")).toEqual({
      ok: true,
      value: { accountId: "acct_m1", canonicalHandle: "sam-collins", retired: false },
    });
    expect(await directory.resolve("smcllns")).toEqual({
      ok: true,
      value: { accountId: "acct_m1", canonicalHandle: "sam-collins", retired: true },
    });
  });

  test("a retired handle is never released to another Account", async () => {
    const directory = directoryRegistry();
    await directory.claim("acct_m1", "smcllns");
    await directory.claim("acct_m1", "sam-collins");
    expect(await directory.claim("acct_demo", "smcllns")).toMatchObject({ ok: false, status: 409 });
  });

  test("one rename, ever: a second rename is rejected, including back to the retired handle", async () => {
    const directory = directoryRegistry();
    await directory.claim("acct_m1", "smcllns");
    await directory.claim("acct_m1", "sam-collins");
    for (const next of ["third-name", "smcllns"]) {
      expect(await directory.claim("acct_m1", next)).toMatchObject({ ok: false, status: 409 });
    }
  });

  test("claims carry the validation statuses: 400 invalid, 403 reserved", async () => {
    const directory = directoryRegistry();
    for (const [handle, status] of [["Bad_Handle", 400], ["support", 403], ["sam", 403]] as const) {
      expect(await directory.claim("acct_m1", handle)).toMatchObject({ ok: false, status });
    }
  });

  test("unclaimable names never touch storage: no over-long Durable Object keys", async () => {
    // Durable Object storage keys cap at 2 KiB; an unclaimable name must be
    // rejected or missed before any storage read, on claim and resolve alike.
    const storage = new Map<string, unknown>();
    const guard = (key: string) => {
      if (key.length > 2048) throw new Error("over-long Durable Object storage key");
    };
    const registry = new AccountRegistry({
      id: { name: "acct_demo" },
      storage: {
        get: async (key: string) => { guard(key); return storage.get(key); },
        put: async (key: string | Record<string, unknown>, value?: unknown) => {
          if (typeof key === "object") {
            for (const [entryKey, entryValue] of Object.entries(key)) {
              guard(entryKey);
              storage.set(entryKey, structuredClone(entryValue));
            }
          } else {
            guard(key);
            storage.set(key, structuredClone(value));
          }
        },
      },
    } as never, { ACCOUNT_ID: "acct_demo" } as never);
    const long = "a".repeat(4000);
    const claim = JSON.parse(await registry.dispatchJson({
      operation: "claim_handle",
      accountId: "acct_m1",
      handle: long,
    } as never));
    expect(claim).toMatchObject({ ok: false, status: 400 });
    const resolved = JSON.parse(await registry.dispatchJson({
      operation: "resolve_handle",
      handle: long,
    } as never));
    expect(resolved).toMatchObject({ ok: false, status: 404 });
  });

  test("Object.prototype names are ordinary handles, not phantom claims", async () => {
    const directory = directoryRegistry();
    expect(await directory.resolve("constructor")).toMatchObject({ ok: false, status: 404 });
    expect(await directory.claim("acct_m1", "constructor")).toEqual({
      ok: true,
      value: { accountId: "acct_m1", handle: "constructor", retiredHandle: null },
    });
    expect(await directory.resolve("constructor")).toEqual({
      ok: true,
      value: { accountId: "acct_m1", canonicalHandle: "constructor", retired: false },
    });
  });
});

function controlHarness() {
  const directory = directoryRegistry();
  const accountCommands: unknown[] = [];
  const gatewayPushes: Array<{ path: string; authorization: string | null; body: unknown }> = [];
  const env = {
    ACCOUNT_ID: "acct_demo",
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
            const operation = (input as { operation: string }).operation;
            // The Worker rewrites angel views into the legacy dialect, so this
            // read must return a view-shaped value.
            if (operation === "get_angel_by_slug") {
              const view = (environment: string) => ({
                environment,
                keyFingerprint: "sha256:stub",
                activeDeployment: null,
                pendingDeployment: null,
                repair: null,
                availability: { defaultEnabled: true, toolOverrides: {}, connectionOverrides: {}, revision: 0 },
                pendingAvailability: null,
              });
              return JSON.stringify({ ok: true, value: {
                id: "ang_1",
                accountId: "acct_demo",
                slug: "golden-assistant",
                environments: { preview: view("preview"), production: view("production") },
              } });
            }
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

  test("answers 404 for another Account's handle, as if it were not there", async () => {
    // G07: cross-Account resources are indistinguishable from absent ones. The
    // session names the Account; naming a different one in the path must not
    // reveal that it exists. This is what scopes the management surface — the
    // shared bearer it replaced named no Account and so could not.
    const harness = controlHarness();
    const response = await handleControlRequestReal(new Request(
      "https://control.test/v1/accounts/acct_somebody_else/handle",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "smcllns" }),
      },
    ), harness.env as never, async () => ({
      accountId: "acct_demo",
      subject: "test-session-subject",
    }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  test("refuses a caller with no session before touching the directory", async () => {
    const harness = controlHarness();
    const response = await handleControlRequestReal(new Request(
      "https://control.test/v1/accounts/acct_demo/handle",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "smcllns" }),
      },
    ), harness.env as never, async () => {
      throw new SessionAuthenticationError("sign-in required");
    });
    expect(response.status).toBe(401);
  });

  test("a rename pushes the new binding and re-pushes the retired one, in order", async () => {
    const harness = controlHarness();
    for (const handle of ["smcllns", "sam-collins"]) {
      await handleControlRequest(new Request(
        "https://control.test/v1/accounts/acct_demo/handle",
        { method: "PUT", headers: managementHeaders, body: JSON.stringify({ handle }) },
      ), harness.env);
    }
    expect(harness.gatewayPushes.map((push) => push.body)).toEqual([
      { handle: "smcllns", accountId: "acct_demo" },
      { handle: "sam-collins", accountId: "acct_demo" },
      { handle: "smcllns", accountId: "acct_demo" },
    ]);
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

  test("GET /v1/handles/{handle} does not resolve another Account's handle", async () => {
    const harness = controlHarness();
    // Another Account's claim, planted directly in the shared directory.
    await harness.directory.registry.dispatchJson({
      operation: "claim_handle",
      accountId: "acct_other",
      handle: "somebody-else",
    } as never);
    const response = await handleControlRequest(new Request(
      "https://control.test/v1/handles/somebody-else",
      { headers: managementHeaders },
    ), harness.env);
    expect(response.status).toBe(404);
  });

  test("another Account's handle on a management route is 404 and dispatches nothing", async () => {
    const harness = controlHarness();
    await harness.directory.registry.dispatchJson({
      operation: "claim_handle",
      accountId: "acct_other",
      handle: "somebody-else",
    } as never);
    const response = await handleControlRequest(new Request(
      "https://control.test/v1/accounts/somebody-else/angels/golden-assistant",
      { headers: managementHeaders },
    ), harness.env);
    expect(response.status).toBe(404);
    expect(harness.accountCommands).toEqual([]);
  });

  test("a malformed account segment encoding is a 400 client error, not a 500", async () => {
    const harness = controlHarness();
    for (const [path, options] of [
      ["/v1/accounts/sm%zzllns/angels/golden-assistant", { headers: managementHeaders }],
      ["/v1/accounts/sm%zzllns/handle", {
        method: "PUT",
        headers: managementHeaders,
        body: JSON.stringify({ handle: "smcllns" }),
      }],
      ["/v1/handles/sm%zz", { headers: managementHeaders }],
    ] as const) {
      const response = await handleControlRequest(
        new Request(`https://control.test${path}`, options as RequestInit),
        harness.env,
      );
      expect(response.status).toBe(400);
    }
  });

  test("GET /v1/handles/{handle} answers unclaimed and unowned names with one identical 404", async () => {
    const harness = controlHarness();
    await harness.directory.registry.dispatchJson({
      operation: "claim_handle",
      accountId: "acct_other",
      handle: "somebody-else",
    } as never);
    const bodies: unknown[] = [];
    for (const handle of ["nobody-here", "somebody-else"]) {
      const response = await handleControlRequest(new Request(
        `https://control.test/v1/handles/${handle}`,
        { headers: managementHeaders },
      ), harness.env);
      expect(response.status).toBe(404);
      bodies.push(await response.json());
    }
    // Identical bodies, or the error message becomes a which-names-are-taken oracle.
    expect(bodies[0]).toEqual(bodies[1]);
  });

  test("an unclaimably long segment never reaches the directory and stays a plain 404", async () => {
    // A segment past the claimable cap can never be a handle; probing the
    // directory with it would build an over-long Durable Object storage key
    // and surface a 500 instead of the normal not-found path.
    const harness = controlHarness();
    harness.env.ACCOUNTS = {
      getByName(name: string) {
        if (name === HANDLE_DIRECTORY_REGISTRY) {
          throw new Error("directory must not be probed with unclaimable segments");
        }
        return { dispatchJson: async () => JSON.stringify({ ok: true, value: {} }) };
      },
    };
    const response = await handleControlRequest(new Request(
      `https://control.test/v1/accounts/${"a".repeat(4000)}/angels/golden-assistant`,
      { headers: managementHeaders },
    ), harness.env);
    expect(response.status).toBe(404);
  });

  test("refuses a session whose Account is handle-shaped", async () => {
    // The Account arrives from the verifier below, not from configuration, so
    // the old ACCOUNT_ID mutation here drove nothing once Control stopped
    // reading it.
    const harness = controlHarness();
    const response = await handleControlRequestReal(new Request(
      "https://control.test/v1/handles/smcllns",
      { headers: managementHeaders },
    ), harness.env as never, async () => ({ accountId: "m1", subject: "test-access-subject" }));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("acct_"),
    });
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
    expect(harness.accountCommands).toEqual([
      // The claim also pushes the display copy to the Account's registry.
      { operation: "record_handle", accountId: "acct_demo", handle: "smcllns" },
      {
        operation: "get_angel_by_slug",
        accountId: "acct_demo",
        slug: "golden-assistant",
      },
    ]);
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

  test("a diverged Gateway binding (409) is named as such, not presented as retryable", async () => {
    const harness = controlHarness();
    harness.env.GATEWAY = {
      fetch: async () => Response.json({ error: "handle is bound to another Account" }, { status: 409 }),
    };
    const response = await handleControlRequest(new Request(
      "https://control.test/v1/accounts/acct_demo/handle",
      { method: "PUT", headers: managementHeaders, body: JSON.stringify({ handle: "smcllns" }) },
    ), harness.env);
    expect(response.status).toBe(500);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("diverge");
    expect(body.error).not.toContain("retry the request");
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
    // Defense in depth against a misbehaving Control: an unclaimable name must
    // never become a replica storage key either.
    expect((await bind("control-gateway", { handle: "a".repeat(4000), accountId: "acct_m1" })).status).toBe(400);
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

  test("an unknown handle-shaped Account segment is 401, indistinguishable from a bad key", async () => {
    // 404 here would let an unauthenticated caller probe which handles exist;
    // a wrong key against an existing handle answers 401, so this must too.
    const { env, names } = await gatewayEnv({});
    const response = await handleGatewayRequest(initialize("ghost-name"), env);
    expect(response.status).toBe(401);
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

  test("an unclaimably long or short segment is 401 without touching the directory", async () => {
    // Past the cap it cannot be a claimed handle, and probing the directory
    // would build an over-long Durable Object storage key that errors as 500 —
    // a distinguishable answer on the path the 401 rule just closed.
    const { env, names } = await gatewayEnv({});
    (env as { HANDLES: unknown }).HANDLES = {
      getByName: () => { throw new Error("directory must not be probed with unclaimable segments"); },
    };
    for (const segment of ["a".repeat(4000), "ab"]) {
      const response = await handleGatewayRequest(initialize(segment), env);
      expect(response.status).toBe(401);
    }
    expect(names).toEqual([]);
  });

  test("a percent-encoded handle segment resolves after decoding; malformed encoding is 400", async () => {
    const { env, names } = await gatewayEnv({ smcllns: "acct_m1" });
    const encoded = await handleGatewayRequest(initialize("sm%63llns"), env);
    expect(encoded.status).toBe(200);
    expect(names).toEqual(["acct_m1:angel_demo:production"]);

    const malformed = await handleGatewayRequest(initialize("sm%zzllns"), env);
    expect(malformed.status).toBe(400);
  });

  test("an unbound Object.prototype name is unknown (401), not a phantom Account", async () => {
    const storage = new Map<string, unknown>();
    const directory = new HandleDirectory({
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => storage.set(key, structuredClone(value)),
      },
    } as never, {} as never);
    const { env, names } = await gatewayEnv({});
    (env as { HANDLES: unknown }).HANDLES = { getByName: () => directory };
    const response = await handleGatewayRequest(initialize("constructor"), env);
    expect(response.status).toBe(401);
    expect(names).toEqual([]);
  });
});

describe("rename end to end: Control pushes feed the Gateway replica", () => {
  test("after a rename, the retired coordinate answers MCP 200 on the canonical runtime", async () => {
    const harness = controlHarness();
    for (const handle of ["smcllns", "sam-collins"]) {
      await handleControlRequest(new Request(
        "https://control.test/v1/accounts/acct_demo/handle",
        { method: "PUT", headers: managementHeaders, body: JSON.stringify({ handle }) },
      ), harness.env);
    }

    // Apply exactly what Control pushed to a real Gateway directory.
    const storage = new Map<string, unknown>();
    const directory = new HandleDirectory({
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => storage.set(key, structuredClone(value)),
      },
    } as never, {} as never);
    for (const push of harness.gatewayPushes) {
      const { handle, accountId } = push.body as { handle: string; accountId: string };
      expect(await directory.bind(handle, accountId)).toBe("bound");
    }

    const gateNames: string[] = [];
    const state = { gatewayKeyHash: await sha256Hex("angel-key") };
    const env = {
      CONTROL_GATEWAY_TOKEN: "control-gateway",
      GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-invoke",
      GATES: {
        getByName(name: string) {
          gateNames.push(name);
          return { snapshot: async () => state };
        },
      },
      HANDLES: { getByName: () => directory },
    } as never;
    for (const segment of ["sam-collins", "smcllns"]) {
      const response = await handleGatewayRequest(new Request(
        `https://gateway.test/v1/a/${segment}/angel_demo/production/mcp`,
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
      ), env);
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    }
    expect(gateNames).toEqual([
      "acct_demo:angel_demo:production",
      "acct_demo:angel_demo:production",
    ]);
  });
});
