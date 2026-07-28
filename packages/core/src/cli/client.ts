import type {
  DeleteAngelResponse,
  DeployStagingRequest,
  EnsureAngelResponse,
  ManagementAngelView,
  ManagementConnection,
  ManagementDeploymentView,
  ManagementEnvironmentView,
  PromoteProductionRequest,
  PublishedAngelVersion,
  PublishVersionRequest,
} from "../management-contract";
import { sha256Hex } from "../crypto";
import { canonicalJson } from "../canonical-json";

export interface ManagementClientOptions {
  target: string;
  token: string;
  accessToken?: string;
  fetch: FetchLike;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CloudflareAccessHeaders extends Record<string, string> {
  "CF-Access-Client-ID": string;
  "CF-Access-Client-Secret": string;
}

export function cloudflareAccessHeaders(accessToken: string): CloudflareAccessHeaders {
  if (accessToken === "" || accessToken.trim() !== accessToken) {
    throw new Error("Access token must be exact non-empty JSON without surrounding whitespace");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(accessToken);
  } catch {
    throw new Error("Access token must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Access token must be a two-key JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2
    || keys[0] !== "cf-access-client-id"
    || keys[1] !== "cf-access-client-secret"
  ) {
    throw new Error("Access token must contain exactly cf-access-client-id and cf-access-client-secret");
  }
  const clientId = record["cf-access-client-id"];
  const clientSecret = record["cf-access-client-secret"];
  if (
    typeof clientId !== "string"
    || clientId === ""
    || clientId.trim() !== clientId
    || typeof clientSecret !== "string"
    || clientSecret === ""
    || clientSecret.trim() !== clientSecret
  ) {
    throw new Error("Access token values must be non-empty strings without surrounding whitespace");
  }
  return {
    "CF-Access-Client-ID": clientId,
    "CF-Access-Client-Secret": clientSecret,
  };
}

export class ManagementClient {
  constructor(private readonly options: ManagementClientOptions) {}

  listConnections(accountId: string): Promise<ManagementConnection[]> {
    return this.request("GET", `/v1/accounts/${segment(accountId)}/connections`, undefined, connections);
  }

  ensureAngel(accountId: string, slug: string): Promise<EnsureAngelResponse> {
    return this.request(
      "PUT",
      `/v1/accounts/${segment(accountId)}/angels/${segment(slug)}`,
      {},
      ensureResponse,
    );
  }

  deleteAngel(
    accountId: string,
    slug: string,
    options: { confirm?: string } = {},
  ): Promise<DeleteAngelResponse> {
    // The API requires an Idempotency-Key on every delete, and it must be
    // fresh per attempt: a key derived from method+path+body would collide
    // across delete -> recreate -> delete and replay the first response
    // instead of deleting again.
    return this.request(
      "DELETE",
      `/v1/accounts/${segment(accountId)}/angels/${segment(slug)}`,
      options.confirm === undefined ? undefined : { confirm: options.confirm },
      deletedAngel,
      { idempotencyKey: crypto.randomUUID() },
    );
  }

  getAngel(accountId: string, slug: string): Promise<ManagementAngelView> {
    return this.request(
      "GET",
      `/v1/accounts/${segment(accountId)}/angels/${segment(slug)}`,
      undefined,
      managementAngel,
    );
  }

  publishVersion(angelId: string, input: PublishVersionRequest): Promise<PublishedAngelVersion> {
    return this.request(
      "POST",
      `/v1/angels/${segment(angelId)}/versions`,
      input,
      publishedVersion,
    );
  }

  deployStaging(angelId: string, input: DeployStagingRequest): Promise<ManagementDeploymentView> {
    return this.request(
      "POST",
      `/v1/angels/${segment(angelId)}/environments/staging/deployments`,
      input,
      deployment,
    );
  }

  getEnvironment(angelId: string, environment: "staging" | "production"): Promise<ManagementEnvironmentView> {
    return this.request(
      "GET",
      `/v1/angels/${segment(angelId)}/environments/${environment}`,
      undefined,
      environmentView,
    );
  }

  promoteProduction(
    angelId: string,
    input: PromoteProductionRequest,
  ): Promise<ManagementDeploymentView> {
    return this.request(
      "POST",
      `/v1/angels/${segment(angelId)}/environments/production/promotions`,
      input,
      deployment,
    );
  }

  private async request<T>(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    body: unknown | undefined,
    parse: (value: unknown) => T,
    options: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const canonicalPath = path.length > 1 ? path.replace(/\/+$/, "") : path;
    const headers = new Headers({ authorization: `Bearer ${this.options.token}` });
    const accessToken = this.options.accessToken;
    if (accessToken !== undefined) {
      const accessHeaders = cloudflareAccessHeaders(accessToken);
      headers.set("CF-Access-Client-ID", accessHeaders["CF-Access-Client-ID"]);
      headers.set("CF-Access-Client-Secret", accessHeaders["CF-Access-Client-Secret"]);
    }
    // Every mutation needs an Idempotency-Key, body or not. Callers that must
    // not replay across resource recreation (delete) pass an explicit key;
    // everything else derives one from the mutation identity.
    if (method !== "GET") {
      headers.set(
        "idempotency-key",
        options.idempotencyKey
          ?? await sha256Hex(canonicalJson({ method, path: canonicalPath, body: body ?? {} })),
      );
    }
    let serializedBody: string | undefined;
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      serializedBody = JSON.stringify(body);
    }
    const response = await this.options.fetch(`${this.options.target}${canonicalPath}`, {
      method,
      headers,
      body: serializedBody,
    });
    const text = await response.text();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${canonicalPath} returned non-JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const message = isRecord(value) && typeof value.error === "string" ? `: ${value.error}` : "";
      throw new ManagementRequestError(
        `${method} ${canonicalPath} failed (HTTP ${response.status})${message}`,
        response.status,
      );
    }
    try {
      return parse(value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid response";
      throw new Error(`${method} ${canonicalPath} response schema error: ${detail}`);
    }
  }
}

export class ManagementRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ManagementRequestError";
  }
}

