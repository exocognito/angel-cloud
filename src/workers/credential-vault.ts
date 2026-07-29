/// <reference path="../../types/broker.d.ts" />

import { DurableObject } from "cloudflare:workers";
import {
  CustodyOwnershipError,
  EnvelopeCustody,
  type StoreConnectionInput,
  type StoreProviderAppInput,
} from "../custody";
import { DEFAULT_GOOGLE_PROVIDER_SCOPES, parseProviderScopes } from "../google-oauth";

const STATE_KEY = "custody";

export class CredentialVault extends DurableObject<BrokerEnv> {
  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(() => this.handle(request));
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const accountId = this.ctx.id.name;
      if (typeof accountId !== "string" || accountId === "") throw new Error("vault Account is missing");
      const url = new URL(request.url);
      const body = request.method === "GET" ? undefined : await request.json() as unknown;
      if (body !== undefined && (!isRecord(body) || body.accountId !== accountId)) {
        return Response.json({ error: "vault Account mismatch" }, { status: 403 });
      }
      const custody = await this.custody();
      if (url.pathname === "/provider-apps" && request.method === "POST") {
        const result = await custody.storeProviderApp(parseProviderApp(body, accountId));
        await this.persist(custody);
        return Response.json(result);
      }
      if (url.pathname === "/provider-apps" && request.method === "GET") {
        return Response.json(Object.values(custody.exportState().accounts[accountId]?.providerApps ?? {}).map((app) => ({
          id: app.id,
          accountId: app.accountId,
          provider: app.provider,
          displayName: app.displayName,
          clientIdSuffix: app.clientId.slice(-15),
          scopes: [...(app.scopes ?? DEFAULT_GOOGLE_PROVIDER_SCOPES)],
        })));
      }
      const providerAppLease = /^\/provider-apps\/([^/]+)\/lease$/.exec(url.pathname);
      if (providerAppLease !== null && request.method === "GET") {
        return Response.json(await custody.leaseProviderApp(accountId, decodeURIComponent(providerAppLease[1]!)));
      }
      if (url.pathname === "/connections" && request.method === "POST") {
        const result = await custody.storeConnection(parseConnection(body, accountId));
        await this.persist(custody);
        return Response.json(result);
      }
      if (url.pathname === "/connections" && request.method === "GET") {
        return Response.json(Object.values(custody.exportState().accounts[accountId]?.connections ?? {}).map((connection) => ({
          id: connection.id,
          accountId: connection.accountId,
          nickname: connection.nickname,
          providerAppId: connection.providerAppId,
          provider: connection.provider,
          displayName: connection.displayName,
          grantedScopes: [...connection.grantedScopes],
          health: connection.health,
        })));
      }
      const connection = /^\/connections\/([^/]+)$/.exec(url.pathname);
      const connectionLease = /^\/connections\/([^/]+)\/lease$/.exec(url.pathname);
      if (connectionLease !== null && request.method === "GET") {
        return Response.json(await custody.leaseConnection(accountId, decodeURIComponent(connectionLease[1]!)));
      }
      const revocationLease = /^\/connections\/([^/]+)\/lease-revocation$/.exec(url.pathname);
      if (revocationLease !== null && request.method === "GET") {
        return Response.json(await custody.leaseConnectionForRevocation(accountId, decodeURIComponent(revocationLease[1]!)));
      }
      if (connection !== null && request.method === "GET") {
        return Response.json(custody.getConnection(accountId, decodeURIComponent(connection[1]!)));
      }
      const replace = /^\/connections\/([^/]+)\/reauth$/.exec(url.pathname);
      if (replace !== null && request.method === "POST") {
        const result = await custody.replaceConnection(parseConnection(body, accountId, decodeURIComponent(replace[1]!)));
        await this.persist(custody);
        return Response.json(result);
      }
      const revoke = /^\/connections\/([^/]+)\/revoke$/.exec(url.pathname);
      if (revoke !== null && request.method === "POST") {
        const result = custody.markConnectionHealth(accountId, decodeURIComponent(revoke[1]!), "revoked");
        await this.persist(custody);
        return Response.json(result);
      }
      const error = /^\/connections\/([^/]+)\/error$/.exec(url.pathname);
      if (error !== null && request.method === "POST") {
        const result = custody.markConnectionHealth(accountId, decodeURIComponent(error[1]!), "error");
        await this.persist(custody);
        return Response.json(result);
      }
      const remove = /^\/connections\/([^/]+)$/.exec(url.pathname);
      if (remove !== null && request.method === "DELETE") {
        custody.removeConnection(accountId, decodeURIComponent(remove[1]!));
        await this.persist(custody);
        return Response.json({ removed: true });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (error) {
      const status = error instanceof CustodyOwnershipError ? 404 : 400;
      return Response.json({ error: error instanceof Error ? error.message : "vault request failed" }, { status });
    }
  }

