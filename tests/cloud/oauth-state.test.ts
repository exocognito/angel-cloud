import { describe, expect, test } from "bun:test";
import { issueOAuthState } from "../../src/oauth-state";

describe("server-side OAuth state", () => {
  test("issues opaque state with all server-side bindings and complete PKCE", async () => {
    const issued = await issueOAuthState({
      accountId: "acct_a",
      accessSubject: "access-user",
      providerAppId: "app_google",
      connectionId: "con_google",
      nickname: "family-google",
      redirectUri: "https://control.test/callback",
      now: 1_000,
    });

    expect(issued.state).not.toContain("acct_a");
    expect(issued.state).not.toContain("app_google");
    expect(issued.record).toMatchObject({
      accountId: "acct_a",
      accessSubject: "access-user",
      providerAppId: "app_google",
      connectionId: "con_google",
      nickname: "family-google",
      used: false,
    });
    expect(issued.record.state).toBe(issued.state);
    expect(issued.record.codeVerifier).toBeString();
    expect(issued.record.codeChallenge).toBeString();
    expect(issued.record.codeChallenge).not.toBe(issued.record.codeVerifier);
    expect(issued.record.expiresAt).toBe(601_000);
    expect(issued.record.used).toBe(false);
  });

  test("uses the requested flow kind for create and reauth", async () => {
    const issued = await issueOAuthState({
      accountId: "acct_a",
      accessSubject: "access-user",
      providerAppId: "app_google",
      connectionId: "con_google",
      nickname: "family-google",
      redirectUri: "https://control.test/callback",
      flow: "reauth",
      now: 1_000,
    });
    expect(issued.record.flow).toBe("reauth");
  });
});