function deletedAngel(value: unknown): DeleteAngelResponse {
  const result = exactRecord(value, ["id", "slug", "deleted"], "delete response");
  if (result.deleted !== true) throw new Error("delete response.deleted must be true");
  return {
    id: string(result.id, "delete response.id"),
    slug: string(result.slug, "delete response.slug"),
    deleted: true,
  };
}

function connections(value: unknown): ManagementConnection[] {
  if (!Array.isArray(value)) throw new Error("expected a Connection list");
  return value.map((candidate, index) => {
    const connection = exactRecord(candidate, [
      "id",
      "accountId",
      "nickname",
      "identityLabel",
      "credential",
      "providers",
      "health",
    ], `connections[${index}]`);
    string(connection.id, `connections[${index}].id`);
    string(connection.accountId, `connections[${index}].accountId`);
    string(connection.nickname, `connections[${index}].nickname`);
    string(connection.identityLabel, `connections[${index}].identityLabel`);
    if (!Array.isArray(connection.providers) || !connection.providers.every(nonEmptyString)) {
      throw new Error(`connections[${index}].providers must be a string list`);
    }
    if (!["google_oauth", "service_token", "bot_token", "bridge_token"].includes(connection.credential as string)) {
      throw new Error(`connections[${index}].credential is invalid`);
    }
    if (connection.health !== "healthy" && connection.health !== "error") {
      throw new Error(`connections[${index}].health is invalid`);
    }
    return connection as unknown as ManagementConnection;
  });
}

function ensureResponse(value: unknown): EnsureAngelResponse {
  const root = record(value, "ensure response");
  const keys = Object.keys(root).sort();
  if (keys.join(",") !== "angel" && keys.join(",") !== "angel,keys") {
    throw new Error("ensure response must contain angel and optional keys");
  }
  const angel = managementAngel(root.angel);
  if (root.keys === undefined) return { angel };
  const responseKeys = exactRecord(root.keys, ["staging", "production"], "keys");
  return {
    angel,
    keys: {
      staging: string(responseKeys.staging, "keys.staging"),
      production: string(responseKeys.production, "keys.production"),
    },
  };
}