  private async custody(): Promise<EnvelopeCustody> {
    const key = await credentialKek(this.env.CREDENTIAL_KEK);
    const state = await this.ctx.storage.get<import("../custody").CustodyState>(STATE_KEY);
    return EnvelopeCustody.create(key, state);
  }

  private async persist(custody: EnvelopeCustody): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, custody.exportState());
  }
}

async function credentialKek(value: string): Promise<Uint8Array> {
  if (typeof value !== "string" || value === "") throw new Error("CREDENTIAL_KEK must be canonical base64");
  let decoded: Uint8Array;
  try {
    const binary = atob(value);
    decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("CREDENTIAL_KEK must be canonical base64");
  }
  if (btoa(String.fromCharCode(...decoded)) !== value || decoded.byteLength !== 32) {
    throw new Error("CREDENTIAL_KEK must decode to exactly 32 bytes");
  }
  return decoded;
}

function parseProviderApp(value: unknown, accountId: string): StoreProviderAppInput {
  // scopes is absent from a pre-scope Control's POST during a deploy window
  // (Broker deploys before Control); absent means the historical default.
  const keys = ["accountId", "providerAppId", "provider", "displayName", "clientId", "clientSecret"];
  const body = exactRecord(value, isRecord(value) && "scopes" in value ? [...keys, "scopes"] : keys);
  if (body.accountId !== accountId || body.provider !== "google") throw new Error("provider app Account or provider is invalid");
  return {
    accountId,
    providerAppId: nonEmpty(body.providerAppId, "providerAppId"),
    provider: "google",
    displayName: nonEmpty(body.displayName, "displayName"),
    clientId: nonEmpty(body.clientId, "clientId"),
    clientSecret: nonEmpty(body.clientSecret, "clientSecret"),
    scopes: "scopes" in body ? parseProviderScopes(body.scopes) : [...DEFAULT_GOOGLE_PROVIDER_SCOPES],
  };
}

function parseConnection(value: unknown, accountId: string, connectionId?: string): StoreConnectionInput {
  const body = exactRecord(value, ["accountId", "connectionId", "nickname", "providerAppId", "provider", "subject", "displayName", "grantedScopes", "refreshToken"]);
  if (body.accountId !== accountId || body.provider !== "google") throw new Error("Connection Account or provider is invalid");
  if (connectionId !== undefined && body.connectionId !== connectionId) throw new Error("Connection ID is invalid");
  if (!Array.isArray(body.grantedScopes) || !body.grantedScopes.every((scope) => typeof scope === "string" && scope !== "")) throw new Error("grantedScopes is invalid");
  return {
    accountId,
    connectionId: nonEmpty(connectionId ?? body.connectionId, "connectionId"),
    nickname: nonEmpty(body.nickname, "nickname"),
    providerAppId: nonEmpty(body.providerAppId, "providerAppId"),
    provider: "google",
    subject: nonEmpty(body.subject, "subject"),
    displayName: nonEmpty(body.displayName, "displayName"),
    grantedScopes: body.grantedScopes,
    refreshToken: nonEmpty(body.refreshToken, "refreshToken"),
  };
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("request body must be an object");
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`request must contain exactly ${expected.join(", ")}`);
  return result;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
