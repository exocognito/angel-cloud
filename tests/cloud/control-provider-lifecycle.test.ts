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
const { DEFAULT_GOOGLE_PROVIDER_SCOPES } = await import("../../src/google-oauth");

describe("Access-authenticated browser Provider API", () => {
  test("lists, creates, authorizes, and completes a callback with a fixed server URI", async () => {
    const harness = makeHarness("access-user");
    const created = await request(harness, "/api/provider-apps", "POST", {
      providerAppId: "app_google",
      provider: "google",
      displayName: "Family Google",
      clientId: "client-id",
      clientSecret: "secret-never-read-by-control",
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual(harness.app);

    const listedApps = await request(harness, "/api/provider-apps");
    expect(listedApps.status).toBe(200);
    expect(await listedApps.json()).toEqual([harness.app]);

    const unsupportedAppRemoval = await request(harness, "/api/provider-apps/app_google", "DELETE");
    expect(unsupportedAppRemoval.status).toBe(501);

    const authorization = await request(harness, "/api/connections/authorize", "POST", {
      providerAppId: "app_google",
      nickname: "family-google",
    });
    expect(authorization.status).toBe(200);
    const authorizationUrl = new URL((await authorization.json() as { authorizationUrl: string }).authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("https://control.test/oauth/google/callback");
    expect(authorizationUrl.searchParams.get("state")).toBe(harness.authorizationState);
    expect(harness.authorizationBody).toMatchObject({
      accountId: "acct_m1",
      providerAppId: "app_google",
      state: harness.authorizationState,
      redirectUri: "https://control.test/oauth/google/callback",
    });

    const callback = await request(harness, `/oauth/google/callback?state=${encodeURIComponent(harness.authorizationState)}&code=google-code`);
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("https://control.test/?connection=connected");
    const callbackBody = harness.savedConnection;
    expect(callbackBody).toEqual(harness.connection);
    expect(harness.exchangeBody).toMatchObject({
      providerAppId: "app_google",
      connectionId: expect.stringMatching(/^con_/),
      nickname: "family-google",
      code: "google-code",
      codeVerifier: harness.codeVerifier,
      redirectUri: "https://control.test/oauth/google/callback",
    });
    expect(JSON.stringify(callbackBody)).not.toContain("stable-google-sub");
    expect(JSON.stringify(callbackBody)).not.toContain("refresh-token");
    const connections = await request(harness, "/api/connections");
    expect(await connections.json()).toEqual([harness.connection]);
    const connection = await request(harness, "/api/connections/con_google");
    expect(await connection.json()).toEqual(harness.connection);
    expect(harness.brokerRequests.every((request) => request.headers.get("authorization") === "Bearer control-broker")).toBe(true);
  });

  test("requires the callback Access identity bound into state, then supports reauth, revoke, and remove", async () => {
    const harness = makeHarness("access-user");
    await request(harness, "/api/provider-apps", "POST", {
      providerAppId: "app_google",
      provider: "google",
      displayName: "Family Google",
      clientId: "client-id",
      clientSecret: "secret",
    });
    await request(harness, "/api/connections/authorize", "POST", { providerAppId: "app_google", nickname: "family-google" });

    harness.subject = "different-access-user";
    const mismatch = await request(harness, `/oauth/google/callback?state=${encodeURIComponent(harness.authorizationState)}&code=google-code`);
    expect(mismatch.status).toBe(400);
    expect(harness.exchangeBody).toBeUndefined();

    harness.subject = "access-user";
    const callback = await request(harness, `/oauth/google/callback?state=${encodeURIComponent(harness.authorizationState)}&code=google-code`);
    expect(callback.status).toBe(303);

    const reauth = await request(harness, "/api/connections/con_google/reauthorize", "POST", {});
    expect(reauth.status).toBe(200);
    const reauthCallback = await request(harness, `/oauth/google/callback?state=${encodeURIComponent(harness.authorizationState)}&code=reauth-code`);
    expect(reauthCallback.status).toBe(303);
    expect(harness.exchangeBody?.flow).toBe("reauth");

    const revoked = await request(harness, "/api/connections/con_google/revoke", "POST", {});
    expect(revoked.status).toBe(200);
    expect((await revoked.json() as { health: string }).health).toBe("revoked");

    const removed = await request(harness, "/api/connections/con_google", "DELETE");
    expect(removed.status).toBe(200);
    expect(harness.brokerRequests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toContain("POST /internal/oauth/remove");
  });

  test("a Provider App created without scopes gets the default set; a configured set passes through", async () => {
    const harness = makeHarness("access-user");
    const unconfigured = await request(harness, "/api/provider-apps", "POST", {
      providerAppId: "app_google",
      provider: "google",
      displayName: "Family Google",
      clientId: "client-id",
      clientSecret: "secret",
    });
    expect(unconfigured.status).toBe(200);
    expect(await providerAppCreateBody(harness, 0)).toMatchObject({ scopes: [...DEFAULT_GOOGLE_PROVIDER_SCOPES] });

    const configured = await request(harness, "/api/provider-apps", "POST", {
      providerAppId: "app_calendar",
      provider: "google",
      displayName: "Calendar Google",
      clientId: "client-id",
      clientSecret: "secret",
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    expect(configured.status).toBe(200);
    expect(await providerAppCreateBody(harness, 1)).toMatchObject({
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
  });

  test("accepts a pre-scope Broker's five-key Provider App summaries and defaults their scopes", async () => {
    const harness = makeHarness("access-user");
    // A rolled-back or not-yet-deployed Broker still emits the old shape;
    // the Connections page must keep working through that window.
    const { scopes: _scopes, ...legacyApp } = harness.app;
    harness.legacyBrokerApp = legacyApp;
    const listed = await request(harness, "/api/provider-apps");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([
      { ...legacyApp, scopes: [...DEFAULT_GOOGLE_PROVIDER_SCOPES] },
    ]);
  });

  test("rejects a Provider App registration with a malformed scope list", async () => {
    for (const scopes of ["gmail.readonly", [], [""], ["two scopes"], [42], [null]]) {
      const harness = makeHarness("access-user");
      const response = await request(harness, "/api/provider-apps", "POST", {
        providerAppId: "app_google",
        provider: "google",
        displayName: "Family Google",
        clientId: "client-id",
        clientSecret: "secret",
        scopes,
      });
      expect(response.status).toBe(400);
      expect(harness.brokerRequests).toHaveLength(0);
    }
  });

  test("rejects a non-HTTPS or non-origin Control base URL", async () => {
    for (const baseUrl of ["http://control.test", "https://control.test/base", "https://control.test/?unsafe=1", "https://user:pass@control.test"]) {
      const harness = makeHarness("access-user");
      harness.env.CONTROL_BASE_URL = baseUrl;
      const response = await request(harness, "/api/connections/authorize", "POST", { providerAppId: "app_google", nickname: "family-google" });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "CONTROL_BASE_URL must be an HTTPS origin without a path, query, hash, or credentials" });
    }
  });
});

type Harness = ReturnType<typeof makeHarness>;

async function providerAppCreateBody(harness: Harness, index: number): Promise<Record<string, unknown>> {
  const creates = harness.brokerRequests.filter((request) =>
    request.method === "POST" && new URL(request.url).pathname === "/internal/provider-apps");
  return await creates[index]!.clone().json() as Record<string, unknown>;
}

function makeHarness(subject: string) {
  const app = { id: "app_google", accountId: "acct_m1", provider: "google" as const, displayName: "Family Google", clientIdSuffix: "client-id", scopes: [...DEFAULT_GOOGLE_PROVIDER_SCOPES] };
  const connection = { id: "con_google", accountId: "acct_m1", nickname: "family-google", providerAppId: "app_google", provider: "google" as const, displayName: "sam@example.test", grantedScopes: ["openid", "email"], health: "healthy" as const };
  const states = new Map<string, { accessSubject: string; providerAppId: string; connectionId: string; nickname: string; codeVerifier: string; redirectUri: string; flow: "create" | "reauth" }>();
  const brokerRequests: Request[] = [];
  const registryCommands: unknown[] = [];
  let savedConnection: typeof connection | undefined;
  let legacyBrokerApp: unknown;
  let authorizationState = "";
  let codeVerifier = "";
  let authorizationBody: Record<string, unknown> | undefined;
  let exchangeBody: Record<string, unknown> | undefined;
  const env: Record<string, unknown> = {
    ACCOUNT_ID: "acct_m1",
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    ACCESS_AUDIENCE: "audience",
    CONTROL_BASE_URL: "https://control.test",
    MANAGEMENT_API_TOKEN: "management-must-not-be-required",
    CONTROL_RESPONSE_KEK: "response-kek",
    CONTROL_GATEWAY_TOKEN: "gateway-token",
    CONTROL_BROKER_TOKEN: "control-broker",
    DEMO_ADMIN_TOKEN: "admin",
    GATEWAY_BASE_URL: "https://gateway.test",
    ASSETS: { fetch: async () => new Response("asset") },
    ACCOUNTS: {
      getByName() {
        return {
          async dispatchJson(command: any): Promise<string> {
            registryCommands.push(command);
            if (command.operation === "list_provider_apps") return JSON.stringify({ ok: true, value: [app] });
            if (command.operation === "save_provider_app") return JSON.stringify({ ok: true, value: command.summary });
            if (command.operation === "put_oauth_state") {
              codeVerifier = command.state.codeVerifier;
              states.set(command.state.state, { accessSubject: command.state.accessSubject, providerAppId: command.state.providerAppId, connectionId: command.state.connectionId, nickname: command.state.nickname, codeVerifier: command.state.codeVerifier, redirectUri: command.state.redirectUri, flow: command.state.flow });
              authorizationState = command.state.state;
              return JSON.stringify({ ok: true, value: null });
            }
            if (command.operation === "take_oauth_state") {
              const stored = states.get(command.state);
              if (stored === undefined || stored.accessSubject !== command.accessSubject || command.now >= 9999999999999) return JSON.stringify({ ok: false, status: 400, error: "OAuth state invalid" });
              states.delete(command.state);
              return JSON.stringify({ ok: true, value: { providerAppId: stored.providerAppId, connectionId: stored.connectionId, nickname: stored.nickname, codeVerifier: stored.codeVerifier, redirectUri: stored.redirectUri, flow: stored.flow } });
            }
            if (command.operation === "list_provider_connections") return JSON.stringify({ ok: true, value: savedConnection === undefined ? [] : [savedConnection] });
            if (command.operation === "reconcile_provider_apps") return JSON.stringify({ ok: true, value: command.providerApps });
            if (command.operation === "reconcile_provider_connections") return JSON.stringify({ ok: true, value: command.connections });
            if (command.operation === "save_provider_connection") { savedConnection = command.summary; return JSON.stringify({ ok: true, value: command.summary }); }
            if (command.operation === "remove_provider_connection") { savedConnection = undefined; return JSON.stringify({ ok: true, value: { removed: true } }); }
            throw new Error(`unexpected registry command ${command.operation}`);
          },
        };
      },
    },
    BROKER: {
      async fetch(input: string | URL | Request, init?: RequestInit) {
        const request = serviceRequest(input, init);
        brokerRequests.push(request.clone());
        const path = new URL(request.url).pathname;
        if (path === "/internal/provider-apps") return request.method === "GET" ? Response.json([legacyBrokerApp ?? app]) : Response.json(app);
        if (path === "/internal/connections") return Response.json([connection]);
        if (path === "/internal/oauth/authorize") {
          authorizationBody = await request.clone().json() as Record<string, unknown>;
          return Response.json({ authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent("https://control.test/oauth/google/callback")}&state=${encodeURIComponent(String(authorizationBody.state))}` });
        }
        if (path === "/internal/oauth/exchange") {
          exchangeBody = await request.clone().json() as Record<string, unknown>;
          return Response.json(savedConnection ?? connection);
        }
        if (path === "/internal/oauth/revoke") return Response.json({ ...connection, health: "revoked" });
        if (path === "/internal/oauth/remove") return Response.json({ removed: true });
        return Response.json({ error: "unexpected broker request" }, { status: 500 });
      },
    },
  };
  return {
    app,
    connection,
    brokerRequests,
    registryCommands,
    env,
    get authorizationState() { return authorizationState; },
    get authorizationBody() { return authorizationBody; },
    get exchangeBody() { return exchangeBody; },
    get savedConnection() { return savedConnection; },
    get codeVerifier() { return codeVerifier; },
    set subject(value: string) { subject = value; },
    get subject() { return subject; },
    set legacyBrokerApp(value: unknown) { legacyBrokerApp = value; },
  };
}

async function request(harness: Harness, path: string, method = "GET", body?: unknown): Promise<Response> {
  return handleControlRequest(new Request(`https://control.test${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), harness.env as never, async () => ({ accountId: "acct_m1", subject: harness.subject }));
}

function serviceRequest(input: string | URL | Request, init?: RequestInit): globalThis.Request {
  if (typeof input === "string" || input instanceof URL) return new globalThis.Request(input.toString(), init);
  return input as unknown as globalThis.Request;
}
