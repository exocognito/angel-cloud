import { describe, expect, mock, test } from "bun:test";
import { issueOAuthState } from "../../src/oauth-state";

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

describe("AccountRegistry OAuth state command", () => {
  test("rejects wrong identity and exact-time expiry without consuming state", async () => {
    const registry = makeRegistry();
    const issued = await issueOAuthState({
      accountId: "acct_m1",
      accessSubject: "access-user",
      providerAppId: "app_google",
      connectionId: "con_google",
      nickname: "family-google",
      redirectUri: "https://control.test/callback",
      now: 1_000,
    });
    await put(registry, issued.record);

    expect(await take(registry, issued.state, { accessSubject: "other-user", now: 1_001 })).toMatchObject({ ok: false, status: 400 });
    expect(await take(registry, issued.state, { accessSubject: "access-user", now: issued.record.expiresAt })).toMatchObject({ ok: false, status: 400 });
    expect(await take(registry, issued.state, { accessSubject: "access-user", now: issued.record.expiresAt - 1 })).toMatchObject({ ok: true, value: { providerAppId: "app_google", connectionId: "con_google", nickname: "family-google", codeVerifier: issued.record.codeVerifier, redirectUri: issued.record.redirectUri, flow: "create" } });
  });

  test("atomically allows only one concurrent callback to consume opaque state", async () => {
    const registry = makeRegistry();
    const issued = await issueOAuthState({
      accountId: "acct_m1",
      accessSubject: "access-user",
      providerAppId: "app_google",
      connectionId: "con_google",
      nickname: "family-google",
      redirectUri: "https://control.test/callback",
      now: 1_000,
    });
    await put(registry, issued.record);

    const results = await Promise.all([
      take(registry, issued.state, { accessSubject: "access-user", now: 1_001 }),
      take(registry, issued.state, { accessSubject: "access-user", now: 1_001 }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => result.ok)).toMatchObject({ value: { providerAppId: "app_google", connectionId: "con_google", codeVerifier: issued.record.codeVerifier, redirectUri: issued.record.redirectUri, flow: "create" } });
    expect(await take(registry, issued.state, { accessSubject: "access-user", now: 1_001 })).toMatchObject({ ok: false, status: 400 });
  });
});

type Registry = { dispatchJson(command: unknown): Promise<string> };
type RegistryResult = { ok: boolean; status?: number; value?: unknown };

function makeRegistry(): Registry {
  const data = new Map<string, unknown>();
  let tail: Promise<void> = Promise.resolve();
  const storage = {
    async get<T>(key: string): Promise<T | undefined> {
      return structuredClone(data.get(key)) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      data.set(key, structuredClone(value));
    },
  };
  const ctx = {
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const result = tail.then(callback);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  return new AccountRegistry(ctx as never, { ACCOUNT_ID: "acct_m1" } as never) as unknown as Registry;
}

async function put(registry: Registry, state: Awaited<ReturnType<typeof issueOAuthState>>["record"]): Promise<void> {
  const result = JSON.parse(await registry.dispatchJson({ operation: "put_oauth_state", accountId: "acct_m1", state }));
  expect(result).toMatchObject({ ok: true });
}

async function take(registry: Registry, state: string, input: { accessSubject: string; now: number }): Promise<RegistryResult> {
  return JSON.parse(await registry.dispatchJson({ operation: "take_oauth_state", accountId: "acct_m1", state, ...input })) as RegistryResult;
}
