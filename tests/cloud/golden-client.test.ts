import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parseAngelDeploymentConfig } from "@smcllns/angel-core/cli";
import { fixtureConnectionSummaries, fakeCredentialVaults } from "./fake-vault";

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

const { runGoldenJourney } = await import(
  "../../src/golden-client"
);
const { handleControlRequest: handleControlRequestReal } = await import("../../src/workers/control");
const handleControlRequest = (request: Request, env: Record<string, unknown>) =>
  handleControlRequestReal(request, env as never, async () => ({
    accountId: (env.ACCOUNT_ID ?? env.DEMO_ACCOUNT_ID) as string,
    subject: "test-access-subject",
  }));
const { AccountRegistry } = await import("../../src/workers/account-registry");
const { handleGatewayRequest } = await import("../../src/workers/gateway");
const { handleBrokerRequest } = await import("../../src/workers/broker");
const { GateRuntime } = await import("../../src/workers/gate-object");

const repoRoot = join(import.meta.dir, "../..");

describe("canonical deterministic hosted golden journey", () => {
  test("enters through CLI and real HTTP Worker/service/DO/MCP boundaries", async () => {
    const harness = workerHarness();
    const report = await runGoldenJourney({
      repoRoot,
      controlBaseUrl: "https://control.example",
      gatewayBaseUrl: "https://gateway.golden.test",
      sessionToken: "session-token",
      adminToken: "admin-secret",
      fetch: harness.fetch,
      loadDeploymentConfig: (root, angelId) => parseAngelDeploymentConfig(readFileSync(
        join(root, `examples/angels/${angelId}/angel.example.json`),
        "utf8",
      )),
    });

    expect(report.accountId).toBe("acct_demo");
    expect(report.handle).toBe("golden-demo");
    expect(report.angels.gmailInboxZero).toMatchObject({
      slug: "gmail-inbox-zero",
      version: 1,
      toolCount: 21,
    });
    expect(report.angels.goldenAssistant).toMatchObject({
      slug: "golden-assistant",
      versions: [1, 2],
      versionToolCounts: [4, 5],
    });
    expect(report.angels.goldenAssistant.productionKeyFingerprint).toMatch(/^[a-f0-9]{12}$/);
    expect(report.angels.goldenAssistant.gmailConnectionRefs).toHaveLength(2);
    expect(new Set(report.angels.goldenAssistant.gmailConnectionRefs).size).toBe(2);
    expect(report.angels.goldenAssistant.gmailConnectionRefs.every((ref) => ref.startsWith("arc_")))
      .toBe(true);
    expect(JSON.stringify(report)).not.toContain("personal-google");
    expect(JSON.stringify(report)).not.toContain("work-google");
    expect(JSON.stringify(report)).not.toContain("con_personal_google");
    expect(JSON.stringify(report)).not.toContain("con_work_google");

    expect(report.checks).toEqual({
      builtFromCheckedInFiles: true,
      exactPreviewPromoted: true,
      coordinateAnswersMcp: true,
      legacyRouteStillAnswers: true,
      authenticatedDiscovery: true,
      canonicalRepeatedTool: true,
      eachConnectionInvokedSeparately: true,
      noImplicitFanout: true,
      oneConnectionPausedIndependently: true,
      pauseAllThenResumeOne: true,
      stableProductionKey: true,
      bothGateReceiptsMatch: true,
      wrongAccountDenied: true,
    });
    expect(report.trace).toEqual([
      "control:reset:management",
      "account:handle:@golden-demo",
      "gmail-inbox-zero:build:ANGEL.yaml",
      "gmail-inbox-zero:read:angel.json",
      "gmail-inbox-zero:ensure",
      "gmail-inbox-zero:publish:v1",
      "gmail-inbox-zero:deploy:preview:v1",
      "gmail-inbox-zero:promote:production:v1",
      "golden-assistant:build:ANGEL.yaml",
      "golden-assistant:read:angel.json",
      "golden-assistant:ensure",
      "golden-assistant:publish:v1",
      "golden-assistant:deploy:preview:v1",
      "golden-assistant:promote:production:v1",
      "golden-assistant:tools/list:production",
      "golden-assistant:tools/list:legacy-route",
      "golden-assistant:call:gmail.users.messages.list:connection:1",
      "golden-assistant:call:gmail.users.messages.list:connection:2",
      "golden-assistant:pause:gmail.users.messages.list:connection:2",
      "golden-assistant:pause:all",
      "golden-assistant:resume:gmail.users.messages.list:connection:1",
      "golden-assistant:resume:all",
      "golden-assistant:build:ANGEL.v2.yaml",
      "golden-assistant:publish:v2",
      "golden-assistant:deploy:preview:v2",
      "golden-assistant:promote:production:v2",
      "golden-assistant:call:gmail.users.labels.list:v2",
      "account-isolation:wrong-account-denied",
    ]);
    expect(harness.topLevelRequests.map(({ method, pathname }) => `${method} ${pathname}`))
      .toEqual(expect.arrayContaining([
        "POST /api/demo/reset",
        "GET /v1/accounts/acct_demo/connections",
        "PUT /v1/accounts/acct_demo/angels/gmail-inbox-zero",
        "PUT /v1/accounts/acct_demo/angels/golden-assistant",
        "POST /api/demo/action",
        "POST /@golden-demo/golden-assistant",
        "POST /v1/a/acct_demo/golden-assistant/production/mcp",
      ]));
    // Reset needs both: the admin token authorises the destructive action and
    // the session says who is asking. One `Authorization` header cannot carry
    // both, so the session goes in the cookie exactly as a browser sends it.
    const resetCall = harness.topLevelRequests.find(({ pathname }) => pathname === "/api/demo/reset");
    expect(resetCall).toBeDefined();
    expect(resetCall?.authorization).toBe("Bearer admin-secret");
    expect(resetCall?.cookie).toBe("__Secure-better-auth.session_token=session-token");
    // GOLDEN_SESSION_TOKEN reaches both paths as the SAME bytes: bearer on the
    // management API, cookie here. That is why the operator must supply the
    // signed cookie value rather than a bare token — Better Auth reads the
    // cookie with `getSignedCookie` and rejects an unsigned one, while its
    // bearer plugin accepts either, signing a bare token itself. A bare token
    // would pass /v1 and fail reset with 401, which is the confusing half.
    // README.md and docs/user-manual.md say so; this pins the shared value.
    const managementCall = harness.topLevelRequests.find(
      ({ pathname }) => pathname === "/v1/accounts/acct_demo/connections",
    );
    expect(managementCall?.authorization).toBe("Bearer session-token");
    expect(resetCall?.cookie).toBe(
      `__Secure-better-auth.session_token=${managementCall?.authorization?.slice("Bearer ".length)}`,
    );
    const ownerCalls = harness.topLevelRequests.filter(({ pathname }) =>
      !pathname.startsWith("/v1/a/") && !pathname.startsWith("/@"));
    expect(ownerCalls.length).toBeGreaterThan(0);
    // Nothing on the owner's own surfaces still presents a Cloudflare Access
    // service token; the application that read them was deleted.
    expect(ownerCalls.every(({ accessClientId }) => accessClientId === null)).toBe(true);
    expect(ownerCalls.every(({ accessClientSecret }) => accessClientSecret === null)).toBe(true);
    expect(ownerCalls.every(({ legacyAccessHeader }) => legacyAccessHeader === null)).toBe(true);
    // Every owner call carries the session, one way or the other.
    expect(ownerCalls.every(({ authorization, cookie }) =>
      authorization === "Bearer session-token"
      || cookie === "__Secure-better-auth.session_token=session-token")).toBe(true);
    expect(harness.internalRequests).toEqual(expect.arrayContaining([
      "gateway:/internal/gate",
      "broker:/internal/gate",
      "broker:/internal/invoke",
    ]));
    expect(harness.accountStorage.has("management")).toBe(true);
  });

});

