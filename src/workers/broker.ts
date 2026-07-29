/// <reference path="../../types/broker.d.ts" />

import {
  gateReceiptMismatch,
  type GateEvaluation,
  type GateEvaluationInput,
  type GateReceiptIdentity,
} from "../gate";
import { GateRuntime } from "./gate-object";
import {
  dispatchGate,
  errorResponse,
  requireBearerToken,
  requireDistinctRoleCredentials,
  requireInternalRequest,
} from "./protocol";
import {
  DEFAULT_GOOGLE_PROVIDER_SCOPES,
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  parseProviderScopes,
  revokeGoogleRefreshToken,
  type GoogleFetch,
} from "../google-oauth";
import {
  createGoogleProvider,
  GoogleRefreshAuthorizationError,
  type GoogleProvider,
} from "../google-provider";
import type { ConnectionCredentialLease } from "../custody";
import { CredentialVault } from "./credential-vault";

export { GateRuntime };
export { CredentialVault };

interface InvokeRequest {
  runtimeId: string;
  input: GateEvaluationInput;
  expected: GateReceiptIdentity;
}

type LegacyProvider = (
  operation: string | null,
  args: Record<string, unknown>,
  connectionId: string,
) => unknown;

export default {
  async fetch(request, env): Promise<Response> {
    return handleBrokerRequest(request, env);
  },
} satisfies ExportedHandler<BrokerEnv>;

