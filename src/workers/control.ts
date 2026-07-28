import type { DeploymentEnvironment } from "../domain";
import type {
  DeployStagingRequest,
  ManagementBindingMap,
  ManagementAvailabilityChange,
  ManagementCommand,
  ManagementVersionArtifact,
  MutationIdentity,
  PromoteProductionRequest,
  PublishVersionRequest,
} from "../management-contract";
import {
  AccountRegistry,
  type AccountRegistryCommand,
  type DemoAction,
} from "./account-registry";
import {
  HttpError,
  requireBearerToken,
  requireDistinctRoleCredentials,
} from "./protocol";
import { AccessAuthenticationError, authenticateAccessRequest, type AccessIdentity } from "../access";
import { DEFAULT_GOOGLE_PROVIDER_SCOPES, parseProviderScopes } from "../google-oauth";
import { issueOAuthState, type OAuthStateRecord } from "../oauth-state";
import {
  managementConnectionsFromProviderSummaries,
  type ConnectionSummary,
  type ProviderAppSummary,
} from "../provider-management";

export { AccountRegistry };

interface RegistryStub {
  dispatchJson(command: AccountRegistryCommand): Promise<string>;
}

export interface ControlRequestEnv {
  CONTROL_BROKER_TOKEN: string;
  CONTROL_GATEWAY_TOKEN: string;
  CONTROL_RESPONSE_KEK: string;
  ACCOUNT_ID: string;
  DEMO_ADMIN_TOKEN: string;
  MANAGEMENT_API_TOKEN: string;
  GATEWAY_BASE_URL: string;
  ACCOUNTS: { getByName(name: string): RegistryStub };
  ASSETS: { fetch(request: Request): Promise<Response> };
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUDIENCE: string;
  CONTROL_BASE_URL: string;
  BROKER: { fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> };
}

export type AccessVerifier = (request: Request, env: ControlRequestEnv) => Promise<import("../access").AccessIdentity>;

