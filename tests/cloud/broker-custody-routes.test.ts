import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_GOOGLE_PROVIDER_SCOPES, googleConsentScopes } from "../../src/google-oauth";

const DEFAULT_CONSENT = googleConsentScopes(DEFAULT_GOOGLE_PROVIDER_SCOPES);

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

const { handleBrokerRequest } = await import("../../src/workers/broker");

describe("Broker custody lifecycle routes", () => {
  test("builds the Google authorization URL from a vault-held Provider App", async () => {
    const vault = {
      async fetch(input: string | Request) {
        expect(new URL(requestUrl(input)).pathname).toBe("/provider-apps/app_google/lease");
        return Response.json({ clientId: "client-id", clientSecret: "provider-secret", scopes: ["https://www.googleapis.com/auth/calendar.readonly"] });
      },
    };
    const response = await handleBrokerRequest(new Request("https://broker.internal/internal/oauth/authorize", {
      method: "POST",
      headers: { authorization: "Bearer control-broker", "content-type": "application/json" },
      body: JSON.stringify({ accountId: "acct_a", providerAppId: "app_google", state: "opaque-state", codeChallenge: "challenge", redirectUri: "https://control.test/callback" }),
    }), brokerEnv(vault), () => ({}));

    expect(response.status).toBe(200);
    const authorizationUrl = new URL((await response.json() as { authorizationUrl: string }).authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.pathname).toBe("/o/oauth2/v2/auth");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("client-id");
    expect(authorizationUrl.searchParams.get("state")).toBe("opaque-state");
    expect(authorizationUrl.searchParams.get("code_challenge")).toBe("challenge");
    expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
    // The consent request carries the Provider App's configured scopes, not a
    // compiled constant.
    expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
  });

  test("registers a Provider App by forwarding its scope set to the vault", async () => {
    let stored: unknown;
    const vault = {
      async fetch(input: string | Request) {
        const request = vaultRequest(input);
        expect(new URL(request.url).pathname).toBe("/provider-apps");
        stored = await request.json();
        return Response.json({ ok: true });
      },
    };
    const response = await handleBrokerRequest(new Request("https://broker.internal/internal/provider-apps", {
      method: "POST",
      headers: { authorization: "Bearer control-broker", "content-type": "application/json" },
      body: JSON.stringify({ accountId: "acct_a", providerAppId: "app_google", provider: "google", displayName: "Family", clientId: "client-id", clientSecret: "secret", scopes: ["https://www.googleapis.com/auth/calendar.readonly"] }),
    }), brokerEnv(vault), () => ({}));

    expect(response.status).toBe(200);
    expect(stored).toMatchObject({ scopes: ["https://www.googleapis.com/auth/calendar.readonly"] });
  });

  test("registers a Provider App posted without scopes with the default set (old-Control compatibility)", async () => {
    let stored: unknown;
    const vault = {
      async fetch(input: string | Request) {
        stored = await vaultRequest(input).json();
        return Response.json({ ok: true });
      },
    };
    const response = await handleBrokerRequest(new Request("https://broker.internal/internal/provider-apps", {
      method: "POST",
      headers: { authorization: "Bearer control-broker", "content-type": "application/json" },
      body: JSON.stringify({ accountId: "acct_a", providerAppId: "app_google", provider: "google", displayName: "Family", clientId: "client-id", clientSecret: "secret" }),
    }), brokerEnv(vault), () => ({}));

    expect(response.status).toBe(200);
    expect(stored).toMatchObject({ scopes: [...DEFAULT_GOOGLE_PROVIDER_SCOPES] });
  });

  test("exchange fails closed when the grant misses a configured Provider App scope", async () => {
    const idToken = await signedGoogleIdToken();
    const vault = {
      async fetch(input: string | Request) {
        const path = new URL(requestUrl(input)).pathname;
        if (path.endsWith("/lease")) {
          return Response.json({ clientId: "client-id", clientSecret: "client-secret", scopes: ["https://www.googleapis.com/auth/calendar.readonly"] });
        }
        throw new Error(`custody must not be written for a partial grant: ${path}`);
      },
    };
    const response = await handleBrokerRequest(new Request("https://broker.internal/internal/oauth/exchange", {
      method: "POST",
      headers: { authorization: "Bearer control-broker", "content-type": "application/json" },
      body: JSON.stringify({ accountId: "acct_a", providerAppId: "app_google", connectionId: "con_google", nickname: "family-google", flow: "create", code: "code", codeVerifier: "verifier", redirectUri: "https://control.test/callback" }),
    }), brokerEnv(vault), () => ({}), async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/token") return Response.json({ refresh_token: "new-refresh-token", id_token: idToken, scope: DEFAULT_CONSENT.join(" ") });
      if (path === "/revoke") return new Response(null, { status: 204 });
      return Response.json({ keys: [publicJwk] });
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Google OAuth response omitted a required scope" });
  });

  test("healthy removal revokes upstream before delete and preserves custody on revoke failure", async () => {
    const calls: string[] = [];
    const vault = {
      async fetch(input: string | Request) {
        const request = vaultRequest(input);
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        if (new URL(request.url).pathname.endsWith("/lease-revocation")) return Response.json({ refreshToken: "old-refresh-token" });
        if (request.method === "GET") return Response.json({ id: "con_google", health: "healthy" });
        if (request.method === "DELETE") return Response.json({ removed: true });
        return Response.json({ error: "unused" }, { status: 500 });
      },
    };
    const response = await handleBrokerRequest(new Request("https://broker.internal/internal/oauth/remove", {
      method: "POST",
      headers: { authorization: "Bearer control-broker", "content-type": "application/json" },
      body: JSON.stringify({ accountId: "acct_a", connectionId: "con_google" }),
    }), brokerEnv(vault), () => ({}), async (input) => {
      calls.push(`FETCH ${new URL(input.toString()).pathname}`);
      return new Response("revocation failed", { status: 500 });
    });

    expect(response.status).toBe(500);
    expect(calls).toEqual([
      "GET /connections/con_google",
      "GET /connections/con_google/lease-revocation",
      "FETCH /revoke",
    ]);
  });

  test("healthy removal revokes successfully before deleting custody", async () => {
    const calls: string[] = [];
    const vault = removalVault(calls, "healthy");
    const response = await handleBrokerRequest(removeRequest(), brokerEnv(vault), () => ({}), async (input) => {
      calls.push(`FETCH ${new URL(input.toString()).pathname}`);
      return new Response(null, { status: 204 });
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "GET /connections/con_google",
      "GET /connections/con_google/lease-revocation",
      "FETCH /revoke",
      "DELETE /connections/con_google",
    ]);
  });

  test("already-revoked removal deletes without another Google call", async () => {
    const calls: string[] = [];
    const vault = removalVault(calls, "revoked");
    const response = await handleBrokerRequest(removeRequest(), brokerEnv(vault), () => ({}), async () => {
      throw new Error("revocation must not be attempted");
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "GET /connections/con_google",
      "DELETE /connections/con_google",
    ]);
  });

  test("error removal uses the revocation-only lease while invocation lease stays unused", async () => {
    const calls: string[] = [];
    const vault = removalVault(calls, "error");
    const response = await handleBrokerRequest(removeRequest(), brokerEnv(vault), () => ({}), async (input) => {
      calls.push(`FETCH ${new URL(input.toString()).pathname}`);
      return new Response(null, { status: 204 });
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "GET /connections/con_google",
      "GET /connections/con_google/lease-revocation",
      "FETCH /revoke",
      "DELETE /connections/con_google",
    ]);
  });

  test("exchange failure after Google grants a refresh token revokes the new token", async () => {
    const idToken = await signedGoogleIdToken();
    const calls: string[] = [];
    const custodyRefreshToken = "old-refresh-token";
    const vault = {
      async fetch(input: string | Request) {
        const request = vaultRequest(input);
        const path = new URL(request.url).pathname;
        calls.push(`${request.method} ${path}`);
        if (path.endsWith("/lease")) return Response.json({ clientId: "client-id", clientSecret: "client-secret", scopes: [...DEFAULT_GOOGLE_PROVIDER_SCOPES] });
        if (path.endsWith("/reauth")) {
          expect(request.method).toBe("POST");
          const candidate = await request.json() as { refreshToken?: string };
          expect(candidate.refreshToken).toBe("new-refresh-token");
          return Response.json({ error: "identity mismatch" }, { status: 409 });
        }
        return Response.json({ error: "unused" }, { status: 500 });
      },
    };
    const response = await handleBrokerRequest(new Request("https://broker.internal/internal/oauth/exchange", {
      method: "POST",
      headers: { authorization: "Bearer control-broker", "content-type": "application/json" },
      body: JSON.stringify({ accountId: "acct_a", providerAppId: "app_google", connectionId: "con_google", nickname: "family-google", flow: "reauth", code: "code", codeVerifier: "verifier", redirectUri: "https://control.test/callback" }),
    }), brokerEnv(vault), () => ({}), async (input, init) => {
      const url = new URL(input.toString());
      calls.push(`FETCH ${url.pathname}`);
      if (url.pathname === "/token") return Response.json({ refresh_token: "new-refresh-token", id_token: idToken, scope: DEFAULT_CONSENT.join(" ") });
      if (url.pathname === "/revoke") {
        const body = await googleRequest(input, init).text();
        expect(body).toContain("new-refresh-token");
        return new Response(null, { status: 204 });
      }
      return Response.json({ keys: [publicJwk] });
    });

    expect(response.status).toBe(409);
    expect(calls).toContain("FETCH /revoke");
    expect(calls).toContain("POST /connections/con_google/reauth");
    expect(custodyRefreshToken).toBe("old-refresh-token");
  });

  test("preserves custody rejection when cleanup revocation also fails", async () => {
    const idToken = await signedGoogleIdToken();
    const vault = {
      async fetch(input: string | Request) {
        const path = new URL(requestUrl(input)).pathname;
        if (path.endsWith("/lease")) return Response.json({ clientId: "client-id", clientSecret: "client-secret", scopes: [...DEFAULT_GOOGLE_PROVIDER_SCOPES] });
        if (path.endsWith("/reauth")) return Response.json({ error: "same Google identity required" }, { status: 409 });
        return Response.json({ error: "unexpected vault request" }, { status: 500 });
      },
    };
    const response = await handleBrokerRequest(new Request("https://broker.internal/internal/oauth/exchange", {
      method: "POST",
      headers: { authorization: "Bearer control-broker", "content-type": "application/json" },
      body: JSON.stringify({ accountId: "acct_a", providerAppId: "app_google", connectionId: "con_google", nickname: "family-google", flow: "reauth", code: "code", codeVerifier: "verifier", redirectUri: "https://control.test/callback" }),
    }), brokerEnv(vault), () => ({}), async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/token") return Response.json({ refresh_token: "new-refresh-token", id_token: idToken, scope: DEFAULT_CONSENT.join(" ") });
      if (path === "/revoke") return new Response("upstream revoke failed", { status: 503 });
      return Response.json({ keys: [publicJwk] });
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "same Google identity required; Google OAuth grant cleanup failed: Google OAuth revocation failed" });
  });
});