export async function handleBrokerRequest(
  request: Request,
  env: BrokerEnv,
  provider?: GoogleProvider | LegacyProvider,
  fetcher: GoogleFetch = globalThis.fetch,
): Promise<Response> {
  try {
    const activeProvider = provider === undefined
      ? createGoogleProvider(fetcher)
      : typeof provider === "function"
      ? legacyProvider(provider)
      : provider;
    await requireDistinctRoleCredentials(
      [env.CONTROL_BROKER_TOKEN, env.GATEWAY_BROKER_INVOKE_TOKEN],
      "broker role credentials must be non-empty and distinct",
    );
    const url = new URL(request.url);
    if (url.pathname === "/internal/provider-apps" && request.method === "POST") {
      await requireBearerToken(request, env.CONTROL_BROKER_TOKEN);
      const input = parseProviderApp(await request.json());
      const vault = env.CREDENTIAL_VAULTS.getByName(input.accountId);
      return vaultResponse(await vault.fetch(new Request("https://vault.internal/provider-apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })));
    }
    if (url.pathname === "/internal/provider-apps" && request.method === "GET") {
      await requireBearerToken(request, env.CONTROL_BROKER_TOKEN);
      const accountId = requiredQuery(url, "accountId");
      const vault = env.CREDENTIAL_VAULTS.getByName(accountId);
      return vaultResponse(await vault.fetch("https://vault.internal/provider-apps"));
    }
    if (url.pathname === "/internal/connections" && request.method === "GET") {
      await requireBearerToken(request, env.CONTROL_BROKER_TOKEN);
      const accountId = requiredQuery(url, "accountId");
      const vault = env.CREDENTIAL_VAULTS.getByName(accountId);
      return vaultResponse(await vault.fetch("https://vault.internal/connections"));
    }
    if (url.pathname === "/internal/oauth/authorize" && request.method === "POST") {
      await requireBearerToken(request, env.CONTROL_BROKER_TOKEN);
      const input = parseAuthorize(await request.json());
      const vault = env.CREDENTIAL_VAULTS.getByName(input.accountId);
      const app = await vaultJson(vault.fetch(`https://vault.internal/provider-apps/${encodeURIComponent(input.providerAppId)}/lease`));
      return Response.json({
        authorizationUrl: buildGoogleAuthorizeUrl({
          clientId: stringField(app.clientId, "clientId"),
          state: input.state,
          codeChallenge: input.codeChallenge,
          redirectUri: input.redirectUri,
          scopes: parseProviderScopes(app.scopes),
        }),
      });
    }
    if (url.pathname === "/internal/oauth/exchange" && request.method === "POST") {
      await requireBearerToken(request, env.CONTROL_BROKER_TOKEN);
      const input = parseExchange(await request.json());
      const vault = env.CREDENTIAL_VAULTS.getByName(input.accountId);
      const app = await vaultJson(vault.fetch(`https://vault.internal/provider-apps/${encodeURIComponent(input.providerAppId)}/lease`));
      const credentials = await exchangeGoogleCode({
        clientId: stringField(app.clientId, "clientId"),
        clientSecret: stringField(app.clientSecret, "clientSecret"),
        code: input.code,
        codeVerifier: input.codeVerifier,
        redirectUri: input.redirectUri,
        requiredScopes: parseProviderScopes(app.scopes),
      }, fetcher);
      const path = input.flow === "reauth"
        ? `https://vault.internal/connections/${encodeURIComponent(input.connectionId)}/reauth`
        : "https://vault.internal/connections";
      const stored = await vault.fetch(new Request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: input.accountId,
          connectionId: input.connectionId,
          nickname: input.nickname,
          providerAppId: input.providerAppId,
          provider: "google",
          subject: credentials.subject,
          displayName: credentials.email,
          grantedScopes: credentials.grantedScopes,
          refreshToken: credentials.refreshToken,
        }),
      }));
      if (!stored.ok) {
        // Deliberately no automatic revocation: Google's revoke endpoint
        // invalidates the whole client+user grant, which would kill the
        // account's sibling healthy Connections over a duplicate nickname or
        // an identity-mismatched reauth. The un-stored grant is the user's to
        // remove, and the error says where.
        const custodyError = await responseError(stored);
        return Response.json({
          error: `${custodyError}; the Google grant was not stored — retry.`
            + " The unused grant stays live; removing the app's access under"
            + " Google Account permissions also cuts off every Connection this"
            + " Google account holds through the same OAuth client",
        }, { status: stored.status });
      }
      return vaultResponse(stored);
    }
    if (url.pathname === "/internal/oauth/revoke" && request.method === "POST") {
      await requireBearerToken(request, env.CONTROL_BROKER_TOKEN);
      const input = parseConnectionAction(await request.json());
      const vault = env.CREDENTIAL_VAULTS.getByName(input.accountId);
      const lease = await vaultJson(vault.fetch(`https://vault.internal/connections/${encodeURIComponent(input.connectionId)}/lease`));
      await revokeGoogleRefreshToken(stringField(lease.refreshToken, "refreshToken"), fetcher);
      return vaultResponse(await vault.fetch(new Request(`https://vault.internal/connections/${encodeURIComponent(input.connectionId)}/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: input.accountId }) })));
    }
    if (url.pathname === "/internal/oauth/remove" && request.method === "POST") {
      await requireBearerToken(request, env.CONTROL_BROKER_TOKEN);
      const input = parseConnectionAction(await request.json());
      const vault = env.CREDENTIAL_VAULTS.getByName(input.accountId);
      const summary = await vaultJson(vault.fetch(`https://vault.internal/connections/${encodeURIComponent(input.connectionId)}`));
      if (summary.health !== "revoked") {
        const lease = await vaultJson(vault.fetch(`https://vault.internal/connections/${encodeURIComponent(input.connectionId)}/lease-revocation`));
        await revokeGoogleRefreshToken(stringField(lease.refreshToken, "refreshToken"), fetcher);
      }
      return vaultResponse(await vault.fetch(new Request(`https://vault.internal/connections/${encodeURIComponent(input.connectionId)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: input.accountId }) })));
    }
    if (url.pathname === "/internal/gate") {
      const input = await requireInternalRequest(request, env.CONTROL_BROKER_TOKEN);
      if (input.gate !== "broker") return Response.json({ error: "wrong gate" }, { status: 400 });
      return Response.json(await dispatchGate(env.GATES, input));
    }
    if (url.pathname === "/internal/invoke") {
      await requireBearerToken(request, env.GATEWAY_BROKER_INVOKE_TOKEN);
      const body = parseInvokeRequest(await request.json());
      const gate = env.GATES.getByName(body.runtimeId);
      const evaluation = JSON.parse(
        await gate.evaluateJson("broker", body.input),
      ) as GateEvaluation;
      const mismatch = gateReceiptMismatch(body.expected, evaluation.receipt);
      if (mismatch !== null) {
        return Response.json(
          { error: "gate receipt mismatch", mismatch, evaluation },
          { status: 409 },
        );
      }
      if (!evaluation.allowed) return Response.json({ evaluation }, { status: 403 });
      if (evaluation.receipt.connectionId === null) {
        throw new Error("allowed Broker evaluation is missing a Connection ID");
      }
      if (evaluation.receipt.operation === null) {
        throw new Error("allowed Broker evaluation is missing a provider operation");
      }
      if (evaluation.execution === undefined) {
        throw new Error("allowed Broker evaluation is missing its sealed execution data");
      }
      // The Broker executes exactly what the artifact sealed: the gate hands
      // over the matched tool's request template and pinned origin. prepare
      // runs before custody so a malformed call never reaches the vault.
      const prepared = activeProvider.prepare({
        operation: evaluation.receipt.operation,
        origin: evaluation.execution.origin,
        request: evaluation.execution.request,
        args: evaluation.effectiveArguments,
      });
      const accountId = evaluation.receipt.accountId;
      const connectionId = evaluation.receipt.connectionId;
      const vault = env.CREDENTIAL_VAULTS.getByName(accountId);
      const lease = parseConnectionLease(
        await vaultJson(vault.fetch(`https://vault.internal/connections/${encodeURIComponent(connectionId)}/lease`)),
        accountId,
        connectionId,
      );
      let result: Record<string, unknown>;
      try {
        result = await activeProvider.invoke(prepared, lease);
      } catch (error) {
        if (error instanceof GoogleRefreshAuthorizationError) {
          await markConnectionError(vault, accountId, connectionId);
        }
        throw error;
      }
      return Response.json({
        evaluation,
        result,
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}

function parseProviderApp(value: unknown) {
  // scopes is absent from a pre-scope Control's POST during a deploy window
  // (Broker deploys before Control); absent means the historical default.
  const keys = ["accountId", "providerAppId", "provider", "displayName", "clientId", "clientSecret"];
  const body = exactRecord(value, isRecord(value) && "scopes" in value ? [...keys, "scopes"] : keys);
  if (body.provider !== "google") throw new Error("provider must be google");
  return {
    accountId: stringField(body.accountId, "accountId"),
    providerAppId: stringField(body.providerAppId, "providerAppId"),
    provider: "google" as const,
    displayName: stringField(body.displayName, "displayName"),
    clientId: stringField(body.clientId, "clientId"),
    clientSecret: stringField(body.clientSecret, "clientSecret"),
    scopes: "scopes" in body ? parseProviderScopes(body.scopes) : [...DEFAULT_GOOGLE_PROVIDER_SCOPES],
  };
}

function parseExchange(value: unknown) {
  const body = exactRecord(value, ["accountId", "providerAppId", "connectionId", "nickname", "flow", "code", "codeVerifier", "redirectUri"]);
  return {
    accountId: stringField(body.accountId, "accountId"),
    providerAppId: stringField(body.providerAppId, "providerAppId"),
    connectionId: stringField(body.connectionId, "connectionId"),
    nickname: stringField(body.nickname, "nickname"),
    flow: flowField(body.flow),
    code: stringField(body.code, "code"),
    codeVerifier: stringField(body.codeVerifier, "codeVerifier"),
    redirectUri: stringField(body.redirectUri, "redirectUri"),
  };
}

function flowField(value: unknown): "create" | "reauth" {
  if (value !== "create" && value !== "reauth") throw new Error("flow is invalid");
  return value;
}

function parseAuthorize(value: unknown) {
  const body = exactRecord(value, ["accountId", "providerAppId", "state", "codeChallenge", "redirectUri"]);
  return {
    accountId: stringField(body.accountId, "accountId"),
    providerAppId: stringField(body.providerAppId, "providerAppId"),
    state: stringField(body.state, "state"),
    codeChallenge: stringField(body.codeChallenge, "codeChallenge"),
    redirectUri: stringField(body.redirectUri, "redirectUri"),
  };
}

function parseConnectionAction(value: unknown) {
  const body = exactRecord(value, ["accountId", "connectionId"]);
  return { accountId: stringField(body.accountId, "accountId"), connectionId: stringField(body.connectionId, "connectionId") };
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("request body must be an object");
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`request must contain exactly ${expected.join(", ")}`);
  return result;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredQuery(url: URL, key: string): string {
  return stringField(url.searchParams.get(key), key);
}

async function vaultJson(input: Promise<Response>): Promise<Record<string, unknown>> {
  const response = await input;
  if (!response.ok) throw new Error(await responseError(response));
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Credential Vault response is invalid");
  return value as Record<string, unknown>;
}

async function vaultResponse(response: Response): Promise<Response> {
  const body = await response.text();
  return new Response(body, { status: response.status, headers: { "content-type": "application/json" } });
}

async function responseError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.clone().json();
    if (typeof body === "object" && body !== null && !Array.isArray(body) && typeof (body as { error?: unknown }).error === "string") {
      return (body as { error: string }).error;
    }
  } catch {
    // The status remains useful when a private service returns malformed JSON.
  }
  return `Credential Vault request failed with status ${response.status}`;
}

function parseInvokeRequest(value: unknown): InvokeRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invoke request must be an object");
  }
  const runtimeId = (value as { runtimeId?: unknown }).runtimeId;
  const input = (value as { input?: unknown }).input;
  const expected = (value as { expected?: unknown }).expected;
  if (typeof runtimeId !== "string" || runtimeId === "") {
    throw new Error("invoke runtimeId is required");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("invoke input must be an object");
  }
  if (!isGateReceiptIdentity(expected)) throw new Error("invoke expected gate receipt is required");
  return { runtimeId, input: input as GateEvaluationInput, expected };
}

function isGateReceiptIdentity(value: unknown): value is GateReceiptIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.deploymentId === "string"
    && Number.isInteger(candidate.version)
    && typeof candidate.policyDigest === "string"
    && typeof candidate.bindingsDigest === "string"
    && typeof candidate.availabilityDigest === "string"
    && typeof candidate.tool === "string"
    && candidate.tool !== ""
    && typeof candidate.connectionRef === "string"
    && candidate.connectionRef !== "";
}

async function markConnectionError(
  vault: DurableObjectStub<CredentialVault>,
  accountId: string,
  connectionId: string,
): Promise<void> {
  const response = await vault.fetch(new Request(
    `https://vault.internal/connections/${encodeURIComponent(connectionId)}/error`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId }),
    },
  ));
  if (!response.ok) {
    throw new Error(`Google refresh authorization failed; ${await responseError(response)}`);
  }
}

