import { describe, expect, test } from "bun:test";
import {
  GOOGLE_CONSENT_SCOPES,
  GOOGLE_PROVIDER_SCOPES,
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
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
  test("authorize URL requests the fixed offline consent scopes with PKCE", () => {
    const url = new URL(buildGoogleAuthorizeUrl({
      clientId,
      redirectUri: "https://control.test/oauth/google/callback",
      state: "opaque-state",
      codeChallenge: "challenge",
    }));

    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...GOOGLE_CONSENT_SCOPES]);
  });

  test("exchanges a code only after verifying Google identity and requires a refresh token", async () => {
    const idToken = await sign({ aud: clientId, sub: "google-stable-sub", email: "sam@example.test", email_verified: true });
    const calls: Request[] = [];
    const result = await exchangeGoogleCode({
      clientId,
      clientSecret: "provider-secret",
      code: "google-code",
      codeVerifier: "verifier",
      redirectUri: "https://control.test/oauth/google/callback",
    }, async (input, init) => {
      const request = makeRequest(input, init);
      calls.push(request);
      if (new URL(input.toString()).hostname === "oauth2.googleapis.com") {
        return Response.json({ refresh_token: "refresh-token", id_token: idToken, scope: GOOGLE_CONSENT_SCOPES.join(" ") });
      }
      return Response.json({ keys: [{ ...publicJwk, kid: "google-key", alg: "RS256", use: "sig" }] } satisfies GoogleJwks);
    });

    expect(result).toEqual({
      subject: "google-stable-sub",
      email: "sam@example.test",
      refreshToken: "refresh-token",
      // The stored grant is what Google actually reported, not a constant.
      grantedScopes: [...GOOGLE_CONSENT_SCOPES].sort(),
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
    const providerScopes = [...GOOGLE_PROVIDER_SCOPES];

    const result = await exchangeGoogleCode({
      clientId,
      clientSecret: "provider-secret",
      code: "google-code",
      codeVerifier: "verifier",
      redirectUri: "https://control.test/oauth/google/callback",
    }, async (input) => {
      if (new URL(input.toString()).hostname === "oauth2.googleapis.com") {
        return Response.json({ refresh_token: "refresh-token", id_token: idToken, scope: providerScopes.join(" ") });
      }
      return Response.json({ keys: [{ ...publicJwk, kid: "google-key", alg: "RS256", use: "sig" }] } satisfies GoogleJwks);
    });

    expect(result.grantedScopes).toEqual([...providerScopes].sort());
  });

  test("rejects an unverified identity, wrong audience, expired token, or missing refresh token", async () => {
    const cases = [
      { idToken: await sign({ aud: clientId, sub: "sub", email: "x@example.test", email_verified: false }), token: { refresh_token: "refresh" } },
      { idToken: await sign({ aud: "other.apps.googleusercontent.com", sub: "sub", email: "x@example.test", email_verified: true }), token: { refresh_token: "refresh" } },
      { idToken: await sign({ aud: clientId, sub: "sub", email: "x@example.test", email_verified: true, exp: 1 }), token: { refresh_token: "refresh" } },
      { idToken: await sign({ aud: clientId, sub: "sub", email: "x@example.test", email_verified: true }), token: {} },
      { idToken: await sign({ aud: clientId, sub: "sub", email: "x@example.test", email_verified: true }), token: { refresh_token: "refresh", scope: "openid email" } },
      { idToken: await sign({ aud: clientId, sub: "sub", email: "x@example.test", email_verified: true }), token: { refresh_token: "refresh", scope: GOOGLE_PROVIDER_SCOPES[0] } },
      { idToken: await sign({ aud: clientId, sub: "sub", email: "x@example.test", email_verified: true }), token: { refresh_token: "refresh", scope: GOOGLE_PROVIDER_SCOPES[1] } },
    ];
    for (const candidate of cases) {
      await expect(exchangeGoogleCode({ clientId, clientSecret: "secret", code: "code", codeVerifier: "verifier", redirectUri: "https://control.test/callback" }, googleFetcher(candidate)))
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
        scope: candidate.token.scope ?? GOOGLE_CONSENT_SCOPES.join(" "),
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
