import { canonicalJson } from "@smcllns/angel-core";
import type { GateFleet } from "./control";
import type { HostedTool } from "./domain";
import type { HostedEnvironment } from "./environments";
import {
  gateReceiptIdentity,
  gateReceiptMismatch,
  type GateAvailability,
  type GateInstallation,
  type GateReceipt,
  type PolicyGateState,
} from "./gate";
import type {
  ManagementAvailabilityChange,
  ManagementConnection,
  ManagementDeployment,
  ManagementEnvironment,
  ManagementState,
  PublishedAngelVersion,
} from "./management-contract";

export interface DemoConnectionView {
  id: string;
  label: string;
  apps: string[];
  health: "healthy" | "error";
}

export interface DemoToolConnectionView {
  connectionId: string;
  identity: string;
  available: boolean;
}

export interface DemoToolView {
  name: string;
  app: string;
  group: string;
  guards: string[];
  connections: DemoToolConnectionView[];
}

export interface DemoBindingView {
  id: string;
  provider: string;
  connectionIds: string[];
}

/**
 * A recorded-or-derived wall-clock: `recorded` carries a genuine ISO-8601 UTC
 * instant the backend stamped; `derived` carries `null` because no time was ever
 * recorded. We never fabricate an `at` for a derived value.
 */
export type DemoRecordedTime =
  | { source: "recorded"; at: string }
  | { source: "derived"; at: null };

/**
 * A named runtime key as surfaced to the UI: identity, short fingerprint, and
 * status only. The secret hash is NEVER projected. `createdAt`/`revokedAt` are
 * recorded ISO times or null (never recorded / not applicable).
 */
export interface DemoAgentKeyView {
  id: string;
  name: string;
  fingerprint: string;
  status: "active" | "revoked";
  createdAt: string | null;
  revokedAt: string | null;
}

/**
 * A derived-or-recorded lifecycle event for a single environment.
 *
 * Real-vs-derived is carried by `source`:
 *  - `source: "recorded"` means the backend genuinely stamped `at` (a real ISO
 *    timestamp). This IS emitted now: `publish_version` stamps the Version at
 *    creation, and preview deploys / production promotions stamp the Deployment at
 *    convergence (the moment it becomes effective — a failed-then-repaired deploy
 *    records the repair time, never the failed attempt's). A change made under
 *    timestamp support therefore surfaces `recorded`. (The availability change
 *    time is surfaced separately on `availability.changedAt`, not as an event.)
 *  - `source: "derived"` means no timestamp was recorded — a state persisted before
 *    timestamp support, or an event never stamped; `at` is `null` and only the
 *    genuine `order` sequence (from version number + lifecycle stage) is known.
 *    We deliberately do NOT fabricate a precise `at`, which would imply real
 *    recording that never happened.
 *
 * `environment` is echoed on every event and MUST equal the environment whose
 * `lifecycle` array carries it: preview and production event data are never
 * interleaved.
 */
export interface DemoLifecycleEvent {
  kind: "version_published" | "preview_deploy" | "production_promotion";
  environment: HostedEnvironment;
  version: number;
  deploymentId: string | null;
  order: number;
  source: "recorded" | "derived";
  at: string | null;
}

export interface DemoEnvironmentView {
  version: number | null;
  digest: string | null;
  deploymentId: string | null;
  keyFingerprint: string;
  gateAlignment: {
    installation: "aligned" | "mismatched";
    availability: "aligned" | "mismatched";
  };
  pendingAvailabilityRepair:
    | null
    | { action: "pause_all" | "resume_all" }
    | {
        action: "pause_tool" | "resume_tool";
        tool: string;
        connectionId?: string;
      };
  availability: {
    defaultEnabled: boolean;
    overrides: Record<string, boolean>;
    revision: number;
    /**
     * When the current availability was last changed by the backend. `recorded`
     * with a real ISO time when a change genuinely happened under timestamp
     * support; `derived`/`null` otherwise (no change recorded — never fabricated).
     */
    changedAt: DemoRecordedTime;
  };
  keys: DemoAgentKeyView[];
  bindings: DemoBindingView[];
  tools: DemoToolView[];
  lifecycle: DemoLifecycleEvent[];
}

export interface DemoAngelView {
  id: string;
  name: string;
  enabled: boolean;
  endpoints: Record<HostedEnvironment, string>;
  connections: DemoConnectionView[];
  environments: Record<HostedEnvironment, DemoEnvironmentView>;
  versions: Array<{
    number: number;
    digest: string;
    label: string;
    status: "staged" | "live" | "history";
    tools: string[];
  }>;
  readyForProduction: null | {
    stagedDeploymentId: string;
    expectedDigest: string;
    fromVersion: number | null;
    toVersion: number;
    diff: { added: string[]; removed: string[] };
    bindings: Record<string, string[]>;
  };
  activity: Array<{
    requestId: string;
    environment: HostedEnvironment;
    tool: string;
    decision: "allow" | "deny";
    detail: string;
    gateway: { digest: string; decision: "allow" | "deny" };
    broker: null | { digest: string; decision: "allow" | "deny" };
  }>;
}

export interface DemoView {
  schema: "angelmcp.demo.v4";
  account: { id: string; name: string; handle: string | null };
  angels: DemoAngelView[];
}