function workerHarness() {
  const topLevelRequests: Array<{
    method: string;
    pathname: string;
    accessClientId: string | null;
    accessClientSecret: string | null;
    legacyAccessHeader: string | null;
    authorization: string | null;
    cookie: string | null;
  }> = [];
  const internalRequests: string[] = [];
  const accountStorage = new Map<string, unknown>();
  const gatewayGates = runtimeNamespace();
  const brokerGates = runtimeNamespace();
  const brokerEnv = {
    CONTROL_BROKER_TOKEN: "control-broker-secret",
    GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-secret",
    CREDENTIAL_VAULTS: fakeCredentialVaults(),
    GATES: brokerGates,
  };
  const broker = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = asRequest(input, init);
      internalRequests.push(`broker:${new URL(request.url).pathname}`);
      if (new URL(request.url).pathname === "/internal/connections") {
        return Response.json(fixtureConnectionSummaries("acct_demo"));
      }
      return handleBrokerRequest(request, brokerEnv as never, (_operation, args, connectionId) => ({
        mailbox: connectionId === "con_personal_google" ? "personal" : "work",
        arguments: args,
      }));
    },
  };
  const handleDirectory = new Map<string, string>();
  const gatewayEnv = {
    CONTROL_GATEWAY_TOKEN: "control-gateway-secret",
    GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-secret",
    GATES: gatewayGates,
    HANDLES: {
      getByName() {
        return {
          async bind(handle: string, accountId: string) {
            const existing = handleDirectory.get(handle);
            if (existing !== undefined) return existing === accountId ? "bound" : "conflict";
            handleDirectory.set(handle, accountId);
            return "bound";
          },
          async resolve(handle: string) {
            return handleDirectory.get(handle) ?? null;
          },
        };
      },
    },
    BROKER: broker,
  };
  const gateway = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = asRequest(input, init);
      internalRequests.push(`gateway:${new URL(request.url).pathname}`);
      return handleGatewayRequest(request, gatewayEnv as never);
    },
  };
  const registryEnv = {
    ACCOUNT_ID: "acct_demo",
    CONTROL_RESPONSE_KEK: "golden-response-replay-kek",
    CONTROL_GATEWAY_TOKEN: "control-gateway-secret",
    CONTROL_BROKER_TOKEN: "control-broker-secret",
    GATEWAY_BASE_URL: "https://gateway.golden.test",
    GATEWAY: gateway,
    BROKER: broker,
  };
  const registry = new AccountRegistry(storageContext(accountStorage) as never, registryEnv as never);
  const controlEnv = {
    ...registryEnv,
    DEMO_ADMIN_TOKEN: "admin-secret",
    GATEWAY_BASE_URL: "https://gateway.golden.test",
    ACCOUNTS: {
      getByName() {
        return registry;
      },
    },
    ASSETS: { fetch: async () => new Response("asset") },
  };

  return {
    accountStorage,
    internalRequests,
    topLevelRequests,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const request = asRequest(input, init);
      const url = new URL(request.url);
      topLevelRequests.push({
        method: request.method,
        pathname: url.pathname,
        accessClientId: request.headers.get("cf-access-client-id"),
        accessClientSecret: request.headers.get("cf-access-client-secret"),
        legacyAccessHeader: request.headers.get("x-angel-access"),
        authorization: request.headers.get("authorization"),
        cookie: request.headers.get("cookie"),
      });
      if (url.pathname.startsWith("/v1/a/") || url.pathname.startsWith("/@")) {
        return handleGatewayRequest(request, gatewayEnv as never);
      }
      return handleControlRequest(request, controlEnv as never);
    },
  };
}

function runtimeNamespace() {
  const runtimes = new Map<string, InstanceType<typeof GateRuntime>>();
  return {
    getByName(name: string) {
      let runtime = runtimes.get(name);
      if (runtime === undefined) {
        runtime = new GateRuntime(storageContext(new Map()) as never, {} as never);
        runtimes.set(name, runtime);
      }
      return runtime;
    },
  };
}

function storageContext(storage: Map<string, unknown>, name = "acct_demo") {
  return {
    id: { name },
    storage: {
      get: async (key: string) => structuredClone(storage.get(key)),
      put: async (key: string, value: unknown) => {
        storage.set(key, structuredClone(value));
      },
      delete: async (key: string) => storage.delete(key),
      deleteAll: async () => storage.clear(),
    },
  };
}

function asRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  return input instanceof Request ? new Request(input, init) : new Request(String(input), init);
}