function removeRequest(): Request {
  return new Request("https://broker.internal/internal/oauth/remove", {
    method: "POST",
    headers: { authorization: "Bearer control-broker", "content-type": "application/json" },
    body: JSON.stringify({ accountId: "acct_a", connectionId: "con_google" }),
  });
}

function removalVault(calls: string[], health: "healthy" | "revoked" | "error") {
  return {
    async fetch(input: string | Request) {
      const request = vaultRequest(input);
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (path.endsWith("/lease-revocation")) return Response.json({ refreshToken: "old-refresh-token" });
      if (request.method === "GET") return Response.json({ id: "con_google", health });
      if (request.method === "DELETE") return Response.json({ removed: true });
      return Response.json({ error: "unused" }, { status: 500 });
    },
  };
}

function brokerEnv(vault: { fetch(input: string | Request, init?: RequestInit): Promise<Response> }) {
  return {
    CONTROL_BROKER_TOKEN: "control-broker",
    GATEWAY_BROKER_INVOKE_TOKEN: "gateway-invoke",
    CREDENTIAL_KEK: Buffer.alloc(32).toString("base64"),
    CREDENTIAL_VAULTS: { getByName: () => vault },
    GATES: { getByName: () => { throw new Error("gate must not be reached"); } },
  } as never;
}

const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "google-key", alg: "RS256", use: "sig" };

async function signedGoogleIdToken(): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: "google-key" };
  const payload = { iss: "https://accounts.google.com", aud: "client-id", sub: "stable-sub", email: "sam@example.test", email_verified: true, exp: Math.floor(Date.now() / 1000) + 300 };
  const encoded = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(encoded));
  return `${encoded}.${base64url(new Uint8Array(signature))}`;
}

function base64url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function vaultRequest(input: string | Request): globalThis.Request {
  return typeof input === "string" ? new globalThis.Request(input) : input as unknown as globalThis.Request;
}

function googleRequest(input: string | URL, init?: RequestInit): globalThis.Request {
  return new globalThis.Request(input.toString(), init);
}
