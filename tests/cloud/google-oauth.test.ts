import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GOOGLE_PROVIDER_SCOPES,
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  googleConsentScopes,
  parseProviderScopes,
  revokeGoogleRefreshToken,
  type GoogleJwk,
  type GoogleJwks,
} from "../../src/google-oauth";

const clientId = "client-id.apps.googleusercontent.com";
const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey) as unknown as GoogleJwk;

describe("Google OAuth custody boundary", () => {
  test("authorize URL requests the Provider App's scopes plus identity scopes with PKCE", () => {
    const url = new URL(buildGoogleAuthorizeUrl({
      clientId,
      redirectUri: "https://control.test/oauth/google/callback",
      state: "opaque-state",
      codeChallenge: "challenge",
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    }));

    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
  });

  test("authorize URL does not repeat an identity scope the Provider App already lists", () => {
    const url = new URL(buildGoogleAuthorizeUrl({
      clientId,
      redirectUri: "https://control.test/oauth/google/callback",
      state: "opaque-state",
      codeChallenge: "challenge",
      scopes: ["email", ...DEFAULT_GOOGLE_PROVIDER_SCOPES],
    }));

    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      ...DEFAULT_GOOGLE_PROVIDER_SCOPES,
    ]);
  });

  test("parseProviderScopes deduplicates, sorts, and copies a valid scope list", () => {
    const scopes = parseProviderScopes([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    expect(scopes).toEqual([
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
  });

  test("parseProviderScopes rejects identity scopes, which every consent adds itself", () => {
    // Google reports the aliases back in rewritten form (email ->
    // .../userinfo.email), so a configured identity scope would make every
    // exchange fail its floor check with no way to edit the Provider App.
    for (const scope of [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ]) {
      expect(() => parseProviderScopes([scope, ...DEFAULT_GOOGLE_PROVIDER_SCOPES])).toThrow(/identity/);
    }
  });

  test("parseProviderScopes bounds entry count and entry length", () => {
    // The list persists into the Account's single custody durable value and
    // space-joins into the authorize URL; one bad registration must not be
    // able to bloat either.
    const scope = (index: number) => `https://www.googleapis.com/auth/scope.${index}`;
    expect(parseProviderScopes(Array.from({ length: 64 }, (_, index) => scope(index)))).toHaveLength(64);
    expect(() => parseProviderScopes(Array.from({ length: 65 }, (_, index) => scope(index)))).toThrow(/scopes/);
    expect(parseProviderScopes([`https://www.googleapis.com/auth/${"a".repeat(256 - 32)}`])).toHaveLength(1);
    expect(() => parseProviderScopes([`https://www.googleapis.com/auth/${"a".repeat(257)}`])).toThrow(/scopes/);
  });

  test("parseProviderScopes rejects malformed scope lists", () => {
    const malformed: unknown[] = [
      undefined,
      null,
      "https://www.googleapis.com/auth/gmail.readonly",
      [],
      [42],
      [""],
      ["https://www.googleapis.com/auth/gmail.readonly", ""],
      ["two scopes glued together"],
      ["tab\tscope"],
      ["newline\nscope"],
    ];
    for (const candidate of malformed) {
      expect(() => parseProviderScopes(candidate)).toThrow(/scopes/);
    }
  });

  test("exchanges a code only after verifying Google identity and requires a refresh token", async () => {
    const idToken = await sign({ aud: clientId, sub: "google-stable-sub", email: "sam@example.test", email_verified: true });
    const calls: Request[] = [];
    const consentScopes = googleConsentScopes(DEFAULT_GOOGLE_PROVIDER_SCOPES);
    const result = await exchangeGoogleCode({
      clientId,
      clientSecret: "provider-secret",
      code: "google-code",
      codeVerifier: "verifier",
      redirectUri: "https://control.test/oauth/google/callback",
      requiredScopes: DEFAULT_GOOGLE_PROVIDER_SCOPES,
    }, async (input, init) => {
      const request = makeRequest(input, init);
      calls.push(request);
      if (new URL(input.toString()).hostname === "oauth2.googleapis.com") {
        return Response.json({ refresh_token: "refresh-token", id_token: idToken, scope: consentScopes.join(" ") });
      }
      return Response.json({ keys: [{ ...publicJwk, kid: "google-key", alg: "RS256", use: "sig" }] } satisfies GoogleJwks);
    });

    expect(result).toEqual({
      subject: "google-stable-sub",
      email: "sam@example.test",
      refreshToken: "refresh-token",
      // The stored grant is what Google actually reported, not a constant.
      grantedScopes: [...consentScopes].sort(),
    });
    const exchange = calls[0]!;
    const form = new URLSearchParams(await exchange.clone().text());
    expect(exchange.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(Object.fromEntries(form)).toEqual({
      client_id: clientId,
      client_secret: "provider-secret",
      code: "google-code",
      code_verifier: "verifier",
      grant_type: "authorization_code",
      redirect_uri: "https://control.test/oauth/google/callback",
    });
  });

  test("accepts API scopes from the access token when identity is proven by the signed id_token", async () => {
    const idToken = await sign({ aud: clientId, sub: "google-stable-sub", email: "sam@example.test", email_verified: true });
    const providerScopes = [...DEFAULT_GOOGLE_PROVIDER_SCOPES];

    const result = await exchangeGoogleCode({
      clientId,
      clientSecret: "provider-secret",
      code: "google-code",
      codeVerifier: "verifier",
      redirectUri: "https://control.test/oauth/google/callback",
      requiredScopes: providerScopes,
    }, async (input) => {
      if (new URL(input.toString()).hostname === "oauth2.googleapis.com") {
        return Response.json({ refresh_token: "refresh-token", id_token: idToken, scope: providerScopes.join(" ") });
      }
      return Response.json({ keys: [{ ...publicJwk, kid: "google-key", alg: "RS256", use: "sig" }] } satisfies GoogleJwks);
    });

    expect(result.grantedScopes).toEqual([...providerScopes].sort());
  });

  test("the grant floor is the Provider App's configured scopes, not a compiled constant", async () => {
    const idToken = await sign({ aud: clientId, sub: "sub", email: "x@example.test", email_verified: true });
    const calendar = "https://www.googleapis.com/auth/calendar.readonly";

    // A grant covering the configured set succeeds even though it covers none
    // of the historical default scopes.
    const result = await exchangeGoogleCode({
      clientId,
      clientSecret: "secret",
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "https://control.test/callback",
      requiredScopes: [calendar],
    }, googleFetcher({ idToken, token: { refresh_token: "refresh", scope: `openid email ${calendar}` } }));
    expect(result.grantedScopes).toContain(calendar);

    // A grant missing a configured scope fails, whatever else it includes.
    await expect(exchangeGoogleCode({
      clientId,
      clientSecret: "secret",
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "https://control.test/callback",
      requiredScopes: [calendar],
    }, googleFetcher({ idToken, token: { refresh_token: "refresh", scope: googleConsentScopes(DEFAULT_GOOGLE_PROVIDER_SCOPES).join(" ") } })))
      .rejects.toThrow(/omitted a required scope/);
  });

  test("a partial grant fails with cleanup instructions and must not touch Google's revoke endpoint", async () => {
    // Google's revoke endpoint invalidates the whole client+user grant, not
    // just the one token — revoking here would silently break every healthy
    // Connection the same Google account already authorized through this
    // Provider App. The un-stored grant is the user's to remove, and the
    // error tells them where.
    const idToken = await sign({ aud: clientId, sub: "sub", email: "x@example.test", email_verified: true });
    const calendar = "https://www.googleapis.com/auth/calendar.readonly";
    const inner = googleFetcher({ idToken, token: { refresh_token: "partial-refresh", scope: "openid email" } });
    await expect(exchangeGoogleCode({
      clientId,
      clientSecret: "secret",
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "https://control.test/callback",
      requiredScopes: [calendar],
    }, async (request, init) => {
      if (new URL(request.toString()).pathname === "/revoke") {
        throw new Error("revocation must not be attempted for a partial grant");
      }
      return inner(request, init);
    })).rejects.toThrow(/omitted a required scope.*was not stored.*every Connection this Google account holds/);
  });

  test("rejects an unverified identity, wrong audience, expired token, or missing refresh token", async () => {
    const cases = [
      { idToken: await sign({ aud: clientId, sub: "sub", email: "x@example.test", email_verified: false }), token: { refresh_token: "refresh" } },
      { idToken: await sign({ aud: "other.apps.googleusercontent.com", sub: "sub", email: "x@example.test", email_verified: true }), token: { refresh_token: "refresh" } },
      { idToken: await sign({ aud: clientId, sub: "sub", email: "x@example.test", email_verified: true, exp: 1 }), token: { refresh_token: "refresh" } },
      { idToken: await sign({ aud: clientId, sub: "sub", email: "x@example.test", email_verified: true }), token: {} },
      { idToken: await sign({ aud: clientId, sub: "sub", email: "x@example.test", email_verified: true }), token: { refresh_token: "refresh", scope: "openid email" } },
      { idToken: await sign({ aud: clientId, sub: "sub", email: "x@example.test", email_verified: true }), token: { refresh_token: "refresh", scope: DEFAULT_GOOGLE_PROVIDER_SCOPES[0] } },
      { idToken: await sign({ aud: clientId, sub: "sub", email: "x@example.test", email_verified: true }), token: { refresh_token: "refresh", scope: DEFAULT_GOOGLE_PROVIDER_SCOPES[1] } },
    ];
    for (const candidate of cases) {
      await expect(exchangeGoogleCode({ clientId, clientSecret: "secret", code: "code", codeVerifier: "verifier", redirectUri: "https://control.test/callback", requiredScopes: DEFAULT_GOOGLE_PROVIDER_SCOPES }, googleFetcher(candidate)))
        .rejects.toThrow(/Google OAuth/);
    }
  });

  test("revokes through Google's endpoint and fails closed on a non-success response", async () => {
    const calls: Request[] = [];
    await expect(revokeGoogleRefreshToken("refresh-token", async (input, init) => {
      calls.push(makeRequest(input, init));
      return new Response(null, { status: 204 });
    })).resolves.toBeUndefined();
    const form = new URLSearchParams(await calls[0]!.clone().text());
    expect(calls[0]!.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(Object.fromEntries(form)).toEqual({ token: "refresh-token" });
    await expect(revokeGoogleRefreshToken("refresh-token", async () => new Response("no", { status: 500 })))
      .rejects.toThrow(/Google OAuth revocation failed/);
  });
});

function googleFetcher(candidate: { idToken: string; token: Record<string, unknown> }) {
  return async (input: string | URL, _init?: RequestInit) => {
    if (new URL(input.toString()).hostname === "oauth2.googleapis.com") {
      return Response.json({
        ...candidate.token,
        id_token: candidate.idToken,
        scope: candidate.token.scope ?? googleConsentScopes(DEFAULT_GOOGLE_PROVIDER_SCOPES).join(" "),
      });
    }
    return Response.json({ keys: [{ ...publicJwk, kid: "google-key", alg: "RS256", use: "sig" }] } satisfies GoogleJwks);
  };
}

function makeRequest(input: string | URL, init?: RequestInit): Request {
  return new globalThis.Request(input.toString(), init);
}

async function sign(claims: Record<string, unknown>): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: "google-key" };
  const payload = { iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 300, ...claims };
  const encoded = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(encoded));
  return `${encoded}.${base64url(new Uint8Array(signature))}`;
}

function base64url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
}
