import { describe, expect, mock, test } from "bun:test";

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

const { handleControlRequest } = await import("../../src/workers/control");
const { managementConnectionsFromProviderSummaries, reconcileManagementConnections } = await import("../../src/provider-management");

describe("Provider custody reconciliation", () => {
  test("authorize accepts a nickname and generates the opaque Connection ID", async () => {
    const harness = controlHarness();
    const response = await request(harness, "/api/connections/authorize", "POST", {
      providerAppId: "app_google",
      nickname: "family-google",
    });

    expect(response.status).toBe(200);
    expect(harness.oauthState).toMatchObject({
      providerAppId: "app_google",
      nickname: "family-google",
      flow: "create",
    });
    expect(harness.oauthState?.connectionId).toMatch(/^con_/);
  });

  test("Connection list reconciles stale registry summaries from Broker custody", async () => {
    const harness = controlHarness({
      brokerConnections: [{
        id: "con_real",
        accountId: "acct_m1",
        nickname: "family-google",
        providerAppId: "app_google",
        provider: "google",
        displayName: "sam@example.test",
        grantedScopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/documents.readonly",
        ],
        health: "healthy",
      }],
      registryConnections: [{
        id: "con_ghost",
        accountId: "acct_m1",
        nickname: "old-google",
        providerAppId: "app_google",
        provider: "google",
        displayName: "old@example.test",
        grantedScopes: [],
        health: "healthy",
      }],
    });

    const response = await request(harness, "/api/connections");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(harness.brokerConnections);
    expect(harness.reconciledConnections).toEqual(harness.brokerConnections);
  });

  test("repairs a Broker-success/registry-failure divergence on the next list", async () => {
    const harness = controlHarness({
      brokerConnections: [connectionSummary("con_real", "family-google")],
      failReconciliation: true,
    });

    expect((await request(harness, "/api/connections")).status).toBe(503);
    const repaired = await request(harness, "/api/connections");
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toEqual(harness.brokerConnections);
    expect(harness.reconciledConnections).toEqual(harness.brokerConnections);
  });

  test("repairs revoked and removed Broker custody divergence on the next list", async () => {
    const harness = controlHarness({ brokerConnections: [connectionSummary("con_real", "family-google")] });
    expect((await request(harness, "/api/connections")).status).toBe(200);
    harness.brokerConnections[0] = {
      ...(harness.brokerConnections[0] as Record<string, unknown>),
      health: "revoked",
    };
    expect(await (await request(harness, "/api/connections")).json()).toEqual(harness.brokerConnections);
    harness.brokerConnections.splice(0);
    expect(await (await request(harness, "/api/connections")).json()).toEqual([]);
    expect(harness.reconciledConnections).toEqual([]);
  });

  test("reconciles an Account literally named acct_demo outside reset fixture initialization", async () => {
    const harness = controlHarness({
      accountId: "acct_demo",
      brokerConnections: [connectionSummary("con_real", "family-google")],
    });
    const response = await request(harness, "/api/connections");
    expect(response.status).toBe(200);
    expect(harness.reconciledConnections).toEqual(harness.brokerConnections);
  });

  test("reconciliation keeps an error tombstone for a removed deployed Connection", () => {
    const current = [{
      id: "con_real",
      accountId: "acct_m1",
      nickname: "family-google",
      identityLabel: "sam@example.test",
      credential: "google_oauth" as const,
      providers: ["gmail", "docs"],
      health: "healthy" as const,
    }];

    const expected = current[0]!;
    expect(reconcileManagementConnections("acct_m1", current, [], new Set(["con_real"]))).toEqual([{
      ...expected,
      health: "error",
    }]);
  });

  test("provider labels come from the adapter registry, not a literal scope list", () => {
    const providersFor = (grantedScopes: string[]) => managementConnectionsFromProviderSummaries("acct_m1", [{
      id: "con_x",
      accountId: "acct_m1",
      nickname: "x",
      providerAppId: "app_google",
      provider: "google",
      displayName: "x@example.test",
      grantedScopes,
      health: "healthy",
    }])[0]!.providers;

    expect(providersFor(["https://www.googleapis.com/auth/gmail.readonly"])).toEqual(["gmail"]);
    expect(providersFor(["https://www.googleapis.com/auth/documents.readonly"])).toEqual(["docs"]);
    expect(providersFor([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
    ])).toEqual(["docs", "gmail"]);
    // A broader grant than the historical constants still labels the provider:
    // gmail.modify can run registry gmail operations even though it is not the
    // readonly scope the old literal check looked for.
    expect(providersFor(["https://www.googleapis.com/auth/gmail.modify"])).toEqual(["gmail"]);
    // A grant no registry operation accepts labels nothing.
    expect(providersFor(["openid", "email"])).toEqual([]);
  });

  test("reconciliation handles an empty Account and rejects mixed-account summaries", () => {
    expect(reconcileManagementConnections("acct_m1", [], [], new Set())).toEqual([]);
    expect(() => reconcileManagementConnections("acct_m1", [], [{
      id: "con_other",
      accountId: "acct_other",
      nickname: "other",
      providerAppId: "app_google",
      provider: "google",
      displayName: "other@example.test",
      grantedScopes: [],
      health: "healthy",
    }], new Set())).toThrow("Provider Connection Account mismatch");
  });
});

