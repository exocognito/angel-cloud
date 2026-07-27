import { describe, expect, test } from "bun:test";
import {
  CustodyIntegrityError,
  CustodyOwnershipError,
  EnvelopeCustody,
  type CustodyState,
} from "../../src/custody";

const KEK = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const OTHER_KEK = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

async function populatedCustody(): Promise<EnvelopeCustody> {
  const custody = await EnvelopeCustody.create(KEK);
  await custody.storeProviderApp({
    accountId: "acct_a",
    providerAppId: "app_google",
    provider: "google",
    displayName: "Family Google",
    clientId: "client-id.apps.googleusercontent.com",
    clientSecret: "provider-app-secret",
  });
  await custody.storeConnection({
    accountId: "acct_a",
    connectionId: "con_google",
    nickname: "family-google",
    providerAppId: "app_google",
    provider: "google",
    subject: "stable-google-sub",
    displayName: "family@example.com",
    grantedScopes: ["gmail.readonly", "documents.readonly"],
    refreshToken: "google-refresh-token",
  });
  return custody;
}

describe("envelope credential custody", () => {
  test("safe read models expose no secret, token, or ciphertext", async () => {
    const custody = await populatedCustody();

    expect(custody.getProviderApp("acct_a", "app_google")).toEqual({
      id: "app_google",
      accountId: "acct_a",
      provider: "google",
      displayName: "Family Google",
      clientIdSuffix: "usercontent.com",
    });
    expect(custody.getConnection("acct_a", "con_google")).toEqual({
      id: "con_google",
      accountId: "acct_a",
      nickname: "family-google",
      providerAppId: "app_google",
      provider: "google",
      displayName: "family@example.com",
      grantedScopes: ["documents.readonly", "gmail.readonly"],
      health: "healthy",
    });

    const safeJson = JSON.stringify({
      providerApp: custody.getProviderApp("acct_a", "app_google"),
      connection: custody.getConnection("acct_a", "con_google"),
    });
    expect(safeJson).not.toContain("provider-app-secret");
    expect(safeJson).not.toContain("google-refresh-token");
    expect(safeJson).not.toContain("stable-google-sub");
    expect(safeJson).not.toContain("ciphertext");
    expect(safeJson).not.toContain("wrappedDek");
  });

  test("serialized state rehydrates and a Broker lease decrypts only the requested record", async () => {
    const original = await populatedCustody();
    const persisted = JSON.parse(JSON.stringify(original.exportState())) as CustodyState;
    const restored = await EnvelopeCustody.create(KEK, persisted);

    expect(await restored.leaseConnection("acct_a", "con_google")).toEqual({
      accountId: "acct_a",
      connectionId: "con_google",
      providerAppId: "app_google",
      provider: "google",
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "provider-app-secret",
      refreshToken: "google-refresh-token",
      subject: "stable-google-sub",
      grantedScopes: ["documents.readonly", "gmail.readonly"],
    });
  });

  test("Broker-only provider-app lease decrypts the client secret without changing the safe summary", async () => {
    const custody = await populatedCustody();

    await expect(custody.leaseProviderApp("acct_a", "app_google")).resolves.toEqual({
      accountId: "acct_a",
      providerAppId: "app_google",
      provider: "google",
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "provider-app-secret",
    });
    expect(JSON.stringify(custody.getProviderApp("acct_a", "app_google"))).not.toContain("provider-app-secret");
  });

  test("each Account has one wrapped DEK and every secret encryption uses a fresh nonce", async () => {
    const custody = await EnvelopeCustody.create(KEK);
    for (const [providerAppId, accountId] of [
      ["app_a1", "acct_a"],
      ["app_a2", "acct_a"],
      ["app_b1", "acct_b"],
    ] as const) {
      await custody.storeProviderApp({
        accountId,
        providerAppId,
        provider: "google",
        displayName: providerAppId,
        clientId: `${providerAppId}.apps.googleusercontent.com`,
        clientSecret: "same-secret",
      });
    }

    const state = custody.exportState();
    const accountA = requireAccount(state, "acct_a");
    const accountB = requireAccount(state, "acct_b");
    const appA1 = requireProviderApp(state, "acct_a", "app_a1");
    const appA2 = requireProviderApp(state, "acct_a", "app_a2");
    expect(accountA.wrappedDek).toBeDefined();
    expect(accountB.wrappedDek).toBeDefined();
    expect(accountA.wrappedDek).not.toEqual(accountB.wrappedDek);
    expect(appA1.clientSecret.iv).not.toBe(
      appA2.clientSecret.iv,
    );
    expect(appA1.clientSecret.ciphertext).not.toBe(
      appA2.clientSecret.ciphertext,
    );
  });

  test("wrong-Account access fails without revealing that another Account owns the record", async () => {
    const custody = await populatedCustody();

    expect(() => custody.getConnection("acct_b", "con_google")).toThrow(CustodyOwnershipError);
    await expect(custody.leaseConnection("acct_b", "con_google")).rejects.toThrow(
      CustodyOwnershipError,
    );
  });

  test("a wrong KEK fails loudly instead of returning a fallback credential", async () => {
    const original = await populatedCustody();
    const restored = await EnvelopeCustody.create(OTHER_KEK, original.exportState());

    await expect(restored.leaseConnection("acct_a", "con_google")).rejects.toThrow(
      CustodyIntegrityError,
    );
  });

  test("reauthentication replaces custody under the same Connection ID", async () => {
    const custody = await populatedCustody();

    const replaced = await custody.replaceConnection({
      accountId: "acct_a",
      connectionId: "con_google",
      nickname: "family-google",
      providerAppId: "app_google",
      provider: "google",
      subject: "stable-google-sub",
      displayName: "new@example.com",
      grantedScopes: ["openid", "email", "gmail.readonly", "documents.readonly"],
      refreshToken: "replacement-refresh-token",
    });

    expect(replaced.id).toBe("con_google");
    expect(replaced.health).toBe("healthy");
    expect((await custody.leaseConnection("acct_a", "con_google")).refreshToken)
      .toBe("replacement-refresh-token");
  });

  test("same-ID reauth rejects a different Google sub or Provider App without changing custody", async () => {
    const custody = await populatedCustody();
    await custody.storeProviderApp({
      accountId: "acct_a",
      providerAppId: "other-provider-app",
      provider: "google",
      displayName: "Other Google",
      clientId: "other.apps.googleusercontent.com",
      clientSecret: "other-secret",
    });
    const before = await custody.leaseConnection("acct_a", "con_google");
    for (const input of [
      {
        accountId: "acct_a",
        connectionId: "con_google",
        nickname: "family-google",
        providerAppId: "app_google",
        provider: "google" as const,
        subject: "different-google-sub",
        displayName: "other@example.com",
        grantedScopes: ["gmail.readonly"],
        refreshToken: "must-not-be-stored",
      },
      {
        accountId: "acct_a",
        connectionId: "con_google",
        nickname: "family-google",
        providerAppId: "other-provider-app",
        provider: "google" as const,
        subject: before.subject,
        displayName: "other@example.com",
        grantedScopes: ["gmail.readonly"],
        refreshToken: "must-not-be-stored",
      },
    ]) {
      await expect(custody.replaceConnection(input)).rejects.toThrow(/same|identity|Provider App/);
      await expect(custody.leaseConnection("acct_a", "con_google")).resolves.toMatchObject(before);
    }
  });

  test("revocation marks a Connection unavailable and removal deletes it", async () => {
    const custody = await populatedCustody();

    expect(custody.markConnectionHealth("acct_a", "con_google", "revoked").health).toBe("revoked");
    await expect(custody.leaseConnection("acct_a", "con_google")).rejects.toThrow(/revoked/);
    custody.removeConnection("acct_a", "con_google");
    expect(() => custody.getConnection("acct_a", "con_google")).toThrow(CustodyOwnershipError);
  });

  test("an error Connection blocks invocation lease but allows revocation-only custody access", async () => {
    const custody = await populatedCustody();
    custody.markConnectionHealth("acct_a", "con_google", "error");
    await expect(custody.leaseConnection("acct_a", "con_google")).rejects.toThrow(/error/);
    await expect(custody.leaseConnectionForRevocation("acct_a", "con_google")).resolves.toMatchObject({
      refreshToken: "google-refresh-token",
    });
  });

  test("ciphertext tampering fails authentication", async () => {
    const original = await populatedCustody();
    const state = original.exportState();
    const connection = requireConnection(state, "acct_a", "con_google");
    connection.refreshToken.ciphertext = flipBase64Character(
      connection.refreshToken.ciphertext,
    );
    const restored = await EnvelopeCustody.create(KEK, state);

    await expect(restored.leaseConnection("acct_a", "con_google")).rejects.toThrow(
      CustodyIntegrityError,
    );
  });

  test("ciphertext cannot be swapped between records", async () => {
    const custody = await populatedCustody();
    await custody.storeConnection({
      accountId: "acct_a",
      connectionId: "con_google_2",
      nickname: "other-google",
      providerAppId: "app_google",
      provider: "google",
      subject: "other@example.com",
      grantedScopes: ["gmail.readonly"],
      refreshToken: "other-refresh-token",
    });
    const state = custody.exportState();
    const first = requireConnection(state, "acct_a", "con_google");
    const second = requireConnection(state, "acct_a", "con_google_2");
    first.refreshToken = structuredClone(
      second.refreshToken,
    );
    const restored = await EnvelopeCustody.create(KEK, state);

    await expect(restored.leaseConnection("acct_a", "con_google")).rejects.toThrow(
      CustodyIntegrityError,
    );
  });

  test("rejects a duplicate Connection nickname within one Account", async () => {
    const custody = await populatedCustody();
    await expect(custody.storeConnection({
      accountId: "acct_a",
      connectionId: "con_google_2",
      nickname: "family-google",
      providerAppId: "app_google",
      provider: "google",
      subject: "other@example.com",
      grantedScopes: ["gmail.readonly"],
      refreshToken: "other-refresh-token",
    })).rejects.toThrow("Connection nickname already exists: family-google");
  });

  test("rejects a KEK that is not 256 bits", async () => {
    await expect(EnvelopeCustody.create(new Uint8Array(16))).rejects.toThrow(
      /KEK must be exactly 32 bytes/,
    );
  });
});

function flipBase64Character(value: string): string {
  const first = value[0];
  if (first === undefined) throw new Error("test ciphertext is empty");
  return `${first === "A" ? "B" : "A"}${value.slice(1)}`;
}

function requireAccount(state: CustodyState, accountId: string) {
  const account = state.accounts[accountId];
  if (account === undefined) throw new Error(`missing test Account: ${accountId}`);
  return account;
}

function requireProviderApp(state: CustodyState, accountId: string, providerAppId: string) {
  const providerApp = requireAccount(state, accountId).providerApps[providerAppId];
  if (providerApp === undefined) throw new Error(`missing test Provider App: ${providerAppId}`);
  return providerApp;
}

function requireConnection(state: CustodyState, accountId: string, connectionId: string) {
  const connection = requireAccount(state, accountId).connections[connectionId];
  if (connection === undefined) throw new Error(`missing test Connection: ${connectionId}`);
  return connection;
}