export async function handleControlRequest(
  request: Request,
  env: ControlRequestEnv,
  verifyAccess: AccessVerifier = defaultAccessVerifier,
): Promise<Response> {
  const url = new URL(request.url);
  let accessIdentity: AccessIdentity;
  try {
    accessIdentity = await verifyAccess(request, env);
  } catch (error) {
    if (error instanceof AccessAuthenticationError) {
      return Response.json({ error: "Access authentication required" }, { status: 401 });
    }
    return Response.json({ error: "Access authentication verifier failed" }, { status: 500 });
  }
  const isProviderPath = isProviderApiPath(url.pathname) || url.pathname === "/oauth/google/callback";
  if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/v1/") && !isProviderPath) {
    return env.ASSETS.fetch(request);
  }

  try {
    await requireDistinctRoleCredentials(
      [
        env.DEMO_ADMIN_TOKEN,
        env.MANAGEMENT_API_TOKEN,
        env.CONTROL_GATEWAY_TOKEN,
        env.CONTROL_BROKER_TOKEN,
        env.CONTROL_RESPONSE_KEK,
      ],
      "Control role credentials must be non-empty and pairwise distinct",
    );
    if (env.CONTROL_RESPONSE_KEK.trim() === "") {
      throw new HttpError(500, "Control response replay key must be non-empty");
    }
    if (isProviderPath) {
      return await providerRequest(request, env, accessIdentity);
    }
    if (url.pathname.startsWith("/v1/")) {
      await requireBearer(request, env.MANAGEMENT_API_TOKEN, "management authorization required");
      const routed = await managementCommand(request, url, accessIdentity.accountId);
      const registry = env.ACCOUNTS.getByName(routed.accountId);
      return registryResponse(await registry.dispatchJson(routed.command));
    }

    const registry = env.ACCOUNTS.getByName(accessIdentity.accountId);
    let command: AccountRegistryCommand;
    if (url.pathname === "/api/demo/state" && request.method === "GET") {
      command = { operation: "state" };
    } else if (url.pathname === "/api/demo/reset" && request.method === "POST") {
      await requireAdmin(request, env.DEMO_ADMIN_TOKEN);
      command = { operation: "reset" };
    } else if (url.pathname === "/api/demo/action" && request.method === "POST") {
      command = parseAction(await requestJson(request));
    } else {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return registryResponse(await registry.dispatchJson(command));
  } catch (error) {
    if (error instanceof HttpError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof RequestError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({
      error: error instanceof Error ? error.message : "control request failed",
    }, { status: 500 });
  }
}

function isProviderApiPath(pathname: string): boolean {
  return pathname === "/api/provider-apps"
    || /^\/api\/provider-apps\/[^/]+$/.test(pathname)
    || pathname === "/api/connections"
    || /^\/api\/connections\/[^/]+$/.test(pathname)
    || /^\/api\/connections\/[^/]+\/(reauthorize|revoke)$/.test(pathname)
    || pathname === "/api/connections/authorize";
}

async function providerRequest(
  request: Request,
  env: ControlRequestEnv,
  identity: AccessIdentity,
): Promise<Response> {
  const url = new URL(request.url);
  const accountId = identity.accountId;
  const registry = env.ACCOUNTS.getByName(accountId);
  if (url.pathname === "/api/provider-apps" && request.method === "GET") {
    const providerApps = await brokerProviderApps(env, accountId);
    await registryValue(registry, { operation: "reconcile_provider_apps", accountId, providerApps });
    return Response.json(providerApps);
  }
  if (url.pathname === "/api/provider-apps" && request.method === "POST") {
    const body = parseProviderAppRequest(await requestJson(request));
    const summary = parseProviderAppSummary(await brokerJson(env, "/internal/provider-apps", "POST", {
      ...body,
      accountId,
    }));
    await registryValue(registry, { operation: "save_provider_app", accountId, summary });
    return Response.json(summary);
  }
  if (/^\/api\/provider-apps\/[^/]+$/.test(url.pathname) && request.method === "DELETE") {
    throw new RequestError(501, "Provider App removal is not in scope for M1");
  }
  if (url.pathname === "/api/connections" && request.method === "GET") {
    return Response.json(await reconcileProviderConnections(env, registry, accountId));
  }
  if (url.pathname === "/api/connections/authorize" && request.method === "POST") {
    const body = parseCreateAuthorizationRequest(await requestJson(request));
    return startGoogleAuthorization(env, registry, identity, {
      providerAppId: body.providerAppId,
      connectionId: newConnectionId(),
      nickname: body.nickname,
      flow: "create",
    });
  }
  const reauthorize = matchPath(url.pathname, /^\/api\/connections\/([^/]+)\/reauthorize$/);
  if (reauthorize !== null && request.method === "POST") {
    exactKeys(record(await requestJson(request)), []);
    const connection = await providerConnection(env, registry, accountId, reauthorize[0]!);
    return startGoogleAuthorization(env, registry, identity, {
      providerAppId: connection.providerAppId,
      connectionId: connection.id,
      nickname: connection.nickname,
      flow: "reauth",
    });
  }
  if (url.pathname === "/oauth/google/callback" && request.method === "GET") {
    const state = requiredString(url.searchParams.get("state"), "state");
    const code = requiredString(url.searchParams.get("code"), "code");
    const taken = parseTakenOAuthState(await registryValue(registry, {
      operation: "take_oauth_state",
      accountId,
      state,
      accessSubject: identity.subject,
      now: Date.now(),
    }));
    const summary = parseConnectionSummary(await brokerJson(env, "/internal/oauth/exchange", "POST", {
      accountId,
      providerAppId: taken.providerAppId,
      connectionId: taken.connectionId,
      nickname: taken.nickname,
      flow: taken.flow,
      code,
      codeVerifier: taken.codeVerifier,
      redirectUri: taken.redirectUri,
    }));
    await registryValue(registry, { operation: "save_provider_connection", accountId, summary });
    return Response.redirect(fixedUiRedirect(env), 303);
  }
  const revoke = matchPath(url.pathname, /^\/api\/connections\/([^/]+)\/revoke$/);
  if (revoke !== null && request.method === "POST") {
    const summary = parseConnectionSummary(await brokerJson(env, "/internal/oauth/revoke", "POST", {
      accountId,
      connectionId: revoke[0],
    }));
    await registryValue(registry, { operation: "save_provider_connection", accountId, summary });
    return Response.json(summary);
  }
  const connectionPath = matchPath(url.pathname, /^\/api\/connections\/([^/]+)$/);
  if (connectionPath !== null && request.method === "GET") {
    return Response.json(await providerConnection(env, registry, accountId, connectionPath[0]!));
  }
  if (connectionPath !== null && request.method === "DELETE") {
    const connectionId = connectionPath[0]!;
    const result = await brokerJson(env, "/internal/oauth/remove", "POST", {
      accountId,
      connectionId,
    });
    await registryValue(registry, { operation: "remove_provider_connection", accountId, connectionId });
    return Response.json(result);
  }
  throw new RequestError(404, "not found");
}

async function startGoogleAuthorization(
  env: ControlRequestEnv,
  registry: RegistryStub,
  identity: AccessIdentity,
  input: { providerAppId: string; connectionId: string; nickname: string; flow: "create" | "reauth" },
): Promise<Response> {
  const issued = await issueOAuthState({
    accountId: identity.accountId,
    accessSubject: identity.subject,
    providerAppId: input.providerAppId,
    connectionId: input.connectionId,
    nickname: input.nickname,
    redirectUri: fixedRedirectUri(env),
    flow: input.flow,
  });
  await registryValue(registry, { operation: "put_oauth_state", accountId: identity.accountId, state: issued.record });
  const result = await brokerJson(env, "/internal/oauth/authorize", "POST", {
    accountId: identity.accountId,
    providerAppId: input.providerAppId,
    state: issued.state,
    codeChallenge: issued.record.codeChallenge,
    redirectUri: issued.record.redirectUri,
  });
  return Response.json(result);
}

async function providerConnection(
  env: ControlRequestEnv,
  registry: RegistryStub,
  accountId: string,
  connectionId: string,
): Promise<ConnectionSummary> {
  const connections = await reconcileProviderConnections(env, registry, accountId);
  const connection = connections.find((candidate): candidate is ConnectionSummary => isConnectionSummary(candidate) && candidate.id === connectionId);
  if (connection === undefined) throw new RequestError(404, "Connection not found");
  return connection;
}

async function brokerProviderApps(env: ControlRequestEnv, accountId: string): Promise<ProviderAppSummary[]> {
  const value = await brokerJson(env, `/internal/provider-apps?accountId=${encodeURIComponent(accountId)}`, "GET");
  if (!Array.isArray(value) || !value.every(isProviderAppSummary)) throw new Error("Broker returned an invalid Provider App list");
  return value;
}

async function reconcileProviderConnections(
  env: ControlRequestEnv,
  registry: RegistryStub,
  accountId: string,
): Promise<ConnectionSummary[]> {
  const value = await brokerJson(env, `/internal/connections?accountId=${encodeURIComponent(accountId)}`, "GET");
  if (!Array.isArray(value) || !value.every(isConnectionSummary)) throw new Error("Broker returned an invalid Connection list");
  const connections = value;
  await registryValue(registry, { operation: "reconcile_provider_connections", accountId, connections });
  return connections;
}

function fixedRedirectUri(env: ControlRequestEnv): string {
  return new URL("/oauth/google/callback", fixedControlBase(env)).toString();
}

function newConnectionId(): string {
  return `con_${crypto.randomUUID().replaceAll("-", "")}`;
}

function fixedUiRedirect(env: ControlRequestEnv): string {
  return new URL("/?connection=connected", fixedControlBase(env)).toString();
}

function fixedControlBase(env: ControlRequestEnv): URL {
  try {
    const base = new URL(env.CONTROL_BASE_URL);
    if (base.protocol !== "https:" || base.pathname !== "/" || base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") throw new Error();
    return base;
  } catch {
    throw new Error("CONTROL_BASE_URL must be an HTTPS origin without a path, query, hash, or credentials");
  }
}

async function brokerJson(
  env: ControlRequestEnv,
  path: string,
  method: "POST" | "GET",
  body?: unknown,
): Promise<unknown> {
  const response = await env.BROKER.fetch(new Request(`https://broker.internal${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.CONTROL_BROKER_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("Broker returned invalid JSON");
  }
  if (!response.ok) {
    const message = isRecord(value) && typeof value.error === "string" ? value.error : "Broker request failed";
    throw new RequestError(response.status, message);
  }
  return value;
}

async function registryValue(registry: RegistryStub, command: AccountRegistryCommand): Promise<unknown> {
  const result: unknown = JSON.parse(await registry.dispatchJson(command));
  if (!isRecord(result) || typeof result.ok !== "boolean") throw new Error("Account registry returned an invalid response");
  if (result.ok) return result.value;
  if (typeof result.status !== "number" || typeof result.error !== "string") throw new Error("Account registry returned an invalid error");
  throw new RequestError(result.status, result.error);
}

function parseProviderAppRequest(value: unknown): {
  providerAppId: string;
  provider: "google";
  displayName: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
} {
  const body = record(value);
  const baseKeys = ["providerAppId", "provider", "displayName", "clientId", "clientSecret"];
  exactKeys(body, "scopes" in body ? [...baseKeys, "scopes"] : baseKeys);
  if (body.provider !== "google") throw new RequestError(400, "provider must be google");
  return {
    providerAppId: requiredString(body.providerAppId, "providerAppId"),
    provider: "google",
    displayName: requiredString(body.displayName, "displayName"),
    clientId: requiredString(body.clientId, "clientId"),
    clientSecret: requiredString(body.clientSecret, "clientSecret"),
    // Registration without scopes keeps the historical default consent set.
    scopes: "scopes" in body ? parseRequestScopes(body.scopes) : [...DEFAULT_GOOGLE_PROVIDER_SCOPES],
  };
}

function parseRequestScopes(value: unknown): string[] {
  try {
    return parseProviderScopes(value);
  } catch (error) {
    throw new RequestError(400, error instanceof Error ? error.message : "scopes is invalid");
  }
}

function parseCreateAuthorizationRequest(value: unknown): { providerAppId: string; nickname: string } {
  const body = record(value);
  exactKeys(body, ["providerAppId", "nickname"]);
  return {
    providerAppId: requiredString(body.providerAppId, "providerAppId"),
    nickname: requiredString(body.nickname, "nickname"),
  };
}

function parseProviderAppSummary(value: unknown): ProviderAppSummary {
  if (!isRecord(value) || !isProviderAppSummary(value)) throw new Error("Broker returned an invalid Provider App summary");
  return value;
}

function parseConnectionSummary(value: unknown): ConnectionSummary {
  if (!isRecord(value) || !isConnectionSummary(value)) throw new Error("Broker returned an invalid Connection summary");
  return value;
}

function isProviderAppSummary(value: unknown): value is ProviderAppSummary {
  if (!isRecord(value)) return false;
  return Object.keys(value).sort().join(",") === "accountId,clientIdSuffix,displayName,id,provider,scopes"
    && typeof value.id === "string"
    && typeof value.accountId === "string"
    && value.provider === "google"
    && typeof value.displayName === "string"
    && typeof value.clientIdSuffix === "string"
    && Array.isArray(value.scopes)
    && value.scopes.length > 0
    && value.scopes.every((scope) => typeof scope === "string" && scope !== "");
}

function isConnectionSummary(value: unknown): value is ConnectionSummary {
  if (!isRecord(value)) return false;
  return Object.keys(value).sort().join(",") === "accountId,displayName,grantedScopes,health,id,nickname,provider,providerAppId"
    && typeof value.id === "string"
    && typeof value.accountId === "string"
    && typeof value.nickname === "string"
    && value.nickname.trim() !== ""
    && typeof value.providerAppId === "string"
    && value.provider === "google"
    && typeof value.displayName === "string"
    && Array.isArray(value.grantedScopes)
    && value.grantedScopes.every((scope) => typeof scope === "string")
    && (value.health === "healthy" || value.health === "revoked" || value.health === "error");
}

function parseTakenOAuthState(value: unknown): Pick<OAuthStateRecord, "providerAppId" | "connectionId" | "nickname" | "codeVerifier" | "redirectUri" | "flow"> {
  if (!isRecord(value)
    || typeof value.providerAppId !== "string"
    || typeof value.connectionId !== "string"
    || typeof value.nickname !== "string"
    || typeof value.codeVerifier !== "string"
    || typeof value.redirectUri !== "string"
    || (value.flow !== "create" && value.flow !== "reauth")) {
    throw new Error("Account registry returned invalid OAuth state data");
  }
  return {
    providerAppId: value.providerAppId,
    connectionId: value.connectionId,
    nickname: value.nickname,
    codeVerifier: value.codeVerifier,
    redirectUri: value.redirectUri,
    flow: value.flow,
  };
}

function controlErrorResponse(error: unknown): Response {
  if (error instanceof RequestError || error instanceof HttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json({ error: error instanceof Error ? error.message : "control request failed" }, { status: 500 });
}

async function defaultAccessVerifier(request: Request, env: ControlRequestEnv): Promise<AccessIdentity> {
  return authenticateAccessRequest(request, {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUDIENCE,
    accountId: env.ACCOUNT_ID,
  });
}

export default {
  fetch(request, env): Promise<Response> {
    return handleControlRequest(request, env as unknown as ControlRequestEnv);
  },
} satisfies ExportedHandler<ControlEnv>;

async function requireAdmin(request: Request, expectedToken: string): Promise<void> {
  return requireBearer(request, expectedToken, "admin authorization required");
}

async function requireBearer(request: Request, expectedToken: string, message: string): Promise<void> {
  return requireBearerToken(request, expectedToken, message);
}

async function requestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new RequestError(400, "request body must be valid JSON");
  }
}

function parseAction(value: unknown): AccountRegistryCommand {
  const body = record(value);
  // Named-key CRUD reuses the demo POST surface so the control UI mutates keys
  // with the same Access-identity (no management bearer) idiom as availability.
  // The heavy lifting (mint/rotate/revoke, idempotency, gate reconcile) lives in
  // management.ts and is dispatched unchanged; here we only adapt the request.
  const keyAction = parseKeyAction(body);
  if (keyAction !== null) return keyAction;
  const actions: DemoAction[] = ["promote", "pause_all", "resume_all", "pause_tool", "resume_tool"];
  if (!actions.includes(body.action as DemoAction)) throw new RequestError(400, "invalid action");
  if (body.environment !== "staging" && body.environment !== "production") {
    throw new RequestError(400, "environment must be staging or production");
  }
  const action = body.action as DemoAction;
  const environment = body.environment as DeploymentEnvironment;
  const angelId = requiredString(body.angelId, "angelId");
  if (action === "pause_tool" || action === "resume_tool") {
    const keys = ["angelId", "action", "environment", "tool"];
    if (body.connectionId !== undefined) keys.push("connectionId");
    exactKeys(body, keys);
    return {
      operation: "action",
      angelId,
      action,
      environment,
      tool: requiredString(body.tool, "tool"),
      ...(body.connectionId === undefined
        ? {}
        : { connectionId: requiredString(body.connectionId, "connectionId") }),
    };
  }
  if (action === "promote") {
    exactKeys(body, [
      "angelId",
      "action",
      "environment",
      "stagedDeploymentId",
      "expectedDigest",
      "bindings",
    ]);
    if (environment !== "production") {
      throw new RequestError(400, "promote requires the production environment");
    }
    return {
      operation: "action",
      angelId,
      action,
      environment,
      stagedDeploymentId: requiredString(body.stagedDeploymentId, "stagedDeploymentId"),
      expectedDigest: requiredString(body.expectedDigest, "expectedDigest"),
      bindings: parseBindings(body.bindings),
    };
  }
  exactKeys(body, ["angelId", "action", "environment"]);
  return { operation: "action", angelId, action, environment };
}

// Adapt a demo POST body into a `key_action` demo command, or null when the
// action is not a key action (so parseAction falls through to availability). The
// SLUG→id resolution and the DETERMINISTIC idempotency key (from the client token)
// happen in the registry's keyAction — this only validates and shapes the request.
function parseKeyAction(body: Record<string, unknown>): AccountRegistryCommand | null {
  const action = body.action;
  if (action !== "create_key" && action !== "rotate_key" && action !== "revoke_key") {
    return null;
  }
  if (body.environment !== "staging" && body.environment !== "production") {
    throw new RequestError(400, "environment must be staging or production");
  }
  const angelId = requiredString(body.angelId, "angelId");
  const environment = body.environment as DeploymentEnvironment;
  // A per-attempt token the client generates once and REUSES on retry, so a lost
  // response can replay the same committed mutation instead of duplicating it.
  const idempotencyToken = requiredString(body.idempotencyToken, "idempotencyToken");
  if (action === "create_key") {
    exactKeys(body, ["angelId", "action", "environment", "name", "idempotencyToken"]);
    return { operation: "key_action", action, angelId, environment, idempotencyToken, name: boundedKeyName(body.name) };
  }
  exactKeys(body, ["angelId", "action", "environment", "keyId", "idempotencyToken"]);
  return { operation: "key_action", action, angelId, environment, idempotencyToken, keyId: requiredString(body.keyId, "keyId") };
}

// Bound a key name at the demo surface: 1–64 characters after trimming, no control
// characters. NOTE: Management's requiredKeyName only checks non-empty, so the /v1
// surface is currently unbounded — see the PR body follow-up (src/management* is
// out of scope for this PR).
function boundedKeyName(value: unknown): string {
  const name = requiredString(value, "name").trim();
  // Count Unicode code points, not UTF-16 units, so an astral name is bounded by
  // what the operator sees rather than its surrogate-pair length.
  const codePoints = [...name].length;
  if (codePoints < 1 || codePoints > 64) {
    throw new RequestError(400, "key name must be 1-64 characters");
  }
  // Reject the whole Unicode "Other" category (\p{C}: control, format, surrogate,
  // private-use, unassigned) — covering ASCII controls AND invisibles like the
  // zero-width joiner. Visible symbols (e.g. a single emoji, \p{So}) are allowed;
  // ZWJ emoji SEQUENCES are rejected because they contain a format joiner.
  if (/\p{C}/u.test(name)) {
    throw new RequestError(400, "key name must not contain control or format characters");
  }
  return name;
}

function registryResponse(serialized: string): Response {
  const result: unknown = JSON.parse(serialized);
  if (!isRecord(result) || typeof result.ok !== "boolean") {
    throw new Error("Account registry returned an invalid response");
  }
  if (result.ok) {
    const status = typeof result.status === "number" ? result.status : 200;
    return Response.json(result.value, { status });
  }
  if (typeof result.status !== "number" || typeof result.error !== "string") {
    throw new Error("Account registry returned an invalid error");
  }
  return Response.json({ error: result.error }, { status: result.status });
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new RequestError(400, "request body must be an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new RequestError(400, `request must contain exactly ${sortedExpected.join(", ")}`);
  }
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function managementCommand(
  request: Request,
  url: URL,
  authenticatedAccountId: string,
): Promise<{ accountId: string; command: ManagementCommand }> {
  const accountAngel = matchPath(url.pathname, /^\/v1\/accounts\/([^/]+)\/angels\/([^/]+)$/);
  if (accountAngel) {
    const accountId = accountAngel[0]!;
    const slug = accountAngel[1]!;
    requireAuthenticatedAccount(accountId, authenticatedAccountId);
    if (request.method === "GET") {
      return { accountId, command: { operation: "get_angel_by_slug", accountId, slug } };
    }
    if (request.method === "PUT") {
      const mutation = await managementMutation(request, url, []);
      return {
        accountId,
        command: { operation: "ensure_angel", accountId, slug, mutation },
      };
    }
    throw new RequestError(404, "not found");
  }

  const accountConnections = matchPath(url.pathname, /^\/v1\/accounts\/([^/]+)\/connections$/);
  if (accountConnections && request.method === "GET") {
    const accountId = accountConnections[0]!;
    requireAuthenticatedAccount(accountId, authenticatedAccountId);
    return { accountId, command: { operation: "list_connections", accountId } };
  }

  const version = matchPath(url.pathname, /^\/v1\/angels\/([^/]+)\/versions\/([^/]+)$/);
  if (version && request.method === "GET") {
    return {
      accountId: authenticatedAccountId,
      command: { operation: "get_version", angelId: version[0]!, versionId: version[1]! },
    };
  }

  const versions = matchPath(url.pathname, /^\/v1\/angels\/([^/]+)\/versions$/);
  if (versions && request.method === "POST") {
    const mutation = await managementMutation(request, url, ["artifact", "expectedDigest"]);
    const body = mutation.body as Record<string, unknown>;
    const input: PublishVersionRequest = {
      artifact: parseVersionArtifact(body.artifact),
      expectedDigest: requiredString(body.expectedDigest, "expectedDigest"),
    };
    mutation.body = input;
    return {
      accountId: authenticatedAccountId,
      command: { operation: "publish_version", angelId: versions[0]!, input, mutation },
    };
  }

  const environment = matchPath(
    url.pathname,
    /^\/v1\/angels\/([^/]+)\/environments\/(staging|production)$/,
  );
  if (environment && request.method === "GET") {
    return {
      accountId: authenticatedAccountId,
      command: {
        operation: "get_environment",
        angelId: environment[0]!,
        environment: environment[1]! as DeploymentEnvironment,
      },
    };
  }

  const staging = matchPath(
    url.pathname,
    /^\/v1\/angels\/([^/]+)\/environments\/staging\/deployments$/,
  );
  if (staging && request.method === "POST") {
    const mutation = await managementMutation(
      request,
      url,
      ["versionId", "expectedDigest", "bindings"],
    );
    const body = mutation.body as Record<string, unknown>;
    const input: DeployStagingRequest = {
      versionId: requiredString(body.versionId, "versionId"),
      expectedDigest: requiredString(body.expectedDigest, "expectedDigest"),
      bindings: parseBindings(body.bindings),
    };
    mutation.body = input;
    return {
      accountId: authenticatedAccountId,
      command: { operation: "deploy_staging", angelId: staging[0]!, input, mutation },
    };
  }

  const availability = matchPath(
    url.pathname,
    /^\/v1\/angels\/([^/]+)\/environments\/(staging|production)\/availability$/,
  );
  if (availability && request.method === "POST") {
    const raw = record(await requestJsonAfterIdempotency(request));
    const input = parseAvailability(raw);
    const mutation: MutationIdentity = {
      method: request.method,
      path: url.pathname,
      idempotencyKey: requiredIdempotencyKey(request),
      body: input,
    };
    return {
      accountId: authenticatedAccountId,
      command: {
        operation: "change_availability",
        angelId: availability[0]!,
        environment: availability[1]! as DeploymentEnvironment,
        input,
        mutation,
      },
    };
  }

  const keys = matchPath(
    url.pathname,
    /^\/v1\/angels\/([^/]+)\/environments\/(staging|production)\/keys$/,
  );
  if (keys && request.method === "POST") {
    const mutation = await managementMutation(request, url, ["name"]);
    const body = mutation.body as Record<string, unknown>;
    const input = { name: requiredString(body.name, "name") };
    mutation.body = input;
    return {
      accountId: authenticatedAccountId,
      command: {
        operation: "create_key",
        angelId: keys[0]!,
        environment: keys[1]! as DeploymentEnvironment,
        input,
        mutation,
      },
    };
  }

  const keyRotation = matchPath(
    url.pathname,
    /^\/v1\/angels\/([^/]+)\/environments\/(staging|production)\/keys\/([^/]+)\/rotations$/,
  );
  if (keyRotation && request.method === "POST") {
    const mutation = await managementMutation(request, url, []);
    const input = { keyId: keyRotation[2]! };
    mutation.body = input;
    return {
      accountId: authenticatedAccountId,
      command: {
        operation: "rotate_key",
        angelId: keyRotation[0]!,
        environment: keyRotation[1]! as DeploymentEnvironment,
        input,
        mutation,
      },
    };
  }

  const keyRevocation = matchPath(
    url.pathname,
    /^\/v1\/angels\/([^/]+)\/environments\/(staging|production)\/keys\/([^/]+)\/revocations$/,
  );
  if (keyRevocation && request.method === "POST") {
    const mutation = await managementMutation(request, url, []);
    const input = { keyId: keyRevocation[2]! };
    mutation.body = input;
    return {
      accountId: authenticatedAccountId,
      command: {
        operation: "revoke_key",
        angelId: keyRevocation[0]!,
        environment: keyRevocation[1]! as DeploymentEnvironment,
        input,
        mutation,
      },
    };
  }

  const promotion = matchPath(
    url.pathname,
    /^\/v1\/angels\/([^/]+)\/environments\/production\/promotions$/,
  );
  if (promotion && request.method === "POST") {
    const mutation = await managementMutation(
      request,
      url,
      ["stagedDeploymentId", "expectedDigest", "bindings"],
    );
    const body = mutation.body as Record<string, unknown>;
    const input: PromoteProductionRequest = {
      stagedDeploymentId: requiredString(body.stagedDeploymentId, "stagedDeploymentId"),
      expectedDigest: requiredString(body.expectedDigest, "expectedDigest"),
      bindings: parseBindings(body.bindings),
    };
    mutation.body = input;
    return {
      accountId: authenticatedAccountId,
      command: { operation: "promote_production", angelId: promotion[0]!, input, mutation },
    };
  }

  throw new RequestError(404, "not found");
}

function requireAuthenticatedAccount(accountId: string, authenticatedAccountId: string): void {
  if (accountId !== authenticatedAccountId) throw new RequestError(404, "not found");
}

async function managementMutation(
  request: Request,
  url: URL,
  keys: string[],
): Promise<MutationIdentity> {
  const idempotencyKey = requiredIdempotencyKey(request);
  const body = record(await requestJson(request));
  exactKeys(body, keys);
  return {
    method: request.method,
    path: url.pathname,
    idempotencyKey,
    body,
  };
}

async function requestJsonAfterIdempotency(request: Request): Promise<unknown> {
  requiredIdempotencyKey(request);
  return requestJson(request);
}

function requiredIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  if (key === "") throw new RequestError(400, "Idempotency-Key must be non-empty");
  return key;
}

function parseAvailability(body: Record<string, unknown>): ManagementAvailabilityChange {
  if (body.kind === "all") {
    exactKeys(body, ["kind", "enabled"]);
    return { kind: "all", enabled: requiredBoolean(body.enabled, "enabled") };
  }
  if (body.kind === "tool") {
    exactKeys(body, ["kind", "tool", "enabled"]);
    return {
      kind: "tool",
      tool: requiredString(body.tool, "tool"),
      enabled: requiredBoolean(body.enabled, "enabled"),
    };
  }
  if (body.kind === "tool_connection") {
    exactKeys(body, ["kind", "tool", "connectionId", "enabled"]);
    return {
      kind: "tool_connection",
      tool: requiredString(body.tool, "tool"),
      connectionId: requiredString(body.connectionId, "connectionId"),
      enabled: requiredBoolean(body.enabled, "enabled"),
    };
  }
  throw new RequestError(400, "invalid availability kind");
}

function parseVersionArtifact(value: unknown): ManagementVersionArtifact {
  const artifact = record(value);
  // Format first: a genuine v1 artifact simply lacks `providers`, and the
  // named format error beats a key-list dump for an operator on an older CLI.
  if (artifact.format !== "angel.version.v2") throw new RequestError(400, "invalid artifact format");
  exactKeys(artifact, [
    "format",
    "name",
    "charter",
    "children",
    "providers",
    "bindingRequirements",
    "tools",
    "canonicalSource",
    "digest",
  ]);
  const providers = record(artifact.providers);
  for (const [name, value] of Object.entries(providers)) {
    const provider = record(value);
    exactKeys(provider, ["adapter", "origin", "sourceDigest"]);
    requiredString(provider.adapter, `providers.${name}.adapter`);
    requiredString(provider.origin, `providers.${name}.origin`);
    requiredString(provider.sourceDigest, `providers.${name}.sourceDigest`);
  }
  if (!Array.isArray(artifact.bindingRequirements)) {
    throw new RequestError(400, "artifact bindingRequirements must be a list");
  }
  for (const [index, value] of artifact.bindingRequirements.entries()) {
    const requirement = record(value);
    exactKeys(requirement, ["id", "source", "provider", "credential", "requiredScopes", "tools"]);
    requiredString(requirement.id, `bindingRequirements[${index}].id`);
    requiredString(requirement.source, `bindingRequirements[${index}].source`);
    requiredString(requirement.provider, `bindingRequirements[${index}].provider`);
    requiredString(requirement.credential, `bindingRequirements[${index}].credential`);
    stringList(requirement.requiredScopes, `bindingRequirements[${index}].requiredScopes`);
    stringList(requirement.tools, `bindingRequirements[${index}].tools`);
  }
  if (!Array.isArray(artifact.children) || !Array.isArray(artifact.tools)) {
    throw new RequestError(400, "artifact children and tools must be lists");
  }
  for (const [index, value] of artifact.children.entries()) {
    const child = record(value);
    exactKeys(child, ["name", "digest"]);
    requiredString(child.name, `children[${index}].name`);
    requiredString(child.digest, `children[${index}].digest`);
  }
  for (const [index, value] of artifact.tools.entries()) {
    const tool = record(value);
    exactKeys(tool, ["name", "provider", "operation", "argGuards", "request"]);
    requiredString(tool.name, `tools[${index}].name`);
    requiredString(tool.provider, `tools[${index}].provider`);
    requiredString(tool.operation, `tools[${index}].operation`);
    if (!Array.isArray(tool.argGuards)) throw new RequestError(400, `tools[${index}].argGuards must be a list`);
    for (const [guardIndex, value] of tool.argGuards.entries()) {
      validateArgGuard(value, `tools[${index}].argGuards[${guardIndex}]`);
    }
    validateToolRequest(tool.request, `tools[${index}].request`);
  }
  requiredString(artifact.name, "artifact.name");
  requiredString(artifact.canonicalSource, "artifact.canonicalSource");
  requiredString(artifact.digest, "artifact.digest");
  return artifact as unknown as ManagementVersionArtifact;
}

// Shape only — registry agreement (template equality, origins, scopes) is
// enforced by validateArtifactAdapters inside the management layer.
function validateToolRequest(value: unknown, label: string): void {
  const request = record(value);
  exactKeys(request, ["kind", "method", "pathTemplate", "pathParams", "pathDefaults", "queryParams", "hasBody"]);
  if (request.kind !== "http") throw new RequestError(400, `${label}.kind must be "http"`);
  requiredString(request.method, `${label}.method`);
  requiredString(request.pathTemplate, `${label}.pathTemplate`);
  // Path and query lists are legitimately empty (a body-only POST has
  // neither) — shape-check entries without a non-empty requirement.
  for (const key of ["pathParams", "queryParams"] as const) {
    const list = request[key];
    if (!Array.isArray(list)) throw new RequestError(400, `${label}.${key} must be a string list`);
    for (const entry of list) requiredString(entry, `${label}.${key}`);
  }
  const defaults = record(request.pathDefaults);
  for (const [name, defaultValue] of Object.entries(defaults)) {
    requiredString(defaultValue, `${label}.pathDefaults.${name}`);
  }
  if (typeof request.hasBody !== "boolean") throw new RequestError(400, `${label}.hasBody must be a boolean`);
}

function validateArgGuard(value: unknown, label: string): void {
  const guard = record(value);
  const kinds = ["pin", "forbid", "forbiddenValues"].filter((key) => guard[key] !== undefined);
  if (kinds.length !== 1) throw new RequestError(400, `${label} must set exactly one guard kind`);
  const kind = kinds[0]!;
  exactKeys(guard, ["field", kind]);
  requiredString(guard.field, `${label}.field`);
  if (kind === "pin") {
    requiredString(guard.pin, `${label}.pin`);
  } else if (kind === "forbid") {
    if (guard.forbid !== true) throw new RequestError(400, `${label}.forbid must be true`);
  } else {
    stringList(guard.forbiddenValues, `${label}.forbiddenValues`);
  }
}

function parseBindings(value: unknown): ManagementBindingMap {
  const bindings = record(value);
  const parsed: Record<string, string[]> = {};
  for (const [requirementId, connectionIds] of Object.entries(bindings)) {
    if (requirementId.trim() === "" || !Array.isArray(connectionIds) || connectionIds.length === 0) {
      throw new RequestError(400, "bindings must map requirement IDs to non-empty Connection ID lists");
    }
    parsed[requirementId] = connectionIds.map((connectionId) =>
      requiredString(connectionId, `bindings.${requirementId}`)
    );
  }
  return parsed;
}

function matchPath(pathname: string, pattern: RegExp): string[] | null {
  const match = pattern.exec(pathname);
  if (!match) return null;
  return match.slice(1).map((value) => decodeURIComponent(value));
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RequestError(400, `${label} must be a non-empty string`);
  }
  return value;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RequestError(400, `${label} must be a non-empty string list`);
  }
  return value.map((entry) => requiredString(entry, label));
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new RequestError(400, `${label} must be boolean`);
  return value;
}