export interface BuildDemoViewOptions {
  /**
   * Base URL of the deployed gateway (e.g. `https://…gateway….workers.dev`).
   * Per-environment endpoints are derived from it deterministically; it is real
   * deployment config, never a fabricated value.
   */
  gatewayBaseUrl: string;
}

/**
 * Shape of a well-formed absolute http(s) URL: scheme, a host of valid DNS labels
 * (each label starts and ends alphanumeric, hyphens only interior — no empty
 * labels, leading/trailing dots, or consecutive dots), an optional digits-only
 * port, and an optional path/query/fragment. Used by BOTH validators so the
 * producer and the browser agree that every emitted endpoint is a usable absolute
 * URL — rejecting malformed authorities (`http://:`, `http://x:abc`, `http://%`)
 * and degenerate hosts (`http://.`, `http://-`, `http://foo..bar`, `http://foo.`)
 * while still accepting `localhost`, `127.0.0.1`, interior-hyphen, and multi-label
 * hosts.
 */
export const HTTP_URL_PATTERN =
  /^https?:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d+)?(?:[/?#]\S*)?$/;

/**
 * Parse `gatewayBaseUrl` into a normalized absolute http(s) origin, or throw
 * fail-closed. This is the eager config gate: it must run even when there are no
 * Angels to project, so an unusable GATEWAY_BASE_URL can never pass fail-open.
 */
export function normalizeGatewayOrigin(gatewayBaseUrl: string): string {
  let origin: string;
  try {
    const parsed = new URL(gatewayBaseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("gateway base URL must use http(s)");
    }
    origin = parsed.origin;
  } catch {
    throw new Error(`gateway base URL must be an absolute http(s) origin: ${JSON.stringify(gatewayBaseUrl)}`);
  }
  // `new URL()` is lenient (it accepts degenerate hosts like http://. or
  // http://foo..bar). Re-check the parsed origin against the SAME strict pattern
  // the endpoint validators use, so an empty-Angels account — where no endpoint is
  // built — still fails closed on a malformed base instead of failing open.
  if (!HTTP_URL_PATTERN.test(origin)) {
    throw new Error(`gateway base URL must be an absolute http(s) origin: ${JSON.stringify(gatewayBaseUrl)}`);
  }
  return origin;
}

function endpointFromOrigin(
  origin: string,
  accountId: string,
  handle: string | null,
  angelSlug: string,
  environment: HostedEnvironment,
): string {
  // The canonical coordinate needs a handle; an Account that never claimed
  // one keeps the legacy path until it does.
  if (handle !== null) {
    const suffix = environment === "production" ? "" : "@preview";
    return `${origin}/@${encodeURIComponent(handle)}/${encodeURIComponent(angelSlug)}${suffix}`;
  }
  const path = ["v1", "a", accountId, angelSlug, environment, "mcp"]
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${origin}/${path}`;
}

/**
 * Build the exact MCP endpoint the gateway serves for one Angel/environment.
 * With a handle it is the PD 0001 coordinate `{origin}/@{handle}/{angel}`
 * (production) or `...@preview`; without one it is the legacy
 * `{origin}/v1/a/{account}/{angel}/{environment}/mcp` path.
 *
 * Fail-closed on config: `gatewayBaseUrl` MUST parse as an absolute http(s)
 * origin. Path segments are percent-encoded so an odd account/angel value can
 * never break out of the path.
 */
export function angelEndpoint(
  gatewayBaseUrl: string,
  accountId: string,
  handle: string | null,
  angelSlug: string,
  environment: HostedEnvironment,
): string {
  return endpointFromOrigin(normalizeGatewayOrigin(gatewayBaseUrl), accountId, handle, angelSlug, environment);
}

export async function buildDemoView(
  state: ManagementState,
  fleetFor: (angelId: string, angelSlug: string) => GateFleet,
  options: BuildDemoViewOptions,
): Promise<DemoView> {
  // Fail closed on gateway config BEFORE projecting Angels, so an empty account
  // (reset / fresh account, where the map below never runs) still rejects an
  // unusable GATEWAY_BASE_URL instead of passing fail-open.
  const gatewayOrigin = normalizeGatewayOrigin(options.gatewayBaseUrl);
  const angels = await Promise.all([...state.angels]
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map(async (angel): Promise<DemoAngelView> => {
      const fleet = fleetFor(angel.id, angel.slug);
      const snapshots = await gateSnapshots(fleet);
      const preview = environmentView(
        state,
        angel.id,
        angel.slug,
        "preview",
        snapshots.preview,
      );
      const production = environmentView(
        state,
        angel.id,
        angel.slug,
        "production",
        snapshots.production,
      );
      const versions = state.versions
        .filter((version) => version.angelId === angel.id)
        .sort((left, right) => left.number - right.number)
        .map((version) => versionView(state, angel.id, version));
      return {
        id: angel.slug,
        name: angelName(angel.slug),
        enabled: production.deploymentId !== null
          && production.tools.some((tool) => tool.connections.some((connection) => connection.available)),
        endpoints: {
          preview: endpointFromOrigin(gatewayOrigin, state.account.id, state.account.handle ?? null, angel.slug, "preview"),
          production: endpointFromOrigin(gatewayOrigin, state.account.id, state.account.handle ?? null, angel.slug, "production"),
        },
        connections: connectionViews(state, angel.id),
        environments: { preview, production },
        versions,
        readyForProduction: readyForProduction(state, angel.id),
        activity: activityView(snapshots),
      };
    }));
  // Fail closed: the producer validates its own output against the exact v4
  // validator before returning, so it can never emit an off-schema shape.
  return assertDemoView({
    schema: "angelmcp.demo.v4",
    account: {
      id: state.account.id,
      name: state.account.name,
      handle: state.account.handle ?? null,
    },
    angels,
  });
}

function environmentView(
  state: ManagementState,
  angelId: string,
  angelSlug: string,
  environment: HostedEnvironment,
  snapshots: Record<"broker" | "gateway", PolicyGateState>,
): DemoEnvironmentView {
  const angel = state.angels.find((candidate) => candidate.id === angelId)!;
  const managementEnvironment = angel.environments[environment];
  const deployment = managementEnvironment.activeDeploymentId === null
    ? null
    : deploymentById(state, angelId, managementEnvironment.activeDeploymentId);
  const { broker, gateway } = snapshots;
  const installationAligned = installationMatches(
    broker.installation,
    deployment,
    state.account.id,
    angelSlug,
    environment,
  ) && installationMatches(
    gateway.installation,
    deployment,
    state.account.id,
    angelSlug,
    environment,
  );
  const availabilityAligned = canonicalJson(broker.availability) === canonicalJson(managementEnvironment.availability)
    && canonicalJson(gateway.availability) === canonicalJson(managementEnvironment.availability);
  const version = deployment === null ? null : versionById(state, angelId, deployment.versionId);

  return {
    version: deployment?.version ?? null,
    digest: deployment?.digest ?? null,
    deploymentId: deployment?.id ?? null,
    keyFingerprint: managementEnvironment.keyFingerprint,
    gateAlignment: {
      installation: installationAligned ? "aligned" : "mismatched",
      availability: availabilityAligned ? "aligned" : "mismatched",
    },
    pendingAvailabilityRepair: availabilityRepair(
      managementEnvironment.pendingAvailability?.change ?? null,
    ),
    availability: {
      defaultEnabled: managementEnvironment.availability.defaultEnabled,
      overrides: structuredClone(managementEnvironment.availability.overrides),
      revision: managementEnvironment.availability.revision,
      changedAt: recordedOrDerived(managementEnvironment.availabilityChangedAt),
    },
    keys: environmentKeyViews(managementEnvironment),
    bindings: deployment === null || version === null
      ? []
      : version.artifact.bindingRequirements.map((requirement) => ({
        id: requirement.id,
        provider: requirement.provider,
        connectionIds: structuredClone(deployment.bindings[requirement.id]!),
      })),
    tools: deployment === null || version === null
      ? []
      : version.artifact.tools.map((tool) => ({
        name: tool.name,
        app: appName(tool.provider),
        group: groupName(tool.operation),
        guards: guardLabels(tool),
        connections: deployment.runtimeBindings
          .filter((binding) => binding.tool === tool.name)
          .sort((left, right) => left.connectionId.localeCompare(right.connectionId))
          .map((binding) => ({
            connectionId: binding.connectionId,
            identity: binding.identityLabel,
            available: installationAligned
              && availabilityAligned
              && connectionEnabled(
                managementEnvironment.availability,
                tool.name,
                binding.connectionRef,
              ),
          })),
      })),
    lifecycle: lifecycleEvents(environment, deployment, state.timestamps ?? {}),
  };
}

/**
 * Project an environment's named keys for the view. NEVER includes the secret
 * hash — only id, name, short fingerprint, status, and recorded timestamps
 * (null when a time was never recorded). A pre-named-keys environment is migrated
 * to a single "Default key".
 */
function environmentKeyViews(managementEnvironment: ManagementEnvironment): DemoAgentKeyView[] {
  const keys = managementEnvironment.keys ?? [{
    id: `key_${managementEnvironment.keyHash.slice(0, 24)}`,
    name: "Default key",
    fingerprint: managementEnvironment.keyFingerprint,
    hash: managementEnvironment.keyHash,
    status: "active" as const,
  }];
  return keys.map((key) => ({
    id: key.id,
    name: key.name,
    fingerprint: key.fingerprint,
    status: key.status,
    createdAt: key.createdAt ?? null,
    revokedAt: key.revokedAt ?? null,
  }));
}

/**
 * Derive this environment's lifecycle events from the active deployment.
 *
 * An event whose wall-clock the backend genuinely recorded (`timestamps[id]`)
 * surfaces as `source: "recorded"` with that ISO `at`; an event with no recorded
 * time stays `source: "derived"` with `at: null`. We never invent a precise `at`.
 * The `order` integer is always the authoritative sequence.
 *
 * The version-publish time is keyed by the deployment's `versionId`; the deploy/
 * promotion time by the deployment's `id`.
 *
 * Per-environment separation is structural: a preview environment can only ever
 * emit `version_published` + `preview_deploy`; a production environment only
 * `version_published` + `production_promotion`. The two are never interleaved.
 */
function lifecycleEvents(
  environment: HostedEnvironment,
  deployment: ManagementDeployment | null,
  timestamps: Record<string, string>,
): DemoLifecycleEvent[] {
  if (deployment === null) return [];
  const deployKind = environment === "preview" ? "preview_deploy" : "production_promotion";
  return [
    {
      kind: "version_published",
      environment,
      version: deployment.version,
      deploymentId: null,
      order: 0,
      ...recordedOrDerived(timestamps[deployment.versionId]),
    },
    {
      kind: deployKind,
      environment,
      version: deployment.version,
      deploymentId: deployment.id,
      order: 1,
      ...recordedOrDerived(timestamps[deployment.id]),
    },
  ];
}

function recordedOrDerived(at: string | undefined): DemoRecordedTime {
  return at === undefined ? { source: "derived", at: null } : { source: "recorded", at };
}

function connectionViews(state: ManagementState, angelId: string): DemoConnectionView[] {
  const providers = new Map<string, Set<string>>();
  for (const deployment of state.deployments.filter((candidate) => candidate.angelId === angelId)) {
    const version = versionById(state, angelId, deployment.versionId);
    for (const requirement of version.artifact.bindingRequirements) {
      for (const connectionId of deployment.bindings[requirement.id] ?? []) {
        const values = providers.get(connectionId) ?? new Set<string>();
        values.add(requirement.provider);
        providers.set(connectionId, values);
      }
    }
  }
  return [...providers.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([connectionId, usedProviders]) => {
      const connection = connectionById(state, connectionId);
      return {
        id: connection.id,
        label: connection.nickname,
        apps: [...usedProviders].sort().map(appName),
        health: connection.health,
      };
    });
}

function versionView(
  state: ManagementState,
  angelId: string,
  version: PublishedAngelVersion,
): DemoAngelView["versions"][number] {
  const angel = state.angels.find((candidate) => candidate.id === angelId)!;
  const production = activeDeployment(state, angelId, angel.environments.production.activeDeploymentId);
  const preview = activeDeployment(state, angelId, angel.environments.preview.activeDeploymentId);
  return {
    number: version.number,
    digest: version.digest,
    label: `Version ${version.number}`,
    status: production?.versionId === version.id
      ? "live"
      : preview?.versionId === version.id
      ? "staged"
      : "history",
    tools: version.artifact.tools.map((tool) => tool.name),
  };
}

function readyForProduction(state: ManagementState, angelId: string): DemoAngelView["readyForProduction"] {
  const angel = state.angels.find((candidate) => candidate.id === angelId)!;
  const preview = activeDeployment(state, angelId, angel.environments.preview.activeDeploymentId);
  if (preview === null) return null;
  const production = activeDeployment(state, angelId, angel.environments.production.activeDeploymentId);
  if (
    production?.versionId === preview.versionId
    && production.digest === preview.digest
    && angel.environments.production.pendingDeploymentId === null
  ) return null;
  if (production === null) return null;
  const stagedVersion = versionById(state, angelId, preview.versionId);
  const productionVersion = versionById(state, angelId, production.versionId);
  if (!bindingsFitVersion(state, stagedVersion, production.bindings)) return null;
  const stagedTools = new Set(stagedVersion.artifact.tools.map((tool) => tool.name));
  const productionTools = new Set(productionVersion.artifact.tools.map((tool) => tool.name));
  return {
    stagedDeploymentId: preview.id,
    expectedDigest: preview.digest,
    fromVersion: production.version,
    toVersion: preview.version,
    diff: {
      added: [...stagedTools].filter((tool) => !productionTools.has(tool)).sort(),
      removed: [...productionTools].filter((tool) => !stagedTools.has(tool)).sort(),
    },
    bindings: structuredClone(production.bindings),
  };
}

function bindingsFitVersion(
  state: ManagementState,
  version: PublishedAngelVersion,
  bindings: Record<string, string[]>,
): boolean {
  const requirements = [...version.artifact.bindingRequirements].sort((left, right) => left.id.localeCompare(right.id));
  if (canonicalJson(requirements.map((requirement) => requirement.id)) !== canonicalJson(Object.keys(bindings).sort())) {
    return false;
  }
  return requirements.every((requirement) => {
    const connectionIds = bindings[requirement.id];
    return Array.isArray(connectionIds)
      && connectionIds.length > 0
      && connectionIds.every((connectionId) => {
        const connection = state.connections.find((candidate) => candidate.id === connectionId);
        return connection !== undefined
          && connection.accountId === state.account.id
          && connection.credential === requirement.credential
          && connection.providers.includes(requirement.provider);
      });
  });
}

type DemoSnapshots = Record<
  HostedEnvironment,
  Record<"broker" | "gateway", PolicyGateState>
>;

async function gateSnapshots(fleet: GateFleet): Promise<DemoSnapshots> {
  const [previewBroker, previewGateway, productionBroker, productionGateway] = await Promise.all([
    fleet.snapshot("broker", "preview"),
    fleet.snapshot("gateway", "preview"),
    fleet.snapshot("broker", "production"),
    fleet.snapshot("gateway", "production"),
  ]);
  return {
    preview: { broker: previewBroker, gateway: previewGateway },
    production: { broker: productionBroker, gateway: productionGateway },
  };
}

function activityView(snapshots: DemoSnapshots): DemoAngelView["activity"] {
  const activity: DemoAngelView["activity"] = [];
  for (const environment of ["preview", "production"] as const) {
    const gateway = snapshots[environment].gateway.receipts;
    const broker = snapshots[environment].broker.receipts;
    for (const receipt of gateway) activity.push(activityEvent(environment, receipt, broker));
  }
  return activity;
}

function activityEvent(
  environment: HostedEnvironment,
  gateway: GateReceipt,
  brokerReceipts: GateReceipt[],
): DemoAngelView["activity"][number] {
  const broker = brokerReceipts.find((candidate) => candidate.requestId === gateway.requestId);
  const mismatch = broker === undefined ? null : gateReceiptMismatch(gateReceiptIdentity(gateway), broker);
  const effective = broker ?? gateway;
  return {
    requestId: gateway.requestId,
    environment,
    tool: gateway.tool,
    decision: mismatch === null ? effective.decision : "deny",
    detail: mismatch === null
      ? effective.detail
      : `gate receipt mismatch: ${mismatch.field} differs between gateway and broker`,
    gateway: { digest: gateway.policyDigest, decision: gateway.decision },
    broker: broker === undefined ? null : { digest: broker.policyDigest, decision: broker.decision },
  };
}

function installationMatches(
  installation: GateInstallation | null,
  deployment: ManagementDeployment | null,
  accountId: string,
  angelSlug: string,
  environment: HostedEnvironment,
): boolean {
  if (deployment === null) return installation === null;
  return installation !== null
    && installation.accountId === accountId
    && installation.angelId === angelSlug
    && installation.environment === environment
    && installation.deploymentId === deployment.id
    && installation.version === deployment.version
    && installation.policyDigest === deployment.digest
    && canonicalJson(sortedRuntimeBindings(installation.bindings))
      === canonicalJson(sortedRuntimeBindings(deployment.runtimeBindings));
}

function sortedRuntimeBindings<T extends { tool: string; connectionRef: string }>(bindings: T[]): T[] {
  return [...bindings].sort((left, right) => {
    const byTool = left.tool.localeCompare(right.tool);
    return byTool === 0 ? left.connectionRef.localeCompare(right.connectionRef) : byTool;
  });
}

function availabilityRepair(
  change: ManagementAvailabilityChange | null,
): DemoEnvironmentView["pendingAvailabilityRepair"] {
  if (change === null) return null;
  if (change.kind === "all") return { action: change.enabled ? "resume_all" : "pause_all" };
  return {
    action: change.enabled ? "resume_tool" : "pause_tool",
    tool: change.tool,
    ...(change.kind === "tool_connection" ? { connectionId: change.connectionId } : {}),
  };
}

function connectionEnabled(availability: GateAvailability, tool: string, connectionRef: string): boolean {
  return availability.connectionOverrides[tool]?.[connectionRef]
    ?? availability.overrides[tool]
    ?? availability.defaultEnabled;
}

function activeDeployment(
  state: ManagementState,
  angelId: string,
  deploymentId: string | null,
): ManagementDeployment | null {
  return deploymentId === null ? null : deploymentById(state, angelId, deploymentId);
}

function deploymentById(state: ManagementState, angelId: string, deploymentId: string): ManagementDeployment {
  const deployment = state.deployments.find(
    (candidate) => candidate.id === deploymentId && candidate.angelId === angelId,
  );
  if (deployment === undefined) throw new Error(`management deployment not found: ${deploymentId}`);
  return deployment;
}

function versionById(state: ManagementState, angelId: string, versionId: string): PublishedAngelVersion {
  const version = state.versions.find(
    (candidate) => candidate.id === versionId && candidate.angelId === angelId,
  );
  if (version === undefined) throw new Error(`management Version not found: ${versionId}`);
  return version;
}

function connectionById(state: ManagementState, connectionId: string): ManagementConnection {
  const connection = state.connections.find(
    (candidate) => candidate.id === connectionId && candidate.accountId === state.account.id,
  );
  if (connection === undefined) throw new Error(`management Connection not found: ${connectionId}`);
  return connection;
}

function guardLabels(tool: HostedTool): string[] {
  return tool.argGuards.map((guard) => {
    if ("pin" in guard) return `${guard.field} pinned to ${guard.pin}`;
    if ("forbid" in guard) return `${guard.field} forbidden`;
    return `${guard.field} forbids ${guard.forbiddenValues.join(", ")}`;
  });
}

function appName(provider: string): string {
  if (provider === "gmail") return "Gmail";
  if (provider === "docs") return "Google Docs";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function groupName(operation: string): string {
  const action = operation.split(".").at(-1)?.toLowerCase();
  return action === "get" || action === "list" || action === "getprofile" ? "Read" : "Use";
}

function angelName(slug: string): string {
  return slug
    .replace(/-cloud$/, "")
    .split("-")
    .map((part) => part === "gmail" ? "Gmail" : part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Exact, fail-closed runtime validator for angelmcp.demo.v4.
//
// This is the producer-side twin of the validator in www/app.js: the two MUST
// stay in lockstep. It rejects unknown or missing fields, older schema ids,
// and any lifecycle event that crosses the strict preview/production separation
// boundary. There is no soft fallback — a malformed view throws.
// ---------------------------------------------------------------------------

const DEMO_ENVIRONMENTS: readonly HostedEnvironment[] = ["preview", "production"];

function demoFail(path: string, expectation: string): never {
  throw new Error(`Invalid demo state: ${path} ${expectation}.`);
}

function demoRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    demoFail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function demoExact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  const object = demoRecord(value, path);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    demoFail(path, `must contain exactly ${expected.join(", ")}`);
  }
  return object;
}

function demoText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") demoFail(path, "must be a non-empty string");
  return value;
}

function demoHttpUrl(value: unknown, path: string): string {
  const url = demoText(value, path);
  if (!HTTP_URL_PATTERN.test(url)) demoFail(path, "must be an absolute http(s) URL");
  return url;
}

function demoBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") demoFail(path, "must be a boolean");
  return value;
}

function demoInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) demoFail(path, "must be a non-negative integer");
  return value as number;
}

function demoNullableInteger(value: unknown, path: string): number | null {
  return value === null ? null : demoInteger(value, path);
}

function demoNullableText(value: unknown, path: string): string | null {
  return value === null ? null : demoText(value, path);
}

// Strict ISO-8601 UTC instant: 2026-07-22T12:00:00Z or …:00.000Z. Recorded times
// are only ever this shape; anything else fails closed (a bare string is not a
// trustworthy timestamp). Capture groups drive a calendar round-trip check below.
const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

function demoIsoUtc(value: unknown, path: string): string {
  const text = demoText(value, path);
  const match = ISO_UTC_PATTERN.exec(text);
  if (match === null || Number.isNaN(Date.parse(text))) {
    demoFail(path, "must be an ISO-8601 UTC timestamp");
  }
  // Reject nonexistent calendar dates (e.g. 2026-02-30) that Date.parse silently
  // normalizes: the parsed UTC components must match the literal input exactly.
  const parsed = new Date(text);
  if (parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() + 1 !== Number(match[2])
    || parsed.getUTCDate() !== Number(match[3])
    || parsed.getUTCHours() !== Number(match[4])
    || parsed.getUTCMinutes() !== Number(match[5])
    || parsed.getUTCSeconds() !== Number(match[6])) {
    demoFail(path, "must be a real calendar date-time");
  }
  return text;
}

function demoNullableIsoUtc(value: unknown, path: string): string | null {
  return value === null ? null : demoIsoUtc(value, path);
}

function demoRecordedTime(value: unknown, path: string): DemoRecordedTime {
  const record = demoExact(value, ["source", "at"], path);
  const source = demoOneOf(record.source, ["recorded", "derived"] as const, `${path}.source`);
  if (source === "derived") {
    if (record.at !== null) demoFail(`${path}.at`, "must be null for a derived time");
    return { source, at: null };
  }
  return { source, at: demoIsoUtc(record.at, `${path}.at`) };
}

function demoOneOf<T extends string>(value: unknown, choices: readonly T[], path: string): T {
  if (!choices.includes(value as T)) demoFail(path, `must be one of ${choices.join(", ")}`);
  return value as T;
}

function demoList<T>(value: unknown, path: string, validate: (entry: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) demoFail(path, "must be an array");
  return value.map((entry, index) => validate(entry, `${path}[${index}]`));
}

function demoTextList(value: unknown, path: string): string[] {
  return demoList(value, path, demoText);
}

function validateDemoConnection(value: unknown, path: string): DemoConnectionView {
  const connection = demoExact(value, ["id", "label", "apps", "health"], path);
  return {
    id: demoText(connection.id, `${path}.id`),
    label: demoText(connection.label, `${path}.label`),
    apps: demoTextList(connection.apps, `${path}.apps`),
    health: demoOneOf(connection.health, ["healthy", "error"] as const, `${path}.health`),
  };
}

function validateDemoToolConnection(value: unknown, path: string): DemoToolConnectionView {
  const connection = demoExact(value, ["connectionId", "identity", "available"], path);
  return {
    connectionId: demoText(connection.connectionId, `${path}.connectionId`),
    identity: demoText(connection.identity, `${path}.identity`),
    available: demoBoolean(connection.available, `${path}.available`),
  };
}

function validateDemoTool(value: unknown, path: string): DemoToolView {
  const tool = demoExact(value, ["name", "app", "group", "guards", "connections"], path);
  return {
    name: demoText(tool.name, `${path}.name`),
    app: demoText(tool.app, `${path}.app`),
    group: demoText(tool.group, `${path}.group`),
    guards: demoTextList(tool.guards, `${path}.guards`),
    connections: demoList(tool.connections, `${path}.connections`, validateDemoToolConnection),
  };
}

function validateDemoBinding(value: unknown, path: string): DemoBindingView {
  const binding = demoExact(value, ["id", "provider", "connectionIds"], path);
  return {
    id: demoText(binding.id, `${path}.id`),
    provider: demoText(binding.provider, `${path}.provider`),
    connectionIds: demoTextList(binding.connectionIds, `${path}.connectionIds`),
  };
}

function validateDemoLifecycleEvent(
  value: unknown,
  path: string,
  environment: HostedEnvironment,
): DemoLifecycleEvent {
  const event = demoExact(
    value,
    ["kind", "environment", "version", "deploymentId", "order", "source", "at"],
    path,
  );
  const kind = demoOneOf(
    event.kind,
    ["version_published", "preview_deploy", "production_promotion"] as const,
    `${path}.kind`,
  );
  // Strict per-environment separation: an event's environment must equal the
  // environment whose lifecycle carries it, and a deploy/promotion kind must
  // match that environment. Preview and production data are never interleaved.
  const eventEnvironment = demoOneOf(event.environment, DEMO_ENVIRONMENTS, `${path}.environment`);
  if (eventEnvironment !== environment) {
    demoFail(`${path}.environment`, `must equal ${environment} (no cross-environment lifecycle)`);
  }
  const expectedDeployKind = environment === "preview" ? "preview_deploy" : "production_promotion";
  if (kind !== "version_published" && kind !== expectedDeployKind) {
    demoFail(`${path}.kind`, `must be version_published or ${expectedDeployKind} in ${environment}`);
  }
  // version_published is version-scoped (no deployment id); a deploy/promotion
  // names its deployment.
  const deploymentId = kind === "version_published"
    ? (event.deploymentId === null
      ? null
      : demoFail(`${path}.deploymentId`, "must be null for version_published"))
    : demoText(event.deploymentId, `${path}.deploymentId`);
  const source = demoOneOf(event.source, ["recorded", "derived"] as const, `${path}.source`);
  // The real-vs-derived contract: a derived event never carries a timestamp; a
  // recorded event always does. This is what downstream consumers trust.
  const at = source === "derived"
    ? (event.at === null ? null : demoFail(`${path}.at`, "must be null for a derived event"))
    : demoIsoUtc(event.at, `${path}.at`);
  return {
    kind,
    environment: eventEnvironment,
    version: demoInteger(event.version, `${path}.version`),
    deploymentId,
    order: demoInteger(event.order, `${path}.order`),
    source,
    at,
  };
}

function validateDemoAgentKey(value: unknown, path: string): DemoAgentKeyView {
  const key = demoExact(value, ["id", "name", "fingerprint", "status", "createdAt", "revokedAt"], path);
  return {
    id: demoText(key.id, `${path}.id`),
    name: demoText(key.name, `${path}.name`),
    fingerprint: demoText(key.fingerprint, `${path}.fingerprint`),
    status: demoOneOf(key.status, ["active", "revoked"] as const, `${path}.status`),
    createdAt: demoNullableIsoUtc(key.createdAt, `${path}.createdAt`),
    revokedAt: demoNullableIsoUtc(key.revokedAt, `${path}.revokedAt`),
  };
}

function validateDemoAvailabilityRepair(
  value: unknown,
  path: string,
): DemoEnvironmentView["pendingAvailabilityRepair"] {
  if (value === null) return null;
  const command = demoRecord(value, path);
  const action = demoOneOf(
    command.action,
    ["pause_all", "resume_all", "pause_tool", "resume_tool"] as const,
    `${path}.action`,
  );
  if (action === "pause_tool" || action === "resume_tool") {
    const keys = ["action", "tool"];
    if (Object.hasOwn(command, "connectionId")) keys.push("connectionId");
    demoExact(command, keys, path);
    return {
      action,
      tool: demoText(command.tool, `${path}.tool`),
      ...(command.connectionId === undefined
        ? {}
        : { connectionId: demoText(command.connectionId, `${path}.connectionId`) }),
    };
  }
  demoExact(command, ["action"], path);
  return { action };
}

function validateDemoEnvironment(
  value: unknown,
  path: string,
  environment: HostedEnvironment,
): DemoEnvironmentView {
  const view = demoExact(
    value,
    ["version", "digest", "deploymentId", "keyFingerprint", "gateAlignment", "pendingAvailabilityRepair", "availability", "keys", "bindings", "tools", "lifecycle"],
    path,
  );
  const alignment = demoExact(view.gateAlignment, ["installation", "availability"], `${path}.gateAlignment`);
  const availability = demoExact(view.availability, ["defaultEnabled", "overrides", "revision", "changedAt"], `${path}.availability`);
  const overrides = demoRecord(availability.overrides, `${path}.availability.overrides`);
  const normalizedOverrides: Record<string, boolean> = {};
  for (const [tool, available] of Object.entries(overrides)) {
    demoText(tool, `${path}.availability.overrides key`);
    normalizedOverrides[tool] = demoBoolean(available, `${path}.availability.overrides.${tool}`);
  }
  return {
    version: demoNullableInteger(view.version, `${path}.version`),
    digest: demoNullableText(view.digest, `${path}.digest`),
    deploymentId: demoNullableText(view.deploymentId, `${path}.deploymentId`),
    keyFingerprint: demoText(view.keyFingerprint, `${path}.keyFingerprint`),
    gateAlignment: {
      installation: demoOneOf(alignment.installation, ["aligned", "mismatched"] as const, `${path}.gateAlignment.installation`),
      availability: demoOneOf(alignment.availability, ["aligned", "mismatched"] as const, `${path}.gateAlignment.availability`),
    },
    pendingAvailabilityRepair: validateDemoAvailabilityRepair(view.pendingAvailabilityRepair, `${path}.pendingAvailabilityRepair`),
    availability: {
      defaultEnabled: demoBoolean(availability.defaultEnabled, `${path}.availability.defaultEnabled`),
      overrides: normalizedOverrides,
      revision: demoInteger(availability.revision, `${path}.availability.revision`),
      changedAt: demoRecordedTime(availability.changedAt, `${path}.availability.changedAt`),
    },
    keys: demoList(view.keys, `${path}.keys`, validateDemoAgentKey),
    bindings: demoList(view.bindings, `${path}.bindings`, validateDemoBinding),
    tools: demoList(view.tools, `${path}.tools`, validateDemoTool),
    lifecycle: demoList(view.lifecycle, `${path}.lifecycle`, (entry, entryPath) => validateDemoLifecycleEvent(entry, entryPath, environment)),
  };
}

function validateDemoVersion(value: unknown, path: string): DemoAngelView["versions"][number] {
  const version = demoExact(value, ["number", "digest", "label", "status", "tools"], path);
  return {
    number: demoInteger(version.number, `${path}.number`),
    digest: demoText(version.digest, `${path}.digest`),
    label: demoText(version.label, `${path}.label`),
    status: demoOneOf(version.status, ["staged", "live", "history"] as const, `${path}.status`),
    tools: demoTextList(version.tools, `${path}.tools`),
  };
}

function validateDemoBindingMap(value: unknown, path: string): Record<string, string[]> {
  const bindings = demoRecord(value, path);
  const normalized: Record<string, string[]> = {};
  for (const [requirementId, connectionIds] of Object.entries(bindings)) {
    demoText(requirementId, `${path} key`);
    normalized[requirementId] = demoTextList(connectionIds, `${path}.${requirementId}`);
  }
  return normalized;
}

function validateDemoReady(value: unknown, path: string): DemoAngelView["readyForProduction"] {
  if (value === null) return null;
  const ready = demoExact(
    value,
    ["stagedDeploymentId", "expectedDigest", "fromVersion", "toVersion", "diff", "bindings"],
    path,
  );
  const diff = demoExact(ready.diff, ["added", "removed"], `${path}.diff`);
  return {
    stagedDeploymentId: demoText(ready.stagedDeploymentId, `${path}.stagedDeploymentId`),
    expectedDigest: demoText(ready.expectedDigest, `${path}.expectedDigest`),
    fromVersion: demoNullableInteger(ready.fromVersion, `${path}.fromVersion`),
    toVersion: demoInteger(ready.toVersion, `${path}.toVersion`),
    diff: {
      added: demoTextList(diff.added, `${path}.diff.added`),
      removed: demoTextList(diff.removed, `${path}.diff.removed`),
    },
    bindings: validateDemoBindingMap(ready.bindings, `${path}.bindings`),
  };
}

function validateDemoReceipt(value: unknown, path: string, nullable: boolean): { digest: string; decision: "allow" | "deny" } | null {
  if (value === null) {
    if (nullable) return null;
    demoFail(path, "must be an object");
  }
  const receipt = demoExact(value, ["digest", "decision"], path);
  return {
    digest: demoText(receipt.digest, `${path}.digest`),
    decision: demoOneOf(receipt.decision, ["allow", "deny"] as const, `${path}.decision`),
  };
}

function validateDemoActivity(value: unknown, path: string): DemoAngelView["activity"][number] {
  const event = demoExact(
    value,
    ["requestId", "environment", "tool", "decision", "detail", "gateway", "broker"],
    path,
  );
  return {
    requestId: demoText(event.requestId, `${path}.requestId`),
    environment: demoOneOf(event.environment, DEMO_ENVIRONMENTS, `${path}.environment`),
    tool: demoText(event.tool, `${path}.tool`),
    decision: demoOneOf(event.decision, ["allow", "deny"] as const, `${path}.decision`),
    detail: demoText(event.detail, `${path}.detail`),
    gateway: validateDemoReceipt(event.gateway, `${path}.gateway`, false)!,
    broker: validateDemoReceipt(event.broker, `${path}.broker`, true),
  };
}

function validateDemoAngel(value: unknown, path: string): DemoAngelView {
  const angel = demoExact(
    value,
    ["id", "name", "enabled", "endpoints", "connections", "environments", "versions", "readyForProduction", "activity"],
    path,
  );
  const environments = demoExact(angel.environments, DEMO_ENVIRONMENTS, `${path}.environments`);
  const endpoints = demoExact(angel.endpoints, DEMO_ENVIRONMENTS, `${path}.endpoints`);
  return {
    id: demoText(angel.id, `${path}.id`),
    name: demoText(angel.name, `${path}.name`),
    enabled: demoBoolean(angel.enabled, `${path}.enabled`),
    endpoints: {
      preview: demoHttpUrl(endpoints.preview, `${path}.endpoints.preview`),
      production: demoHttpUrl(endpoints.production, `${path}.endpoints.production`),
    },
    connections: demoList(angel.connections, `${path}.connections`, validateDemoConnection),
    environments: {
      preview: validateDemoEnvironment(environments.preview, `${path}.environments.preview`, "preview"),
      production: validateDemoEnvironment(environments.production, `${path}.environments.production`, "production"),
    },
    versions: demoList(angel.versions, `${path}.versions`, validateDemoVersion),
    readyForProduction: validateDemoReady(angel.readyForProduction, `${path}.readyForProduction`),
    activity: demoList(angel.activity, `${path}.activity`, validateDemoActivity),
  };
}

/**
 * Validate an arbitrary value as an exact angelmcp.demo.v4 view, returning a
 * normalized copy. Throws on any deviation — including the older schema ids.
 */
export function assertDemoView(value: unknown): DemoView {
  const root = demoExact(value, ["schema", "account", "angels"], "response");
  if (root.schema !== "angelmcp.demo.v4") demoFail("response.schema", "must equal angelmcp.demo.v4");
  const account = demoExact(root.account, ["id", "name", "handle"], "response.account");
  return {
    schema: "angelmcp.demo.v4",
    account: {
      id: demoText(account.id, "response.account.id"),
      name: demoText(account.name, "response.account.name"),
      handle: demoNullableText(account.handle, "response.account.handle"),
    },
    angels: demoList(root.angels, "response.angels", validateDemoAngel),
  };
}
