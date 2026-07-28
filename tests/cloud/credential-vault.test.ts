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

const { CredentialVault } = await import("../../src/workers/credential-vault");
const VALID_KEK = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64");

describe("Broker CredentialVault", () => {
  test("stores write-only secrets and returns safe summaries", async () => {
    const vault = new CredentialVault(vaultContext("acct_a") as never, { CREDENTIAL_KEK: VALID_KEK } as never);
    const app = await request(vault, "/provider-apps", {
      accountId: "acct_a",
      providerAppId: "app_google",
      provider: "google",
      displayName: "Family Google",
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "provider-app-secret",
      scopes: ["gmail.readonly", "documents.readonly"],
    });
    expect(app).toEqual({ id: "app_google", accountId: "acct_a", provider: "google", displayName: "Family Google", clientIdSuffix: "usercontent.com", scopes: ["documents.readonly", "gmail.readonly"] });

    const connection = await request(vault, "/connections", {
      accountId: "acct_a",
      connectionId: "con_google",
      nickname: "family-google",
      providerAppId: "app_google",
      provider: "google",
      subject: "stable-google-sub",
      displayName: "family@example.com",
      grantedScopes: ["openid", "email", "gmail.readonly", "documents.readonly"],
      refreshToken: "refresh-token",
    });
    expect(JSON.stringify(connection)).not.toContain("stable-google-sub");
    expect(JSON.stringify(connection)).not.toContain("refresh-token");
    expect(JSON.stringify(connection)).not.toContain("ciphertext");
  });

  test("rejects cross-Account vault access", async () => {
    const vault = new CredentialVault(vaultContext("acct_a") as never, { CREDENTIAL_KEK: VALID_KEK } as never);
    const response = await vault.fetch(new Request("https://vault.internal/provider-apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "acct_b", providerAppId: "app", provider: "google", displayName: "x", clientId: "id", clientSecret: "secret", scopes: ["gmail.readonly"] }),
    }));
    expect(response.status).toBe(403);
  });

  test("rejects malformed or wrong-length CREDENTIAL_KEK and extra request fields", async () => {
    for (const value of ["", "not-base64", Buffer.from("short").toString("base64")]) {
      const vault = new CredentialVault(vaultContext("acct_a") as never, { CREDENTIAL_KEK: value } as never);
      const response = await vault.fetch(new Request("https://vault.internal/provider-apps", { method: "POST", body: JSON.stringify({ accountId: "acct_a" }) }));
      expect(response.status).toBe(400);
    }
    const vault = new CredentialVault(vaultContext("acct_a") as never, { CREDENTIAL_KEK: VALID_KEK } as never);
    const response = await vault.fetch(new Request("https://vault.internal/provider-apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "acct_a", providerAppId: "app", provider: "google", displayName: "x", clientId: "id", clientSecret: "secret", scopes: ["gmail.readonly"], extra: true }),
    }));
    expect(response.status).toBe(400);
  });

  test("Provider App scopes round-trip through the lease and list routes", async () => {
    const vault = new CredentialVault(vaultContext("acct_a") as never, { CREDENTIAL_KEK: VALID_KEK } as never);
    await request(vault, "/provider-apps", {
      accountId: "acct_a",
      providerAppId: "app_google",
      provider: "google",
      displayName: "Family Google",
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "provider-app-secret",
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });

    const lease = await vault.fetch(new Request("https://vault.internal/provider-apps/app_google/lease"));
    expect(await lease.json()).toMatchObject({
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "provider-app-secret",
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });

    const list = await vault.fetch(new Request("https://vault.internal/provider-apps"));
    expect(await list.json()).toEqual([
      expect.objectContaining({ id: "app_google", scopes: ["https://www.googleapis.com/auth/calendar.readonly"] }),
    ]);
  });

  test("rejects a Provider App registration with a malformed scope list", async () => {
    const vault = new CredentialVault(vaultContext("acct_a") as never, { CREDENTIAL_KEK: VALID_KEK } as never);
    for (const scopes of [undefined, "gmail.readonly", [], [""], ["two scopes"], [42]]) {
      const response = await vault.fetch(new Request("https://vault.internal/provider-apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: "acct_a", providerAppId: "app", provider: "google", displayName: "x", clientId: "id", clientSecret: "secret", scopes }),
      }));
      expect(response.status).toBe(400);
    }
  });

  test("preserves concurrent provider-app writes in durable storage", async () => {
    const context = vaultContext("acct_a", true);
    const vault = new CredentialVault(context as never, { CREDENTIAL_KEK: VALID_KEK } as never);
    const writes = Promise.all(["one", "two"].map((name) => request(vault, "/provider-apps", {
      accountId: "acct_a", providerAppId: `app_${name}`, provider: "google", displayName: name, clientId: `${name}.id`, clientSecret: `${name}-secret`, scopes: ["gmail.readonly"],
    })));
    await context.firstGetStarted;
    context.releaseFirstGet();
    await writes;
    const response = await vault.fetch(new Request("https://vault.internal/provider-apps"));
    expect(await response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "app_one" }),
      expect.objectContaining({ id: "app_two" }),
    ]));
  });
});

async function request(vault: InstanceType<typeof CredentialVault>, path: string, body: unknown) {
  const response = await vault.fetch(new Request(`https://vault.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  expect(response.status).toBe(200);
  return response.json();
}

function vaultContext(name: string, barrier = false) {
  const values = new Map<string, unknown>();
  let releaseFirstGet!: () => void;
  let firstGetStarted!: () => void;
  const firstGet = new Promise<void>((resolve) => { firstGetStarted = resolve; });
  const firstGetGate = new Promise<void>((resolve) => { releaseFirstGet = resolve; });
  let gets = 0;
  let tail = Promise.resolve();
  return { id: { name }, firstGetStarted: firstGet, releaseFirstGet, blockConcurrencyWhile: <T>(callback: () => Promise<T>) => {
    const run = tail.then(callback);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }, storage: {
    async get<T>(key: string) {
      gets += 1;
      if (barrier && gets === 1) {
        firstGetStarted();
        await firstGetGate;
      }
      return values.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) { values.set(key, value); },
  } };
}
