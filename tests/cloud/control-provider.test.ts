import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class { protected readonly ctx: unknown; protected readonly env: unknown; constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; } } }));

const { handleControlRequest } = await import("../../src/workers/control");

describe("Control Provider App and Connection custody routes", () => {
  test("creates a Provider App write-only through Broker and stores only its safe summary", async () => {
    const registryCommands: unknown[] = [];
    const brokerRequests: Request[] = [];
    const env = controlEnv(registryCommands, {
      async fetch(input: string | URL | Request, init?: RequestInit) {
        const request = input instanceof globalThis.Request
          ? input
          : new globalThis.Request(input.toString(), init);
        brokerRequests.push(request);
        return Response.json({ id: "app_google", accountId: "acct_m1", provider: "google", displayName: "Family Google", clientIdSuffix: "usercontent.com" });
      },
    });
    const response = await handleControlRequest(new Request("https://control.test/api/provider-apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerAppId: "app_google", provider: "google", displayName: "Family Google", clientId: "client-id.apps.googleusercontent.com", clientSecret: "provider-app-secret" }),
    }), env, accessVerifier);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "app_google", accountId: "acct_m1", provider: "google", displayName: "Family Google", clientIdSuffix: "usercontent.com" });
    expect(brokerRequests[0]!.headers.get("authorization")).toBe("Bearer control-broker");
    expect(await brokerRequests[0]!.clone().json()).toMatchObject({ clientSecret: "provider-app-secret" });
    expect(brokerRequests[0]!.headers.get("authorization")).toBe("Bearer control-broker");
    expect(JSON.stringify(registryCommands)).not.toContain("provider-app-secret");
  });

  test("rejects Provider mutations when Control role credentials are equal, before parsing body", async () => {
    const env = {
      ACCOUNT_ID: "acct_m1",
      ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      ACCESS_AUDIENCE: "audience",
      CONTROL_BASE_URL: "https://control.test",
      MANAGEMENT_API_TOKEN: "shared-secret",
      CONTROL_RESPONSE_KEK: "shared-secret",
      CONTROL_GATEWAY_TOKEN: "gateway-token",
      CONTROL_BROKER_TOKEN: "control-broker",
      DEMO_ADMIN_TOKEN: "admin",
      GATEWAY_BASE_URL: "https://gateway.test",
      BROKER: { fetch: async () => { throw new Error("Broker must not be reached"); } },
      ACCOUNTS: { getByName: () => { throw new Error("registry must not be reached"); } },
      ASSETS: { fetch: async () => new Response("asset") },
    } as never;
    const response = await handleControlRequest(new Request("https://control.test/api/provider-apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }), env, accessVerifier);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Control role credentials must be non-empty and pairwise distinct",
    });
  });

  test("rejects Provider mutations when Control role credentials include empty, before parsing body", async () => {
    for (const field of ["MANAGEMENT_API_TOKEN", "CONTROL_RESPONSE_KEK", "CONTROL_GATEWAY_TOKEN", "CONTROL_BROKER_TOKEN", "DEMO_ADMIN_TOKEN"] as const) {
      const baseEnv = {
        ACCOUNT_ID: "acct_m1",
        ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        ACCESS_AUDIENCE: "audience",
        CONTROL_BASE_URL: "https://control.test",
        MANAGEMENT_API_TOKEN: "management",
        CONTROL_RESPONSE_KEK: "response-kek",
        CONTROL_GATEWAY_TOKEN: "gateway-token",
        CONTROL_BROKER_TOKEN: "control-broker",
        DEMO_ADMIN_TOKEN: "admin",
        GATEWAY_BASE_URL: "https://gateway.test",
        BROKER: { fetch: async () => { throw new Error("Broker must not be reached"); } },
        ACCOUNTS: { getByName: () => { throw new Error("registry must not be reached"); } },
        ASSETS: { fetch: async () => new Response("asset") },
      };
      const env = { ...baseEnv, [field]: "" } as never;
      const response = await handleControlRequest(new Request("https://control.test/api/provider-apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }), env, accessVerifier);

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: "Control role credentials must be non-empty and pairwise distinct",
      });
    }
  });
});

function accessVerifier() {
  return Promise.resolve({ accountId: "acct_m1", subject: "access-user" });
}


function controlEnv(registryCommands: unknown[], broker: { fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> }) {
  return {
    ACCOUNT_ID: "acct_m1",
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    ACCESS_AUDIENCE: "audience",
    CONTROL_BASE_URL: "https://control.test",
    MANAGEMENT_API_TOKEN: "management",
    CONTROL_RESPONSE_KEK: "response-kek",
    CONTROL_GATEWAY_TOKEN: "gateway-token",
    CONTROL_BROKER_TOKEN: "control-broker",
    DEMO_ADMIN_TOKEN: "admin",
    GATEWAY_BASE_URL: "https://gateway.test",
    BROKER: broker,
    ACCOUNTS: { getByName: () => ({ dispatchJson: async (command: unknown) => { registryCommands.push(command); const typed = command as { operation?: string; summary?: unknown }; return JSON.stringify({ ok: true, value: typed.operation === "save_provider_app" ? typed.summary : [] }); } }) },
    ASSETS: { fetch: async () => new Response("asset") },
  } as never;
}