function managementAngel(value: unknown): ManagementAngelView {
  const angel = exactRecord(value, ["id", "accountId", "slug", "environments"], "angel");
  const environments = exactRecord(angel.environments, ["staging", "production"], "angel.environments");
  return {
    id: string(angel.id, "angel.id"),
    accountId: string(angel.accountId, "angel.accountId"),
    slug: string(angel.slug, "angel.slug"),
    environments: {
      staging: environmentView(environments.staging),
      production: environmentView(environments.production),
    },
  };
}

function publishedVersion(value: unknown): PublishedAngelVersion {
  const version = exactRecord(value, ["id", "angelId", "number", "digest", "artifact"], "Version");
  if (!Number.isInteger(version.number) || (version.number as number) < 1) {
    throw new Error("Version.number must be a positive integer");
  }
  record(version.artifact, "Version.artifact");
  return version as unknown as PublishedAngelVersion;
}

function deployment(value: unknown): ManagementDeploymentView {
  const candidate = exactRecord(value, [
    "id",
    "angelId",
    "environment",
    "versionId",
    "version",
    "digest",
    "bindings",
  ], "deployment");
  for (const key of ["id", "angelId", "versionId", "digest"] as const) {
    string(candidate[key], `deployment.${key}`);
  }
  if (candidate.environment !== "staging" && candidate.environment !== "production") {
    throw new Error("deployment.environment is invalid");
  }
  if (!Number.isInteger(candidate.version) || (candidate.version as number) < 1) {
    throw new Error("deployment.version must be a positive integer");
  }
  connectionIdBindings(candidate.bindings, "deployment.bindings");
  return candidate as unknown as ManagementDeploymentView;
}

function environmentView(value: unknown): ManagementEnvironmentView {
  const candidate = exactRecord(value, [
    "environment",
    "keyFingerprint",
    "activeDeployment",
    "pendingDeployment",
    "repair",
    "availability",
    "pendingAvailability",
  ], "environment");
  if (candidate.environment !== "staging" && candidate.environment !== "production") {
    throw new Error("environment.environment is invalid");
  }
  string(candidate.keyFingerprint, "environment.keyFingerprint");
  deploymentSummary(candidate.activeDeployment, "environment.activeDeployment");
  deploymentSummary(candidate.pendingDeployment, "environment.pendingDeployment");
  repair(candidate.repair, "environment.repair");
  const availability = exactRecord(candidate.availability, [
    "defaultEnabled",
    "toolOverrides",
    "connectionOverrides",
    "revision",
  ], "environment.availability");
  if (typeof availability.defaultEnabled !== "boolean" || !Number.isInteger(availability.revision)) {
    throw new Error("environment.availability is invalid");
  }
  record(availability.toolOverrides, "environment.availability.toolOverrides");
  record(availability.connectionOverrides, "environment.availability.connectionOverrides");
  if (candidate.pendingAvailability !== null) {
    record(candidate.pendingAvailability, "environment.pendingAvailability");
  }
  return candidate as unknown as ManagementEnvironmentView;
}

function deploymentSummary(value: unknown, label: string): void {
  if (value === null) return;
  const summary = exactRecord(value, ["id", "versionId", "digest", "bindings"], label);
  string(summary.id, `${label}.id`);
  string(summary.versionId, `${label}.versionId`);
  string(summary.digest, `${label}.digest`);
  connectionIdBindings(summary.bindings, `${label}.bindings`);
}

function connectionIdBindings(value: unknown, label: string): void {
  const bindings = record(value, label);
  for (const [id, connectionIds] of Object.entries(bindings)) {
    if (id.trim() === "" || !Array.isArray(connectionIds) || connectionIds.length === 0) {
      throw new Error(`${label} must map requirement IDs to non-empty lists`);
    }
    connectionIds.forEach((connectionId) => string(connectionId, `${label}.${id}`));
  }
}

function repair(value: unknown, label: string): null | "broker" | "gateway" {
  if (value !== null && value !== "broker" && value !== "gateway") {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (!nonEmptyString(value)) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const result = record(value, label);
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly ${expected.join(", ")}`);
  }
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function segment(value: string): string {
  return encodeURIComponent(value);
}
