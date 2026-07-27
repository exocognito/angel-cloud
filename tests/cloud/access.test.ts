import { describe, expect, test } from "bun:test";
import { AccessAuthenticationError, authenticateAccessRequest, type AccessJwk, type AccessJwks } from "../../src/access";

const TEAM_DOMAIN = "https://angel.cloudflareaccess.com";
const AUDIENCE = "access-audience";
const ACCOUNT_ID = "acct_m1";

const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey) as unknown as AccessJwk;

describe("Cloudflare Access identity verification", () => {
  test("accepts a signed browser identity and maps it to the M1 Account", async () => {
    const token = await sign({ sub: "user-sub", email: "sam@example.test", aud: [AUDIENCE] });

    await expect(authenticateAccessRequest(
      new Request("https://control.test/" , { headers: { "Cf-Access-Jwt-Assertion": token } }),
      config(),
      jwksFetcher(),
    )).resolves.toEqual({ accountId: ACCOUNT_ID, subject: "user-sub", email: "sam@example.test" });
  });

  test("accepts a service token with empty sub only when common_name identifies it", async () => {
    const token = await sign({ sub: "", common_name: "ci-service", aud: AUDIENCE });

    await expect(authenticateAccessRequest(
      new Request("https://control.test/", { headers: { "Cf-Access-Jwt-Assertion": token } }),
      config(),
      jwksFetcher(),
    )).resolves.toEqual({ accountId: ACCOUNT_ID, subject: "ci-service", commonName: "ci-service" });
  });

  test("rejects forged, wrong-audience, and expired assertions", async () => {
    const valid = { sub: "user-sub", aud: [AUDIENCE] };
    const forged = `${await unsigned(valid)}.forged`;
    const wrongAudience = await sign({ ...valid, aud: ["other-audience"] });
    const expired = await sign({ ...valid, exp: 1 });

    for (const token of [forged, wrongAudience, expired]) {
      await expect(authenticateAccessRequest(
        new Request("https://control.test/", { headers: { "Cf-Access-Jwt-Assertion": token } }),
        config(),
        jwksFetcher(),
      )).rejects.toThrow(/Access JWT/);
    }
  });

  test("keeps verifier outages distinct from expected authentication rejection", async () => {
    await expect(authenticateAccessRequest(
      new Request("https://control.test/"),
      config(),
      async () => { throw new Error("JWKS service unavailable"); },
    )).rejects.toThrow("Access JWT is required");
    await expect(authenticateAccessRequest(
      new Request("https://control.test/", { headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" } }),
      config(),
      jwksFetcher(),
    )).rejects.toBeInstanceOf(AccessAuthenticationError);
    await expect(authenticateAccessRequest(
      new Request("https://control.test/", { headers: { "Cf-Access-Jwt-Assertion": await sign({ sub: "user-sub", aud: AUDIENCE }) } }),
      config(),
      async () => { throw new Error("JWKS service unavailable"); },
    )).rejects.toThrow("JWKS service unavailable");
  });
});

function config() {
  return { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, accountId: ACCOUNT_ID };
}

function jwksFetcher() {
  const jwks: AccessJwks = { keys: [{ ...publicJwk, kid: "access-key", alg: "RS256", use: "sig" }] };
  return async () => Response.json(jwks);
}

async function sign(claims: Record<string, unknown>): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: "access-key" };
  const payload = {
    iss: TEAM_DOMAIN,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  };
  const encoded = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(encoded),
  );
  return `${encoded}.${base64url(new Uint8Array(signature))}`;
}

async function unsigned(claims: Record<string, unknown>): Promise<string> {
  return `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "access-key" }))}.${base64url(JSON.stringify({ iss: TEAM_DOMAIN, exp: Math.floor(Date.now() / 1000) + 300, ...claims }))}`;
}

function base64url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
}