function controlHarness(options: {
  accountId?: string;
  brokerConnections?: unknown[];
  registryConnections?: unknown[];
  failReconciliation?: boolean;
} = {}) {
  const oauthStates: unknown[] = [];
  const reconciled: unknown[] = [];
  const brokerConnections = options.brokerConnections ?? [];
  const registryConnections = options.registryConnections ?? [];
  let failReconciliation = options.failReconciliation ?? false;
  const registry = {
    async dispatchJson(command: any): Promise<string> {
      if (command.operation === "put_oauth_state") {
        oauthStates.push(command.state);
        return JSON.stringify({ ok: true, value: null });
      }
      if (command.operation === "list_provider_connections") {
        return JSON.stringify({ ok: true, value: registryConnections });
      }
      if (command.operation === "reconcile_provider_connections") {
        if (failReconciliation) {
          failReconciliation = false;
          return JSON.stringify({ ok: false, status: 503, error: "registry unavailable" });
        }
        reconciled.splice(0, reconciled.length, ...command.connections);
        return JSON.stringify({ ok: true, value: command.connections });
      }
      return JSON.stringify({ ok: true, value: [] });
    },
  };
  const env = {
    ACCOUNT_ID: options.accountId ?? "acct_m1",
    CONTROL_BASE_URL: "https://control.test",
    CONTROL_RESPONSE_KEK: "response-kek",
    CONTROL_GATEWAY_TOKEN: "gateway-token",
    CONTROL_BROKER_TOKEN: "control-broker",
    DEMO_ADMIN_TOKEN: "admin",
    GATEWAY_BASE_URL: "https://gateway.test",
    ACCOUNTS: { getByName: () => registry },
    ASSETS: { fetch: async () => new Response("asset") },
    BROKER: {
      async fetch(input: string | URL | Request) {
        const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
        if (url.pathname === "/internal/oauth/authorize") return Response.json({ authorizationUrl: "https://accounts.google.com/auth" });
        if (url.pathname === "/internal/connections") return Response.json(brokerConnections);
        return Response.json({ id: "app_google", accountId: options.accountId ?? "acct_m1", provider: "google", displayName: "Google", clientIdSuffix: "suffix" });
      },
    },
  };
  return {
    env,
    brokerConnections,
    get oauthState() { return oauthStates[0] as Record<string, unknown> | undefined; },
    get reconciledConnections() { return reconciled; },
  };
}

function connectionSummary(id: string, nickname: string) {
  return {
    id,
    accountId: "acct_m1",
    nickname,
    providerAppId: "app_google",
    provider: "google",
    displayName: "sam@example.test",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    health: "healthy",
  };
}

async function request(
  harness: ReturnType<typeof controlHarness>,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  return handleControlRequest(new Request(`https://control.test${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), harness.env as never, async () => ({ accountId: "acct_m1", subject: "access-user" }));
}
