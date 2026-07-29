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
      managementToken: "management-secret",
      adminToken: "admin-secret",
      accessToken: JSON.stringify({
        "cf-access-client-id": "access-client-id",
        "cf-access-client-secret": "access-client-secret",
      }),
      fetch: harness.fetch,
      loadDeploymentConfig: (root, angelId) => parseAngelDeploymentConfig(readFileSync(
        join(root, `angels/${angelId}/angel.example.json`),
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
    const resetCall = harness.topLevelRequests.find(({ pathname }) => pathname === "/api/demo/reset");
    expect(resetCall).toBeDefined();
    expect(resetCall?.accessClientId).toBe("access-client-id");
    expect(resetCall?.accessClientSecret).toBe("access-client-secret");
    const accessProtectedCalls = harness.topLevelRequests.filter(({ pathname }) =>
      !pathname.startsWith("/v1/a/") && !pathname.startsWith("/@"));
    expect(accessProtectedCalls.length).toBeGreaterThan(0);
    expect(accessProtectedCalls.every(({ accessClientId }) => accessClientId === "access-client-id")).toBe(true);
    expect(accessProtectedCalls.every(({ accessClientSecret }) => accessClientSecret === "access-client-secret")).toBe(true);
    expect(accessProtectedCalls.every(({ legacyAccessHeader }) => legacyAccessHeader === null)).toBe(true);
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
    MANAGEMENT_API_TOKEN: "management-secret",
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

function storageContext(storage: Map<string, unknown>) {
  return {
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