function parseConnectionLease(
  value: Record<string, unknown>,
  accountId: string,
  connectionId: string,
): ConnectionCredentialLease {
  if (!isStringRecord(value, [
    "accountId",
    "connectionId",
    "providerAppId",
    "clientId",
    "clientSecret",
    "refreshToken",
    "subject",
  ])) {
    throw new Error("Credential Vault returned a mismatched Connection lease");
  }
  if (
    value.accountId !== accountId
    || value.connectionId !== connectionId
    || value.provider !== "google"
    || !Array.isArray(value.grantedScopes)
    || !value.grantedScopes.every((scope) => typeof scope === "string")
  ) {
    throw new Error("Credential Vault returned a mismatched Connection lease");
  }
  const text = value as Record<string, string>;
  return {
    accountId,
    connectionId,
    providerAppId: text.providerAppId!,
    provider: "google",
    clientId: text.clientId!,
    clientSecret: text.clientSecret!,
    refreshToken: text.refreshToken!,
    subject: text.subject!,
    grantedScopes: value.grantedScopes,
  };
}

function isStringRecord(value: Record<string, unknown>, keys: readonly string[]): value is Record<string, string> {
  return keys.every((key) => typeof value[key] === "string" && value[key] !== "");
}

function legacyProvider(provider: LegacyProvider): GoogleProvider {
  return {
    prepare(invocation) {
      return { operation: invocation.operation, args: invocation.args, call: null };
    },
    async invoke(prepared, lease) {
      const result: unknown = await provider(
        prepared.operation,
        prepared.args,
        lease.connectionId,
      );
      if (!isRecord(result)) throw new Error("deterministic provider returned an invalid result");
      return result;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
