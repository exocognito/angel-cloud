import type { DeploymentEnvironment } from "../domain";
import type {
  DeleteAngelResponse,
  DeployRequest,
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
  /**
   * Presented as `Authorization: Bearer`. Control resolves it as a session,
   * so this is a session token — the shared management secret it used to be
   * was removed when Cloudflare Access came off the control plane.
   */
  token: string;
  fetch: FetchLike;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

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

  deploy(
    angelId: string,
    environment: DeploymentEnvironment,
    input: DeployRequest,
  ): Promise<ManagementDeploymentView> {
    return this.request(
      "POST",
      `/v1/angels/${segment(angelId)}/environments/${environment}/deployments`,
      input,
      (value) => deployment(value, environment),
    );
  }

  getEnvironment(angelId: string, environment: DeploymentEnvironment): Promise<ManagementEnvironmentView> {
    return this.request(
      "GET",
      `/v1/angels/${segment(angelId)}/environments/${environment}`,
      undefined,
      (value) => environmentView(value, environment),
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
      (value) => deployment(value, "production"),
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
  const angelEnvironments = record(root.angel, "angel").environments;
  if (secondEnvironmentDialect(root.keys, "keys")
    !== secondEnvironmentDialect(angelEnvironments, "angel.environments")) {
    throw new Error("ensure response must spell angel and keys in one dialect");
  }
  const responseKeys = secondEnvironmentRecord(root.keys, "keys");
  return {
    angel,
    keys: {
      preview: string(responseKeys.preview, "keys.preview"),
      production: string(responseKeys.production, "keys.production"),
    },
  };
}

function managementAngel(value: unknown): ManagementAngelView {
  const angel = exactRecord(value, ["id", "accountId", "slug", "environments"], "angel");
  const environments = secondEnvironmentRecord(angel.environments, "angel.environments");
  return {
    id: string(angel.id, "angel.id"),
    accountId: string(angel.accountId, "angel.accountId"),
    slug: string(angel.slug, "angel.slug"),
    environments: {
      preview: environmentView(environments.preview, "preview"),
      production: environmentView(environments.production, "production"),
    },
  };
}

/**
 * The spelling-neutral angel routes (ensure, get by slug) answer in the
 * pinned legacy dialect, which spells the second environment `staging`, and
 * offer no way to request the canonical spelling. Accept exactly one of the
 * two spellings — consistently, never mixed — and normalize to `preview`.
 * Canonical routes stay strict; this is the only legacy tolerance.
 */
function secondEnvironmentRecord(
  value: unknown,
  label: string,
): { preview: unknown; production: unknown } {
  const candidate = record(value, label);
  if (secondEnvironmentDialect(candidate, label) === "canonical") {
    return { preview: candidate.preview, production: candidate.production };
  }
  return { preview: legacyPreview(candidate.staging, `${label}.staging`), production: candidate.production };
}

function secondEnvironmentDialect(value: unknown, label: string): "legacy" | "canonical" {
  const keys = Object.keys(record(value, label)).sort().join(",");
  if (keys === "preview,production") return "canonical";
  if (keys === "production,staging") return "legacy";
  throw new Error(`${label} must contain exactly preview, production`);
}

/** A legacy-dialect environment view must spell itself staging throughout. */
function legacyPreview(value: unknown, label: string): unknown {
  if (typeof value !== "string") {
    const candidate = record(value, label);
    if (candidate.environment !== "staging") {
      throw new Error(`${label} must spell its environment staging`);
    }
    return { ...candidate, environment: "preview" };
  }
  return value;
}

function publishedVersion(value: unknown): PublishedAngelVersion {
  const version = exactRecord(value, ["id", "angelId", "number", "digest", "artifact"], "Version");
  if (!Number.isInteger(version.number) || (version.number as number) < 1) {
    throw new Error("Version.number must be a positive integer");
  }
  record(version.artifact, "Version.artifact");
  return version as unknown as PublishedAngelVersion;
}

function deployment(value: unknown, expected: DeploymentEnvironment): ManagementDeploymentView {
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
  if (candidate.environment !== expected) {
    throw new Error("deployment.environment is invalid");
  }
  if (!Number.isInteger(candidate.version) || (candidate.version as number) < 1) {
    throw new Error("deployment.version must be a positive integer");
  }
  connectionIdBindings(candidate.bindings, "deployment.bindings");
  return candidate as unknown as ManagementDeploymentView;
}

function environmentView(value: unknown, expected: DeploymentEnvironment): ManagementEnvironmentView {
  const candidate = exactRecord(value, [
    "environment",
    "keyFingerprint",
    "activeDeployment",
    "pendingDeployment",
    "repair",
    "availability",
    "pendingAvailability",
  ], "environment");
  if (candidate.environment !== expected) {
    throw new Error(`environment.environment must be ${expected}`);
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
