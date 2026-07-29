/// <reference path="../../types/control.d.ts" />

import { DurableObject } from "cloudflare:workers";
import { canonicalJson } from "@smcllns/angel-core";
import { sha256Hex } from "@smcllns/angel-core";
import { buildDemoView, type DemoView } from "../demo-view";
import type { DeploymentEnvironment } from "../domain";
import {
  AesGcmResponseReplayVault,
  ManagementControl,
  ManagementError,
  createManagementState,
} from "../management";
import type {
  ManagementCommand,
  ManagementBindingMap,
  ManagementConnection,
  ManagementState,
} from "../management-contract";
import { DEMO_ACCOUNT } from "../demo-fixtures";
import {
  ACCOUNT_HANDLE_PATTERN,
  claimAccountHandle,
  classifyAccountHandle,
  resolveAccountHandle,
  HandleError,
  type HandleAccountRecord,
  type HandleClaim,
  type HandleResolution,
} from "../handles";
import { ServiceGateFleet } from "./service-gate-fleet";
import {
  emptyProviderManagementState,
  managementConnectionsFromProviderSummaries,
  reconcileManagementConnections,
  type ConnectionSummary,
  type ProviderAppSummary,
  type ProviderManagementState,
  type ProviderRegistryCommand,
} from "../provider-management";

export type DemoAction = "promote" | "pause_all" | "resume_all" | "pause_tool" | "resume_tool";

export type DemoAccountRegistryCommand =
  | { operation: "state" }
  | { operation: "reset" }
  | {
      operation: "action";
      angelId: string;
      action: DemoAction;
      environment: DeploymentEnvironment;
      tool?: string;
      connectionId?: string;
      stagedDeploymentId?: string;
      expectedDigest?: string;
      bindings?: ManagementBindingMap;
    }
  | {
      // Named-key CRUD reachable from the bearer-free control UI. `angelId` is the
      // demo SLUG (resolved to the generated Management id in keyAction), and
      // `idempotencyToken` is a client-supplied per-attempt token REUSED on retry
      // so a committed-but-lost mutation replays instead of minting a duplicate.
      operation: "key_action";
      action: "create_key" | "rotate_key" | "revoke_key";
      angelId: string;
      environment: DeploymentEnvironment;
      idempotencyToken: string;
      name?: string;
      keyId?: string;
    };

// Handle directory commands are only ever dispatched to the singleton
// HANDLE_DIRECTORY_REGISTRY instance, which holds the platform-wide claims.
export type HandleRegistryCommand =
  | { operation: "claim_handle"; accountId: string; handle: string }
  | { operation: "resolve_handle"; handle: string };

export type AccountRegistryCommand =
  | DemoAccountRegistryCommand
  | ManagementCommand
  | ProviderRegistryCommand
  | HandleRegistryCommand;

type RegistryResult =
  | { ok: true; value: unknown; status?: number }
  | { ok: false; status: number; error: string };

export class AccountRegistry extends DurableObject<ControlEnv> {
  private tail: Promise<void> = Promise.resolve();

  async dispatchJson(command: AccountRegistryCommand): Promise<string> {
    return this.exclusive(async () => JSON.stringify(await this.dispatch(command)));
  }

  private async dispatch(command: AccountRegistryCommand): Promise<RegistryResult> {
    try {
      switch (command.operation) {
        case "state":
          return { ok: true, value: await this.view() };
        case "reset":
          return { ok: true, value: await this.reset() };
        case "action":
          return { ok: true, value: await this.action(command) };
        case "key_action":
          return { ok: true, value: await this.keyAction(command) };
        case "claim_handle":
          return { ok: true, value: await this.claimHandle(command.accountId, command.handle) };
        case "resolve_handle":
          return { ok: true, value: await this.resolveHandle(command.handle) };
        case "ensure_angel":
          return {
            ok: true,
            value: await (await this.management()).ensureAngel(
              command.accountId,
              command.slug,
              command.mutation,
            ),
          };
        case "delete_angel":
          return {
            ok: true,
            value: await (await this.management()).deleteAngel(
              command.accountId,
              command.slug,
              command.input,
              command.mutation,
            ),
          };
        case "get_angel_by_slug":
          return {
            ok: true,
            value: (await this.management()).getAngelBySlug(command.accountId, command.slug),
          };
        case "get_angel":
          return { ok: true, value: (await this.management()).getAngel(command.angelId) };
        case "get_version":
          return {
            ok: true,
            value: (await this.management()).getVersion(command.angelId, command.versionId),
          };
        case "list_connections":
          await this.reconcileFromBroker();
          return {
            ok: true,
            value: (await this.management()).listConnections(command.accountId),
          };
        case "publish_version":
          return {
            ok: true,
            value: await (await this.management()).publishVersion(
              command.angelId,
              command.input,
              command.mutation,
            ),
          };
        case "deploy_staging":
          await this.reconcileFromBroker();
          return {
            ok: true,
            value: await (await this.management()).deployStaging(
              command.angelId,
              command.input,
              command.mutation,
            ),
          };
        case "get_environment":
          return {
            ok: true,
            value: (await this.management()).getEnvironment(command.angelId, command.environment),
          };
        case "change_availability":
          return {
            ok: true,
            value: await (await this.management()).changeAvailability(
              command.angelId,
              command.environment,
              command.input,
              command.mutation,
            ),
          };
        case "list_provider_apps":
          return { ok: true, value: (await this.providerState()).providerApps };
        case "list_provider_connections":
          return { ok: true, value: (await this.providerState()).connections };
        case "reconcile_provider_apps":
          this.assertProviderAccount(command.accountId, command.accountId);
          await this.reconcileProviderApps(command.providerApps);
          return { ok: true, value: command.providerApps };
        case "reconcile_provider_connections":
          this.assertProviderAccount(command.accountId, command.accountId);
          await this.reconcileProviderConnections(command.connections);
          return { ok: true, value: command.connections };
        case "save_provider_app":
          this.assertProviderAccount(command.accountId, command.summary.accountId);
          {
            const state = await this.providerState();
            const index = state.providerApps.findIndex((candidate) => candidate.id === command.summary.id);
            if (index === -1) state.providerApps.push(structuredClone(command.summary));
            else state.providerApps[index] = structuredClone(command.summary);
            await this.ctx.storage.put("providers", state);
            return { ok: true, value: command.summary };
          }
        case "save_provider_connection":
          this.assertProviderAccount(command.accountId, command.summary.accountId);
          {
            const state = await this.providerState();
            const index = state.connections.findIndex((candidate) => candidate.id === command.summary.id);
            if (index === -1) state.connections.push(structuredClone(command.summary));
            else state.connections[index] = structuredClone(command.summary);
            await this.ctx.storage.put("providers", state);
            return { ok: true, value: command.summary };
          }
        case "remove_provider_connection":
          this.assertProviderAccount(command.accountId, command.accountId);
          {
            const state = await this.providerState();
            state.connections = state.connections.filter((candidate) => candidate.id !== command.connectionId);
            await this.ctx.storage.put("providers", state);
            return { ok: true, value: { removed: true } };
          }
        case "put_oauth_state":
          this.assertProviderAccount(command.accountId, command.state.accountId);
          {
            const state = await this.providerState();
            state.oauthStates[command.state.state] = structuredClone(command.state);
            await this.ctx.storage.put("providers", state);
            return { ok: true, value: null };
          }
        case "take_oauth_state":
          this.assertProviderAccount(command.accountId, command.accountId);
          {
            const state = await this.providerState();
            const record = state.oauthStates[command.state];
            if (
              record === undefined
              || record.used
              || command.now >= record.expiresAt
              || record.accountId !== command.accountId
              || record.accessSubject !== command.accessSubject
            ) throw new RegistryError(400, "OAuth state invalid, expired, or already used");
            record.used = true;
            delete state.oauthStates[command.state];
            await this.ctx.storage.put("providers", state);
            return {
              ok: true,
              value: {
                providerAppId: record.providerAppId,
                connectionId: record.connectionId,
                nickname: record.nickname,
                codeVerifier: record.codeVerifier,
                redirectUri: record.redirectUri,
                flow: record.flow,
              },
            };
          }
        case "promote_production":
          await this.reconcileFromBroker();
          return {
            ok: true,
            value: await (await this.management()).promoteProduction(
              command.angelId,
              command.input,
              command.mutation,
            ),
          };
        case "create_key":
          return {
            ok: true,
            value: await (await this.management()).createKey(
              command.angelId,
              command.environment,
              command.input,
              command.mutation,
            ),
          };
        case "rotate_key":
          return {
            ok: true,
            value: await (await this.management()).rotateKey(
              command.angelId,
              command.environment,
              command.input,
              command.mutation,
            ),
          };
        case "revoke_key":
          return {
            ok: true,
            value: await (await this.management()).revokeKey(
              command.angelId,
              command.environment,
              command.input,
              command.mutation,
            ),
          };
      }
    } catch (error) {
      if (
        error instanceof RegistryError
        || error instanceof ManagementError
        || error instanceof HandleError
      ) {
        return { ok: false, status: error.status, error: error.message };
      }
      return {
        ok: false,
        status: 500,
        error: error instanceof Error ? error.message : "control operation failed",
      };
    }
  }

  // One storage key per claimed name and per Account: resolution reads one or
  // two keys, and no single record grows with the platform.
  private async claimHandle(accountId: string, handle: string): Promise<HandleClaim> {
    // Validate before any storage access: Durable Object keys cap at 2 KiB,
    // so an unclaimable name must never become a storage key probe.
    const classification = classifyAccountHandle(handle);
    if (!classification.ok) {
      throw new HandleError(classification.kind === "invalid" ? 400 : 403, classification.message);
    }
    const owner = await this.ctx.storage.get<string>(`handle:${handle}`);
    const record = await this.ctx.storage.get<HandleAccountRecord>(`account:${accountId}`);
    const { account, changed } = claimAccountHandle({ accountId, handle, owner, account: record });
    if (changed) {
      await this.ctx.storage.put({
        [`handle:${handle}`]: accountId,
        [`account:${accountId}`]: { handle: account.handle, retiredHandle: account.retiredHandle },
      });
    }
    return account;
  }

  private async resolveHandle(handle: string): Promise<HandleResolution> {
    // An unclaimable name is by definition unclaimed — answer without ever
    // building it into a storage key.
    if (!ACCOUNT_HANDLE_PATTERN.test(handle)) throw new RegistryError(404, "unknown handle");
    const owner = await this.ctx.storage.get<string>(`handle:${handle}`);
    const record = owner === undefined
      ? undefined
      : await this.ctx.storage.get<HandleAccountRecord>(`account:${owner}`);
    const resolution = resolveAccountHandle(handle, owner, record);
    if (resolution === null) throw new RegistryError(404, "unknown handle");
    return resolution;
  }

  private async reset(): Promise<DemoView> {
    const existing = await this.ctx.storage.get<ManagementState>("management");
    const slugs = new Set(existing?.angels.map((angel) => angel.slug) ?? []);
    for (const slug of slugs) {
      const fleet = this.managementFleet(slug);
      for (const gate of ["broker", "gateway"] as const) {
        for (const environment of ["staging", "production"] as const) {
          await fleet.reset(gate, environment);
        }
      }
    }
    const state = createManagementState({
      account: { ...DEMO_ACCOUNT, id: this.env.ACCOUNT_ID },
      connections: managementConnections(this.env.ACCOUNT_ID),
    });
    await this.ctx.storage.put("management", state);
    return buildDemoView(
      state,
      (_angelId, slug) => this.managementFleet(slug),
      { gatewayBaseUrl: this.env.GATEWAY_BASE_URL },
    );
  }

  private async action(command: Extract<AccountRegistryCommand, { operation: "action" }>): Promise<DemoView> {
    const control = await this.management();
    const angel = control.getAngelBySlug(this.env.ACCOUNT_ID, command.angelId);
    if (command.action === "promote") {
      await this.promote(control, angel.id, command);
    } else {
      const current = control.getEnvironment(angel.id, command.environment);
      const enabled = command.action === "resume_all" || command.action === "resume_tool";
      const change = command.action === "pause_all" || command.action === "resume_all"
        ? { kind: "all" as const, enabled }
        : command.connectionId === undefined
        ? { kind: "tool" as const, tool: command.tool!, enabled }
        : {
            kind: "tool_connection" as const,
            tool: command.tool!,
            connectionId: command.connectionId,
            enabled,
          };
      if (current.pendingAvailability === null && availabilityAlready(current.availability, change)) {
        return this.view(control.exportState());
      }
      // Bind the resolved Management id into the derived key and the
      // fingerprinted body (like keyAction does): the demo slug is reusable
      // after a delete and availability revisions restart at 0, so a
      // slug+revision key would collide with the dead Angel's record and
      // silently replay it instead of touching the new Angel's gates.
      const body = { ...commandBody(command) as Record<string, unknown>, resolvedAngelId: angel.id };
      const mutation = {
        method: "POST",
        path: "/api/demo/action",
        idempotencyKey: await demoMutationKey(body, current.availability.revision),
        body,
      };
      await control.changeAvailability(angel.id, command.environment, change, mutation);
    }
    return this.view(control.exportState());
  }

  // Named-key CRUD for the demo/control UI. Resolves the demo SLUG to the
  // generated Management angel id (like every other demo action) so create/rotate/
  // revoke hit a real Angel instead of 404ing, and derives a DETERMINISTIC
  // idempotency key from the client-supplied token so a retried request replays
  // the committed response (recovering the one-time plaintext) rather than minting
  // a duplicate key. Returns the Management response verbatim (plaintext included
  // for create/rotate) — NOT a demo view — since the plaintext is shown once.
  private async keyAction(
    command: Extract<AccountRegistryCommand, { operation: "key_action" }>,
  ): Promise<unknown> {
    const control = await this.management();
    const angel = control.getAngelBySlug(this.env.ACCOUNT_ID, command.angelId);
    // Bind the resolved angel + environment into BOTH the derived idempotency key
    // AND the mutation body (which feeds the replay fingerprint), so the same
    // token+payload replayed against a different angel/environment is NOT treated
    // as a replay of the first context's sealed response (finding #2).
    const body = command.action === "create_key"
      ? { action: command.action, angelId: angel.id, environment: command.environment, name: command.name }
      : { action: command.action, angelId: angel.id, environment: command.environment, keyId: command.keyId };
    const mutation = {
      method: "POST",
      path: "/api/demo/action",
      idempotencyKey: `demo_${await sha256Hex(canonicalJson({ token: command.idempotencyToken, body }))}`,
      body,
    };
    if (command.action === "create_key") {
      return control.createKey(angel.id, command.environment, { name: command.name! }, mutation);
    }
    if (command.action === "rotate_key") {
      return control.rotateKey(angel.id, command.environment, { keyId: command.keyId! }, mutation);
    }
    return control.revokeKey(angel.id, command.environment, { keyId: command.keyId! }, mutation);
  }

  private async promote(
    control: ManagementControl,
    angelId: string,
    command: Extract<AccountRegistryCommand, { operation: "action" }>,
  ): Promise<void> {
    const state = control.exportState();
    const angel = state.angels.find((candidate) => candidate.id === angelId)!;
    const stagingId = angel.environments.staging.activeDeploymentId;
    const productionId = angel.environments.production.activeDeploymentId;
    const staging = state.deployments.find((candidate) => candidate.id === stagingId);
    const production = state.deployments.find((candidate) => candidate.id === productionId);
    if (
      staging !== undefined
      && production !== undefined
      && staging.versionId === production.versionId
      && staging.digest === production.digest
      && command.stagedDeploymentId === staging.id
      && command.expectedDigest === staging.digest
      && canonicalJson(command.bindings) === canonicalJson(production.bindings)
      && angel.environments.production.pendingDeploymentId === null
    ) return;

    const view = await this.view(state);
    const ready = view.angels.find((candidate) => candidate.id === command.angelId)?.readyForProduction;
    if (ready === null || ready === undefined) {
      throw new RegistryError(409, "no staged Version has compatible production bindings");
    }
    if (
      command.stagedDeploymentId !== ready.stagedDeploymentId
      || command.expectedDigest !== ready.expectedDigest
      || canonicalJson(command.bindings) !== canonicalJson(ready.bindings)
    ) {
      throw new RegistryError(409, "promotion no longer matches the exact ready Version and production bindings");
    }
    const input = {
      stagedDeploymentId: ready.stagedDeploymentId,
      expectedDigest: ready.expectedDigest,
      bindings: ready.bindings,
    };
    // Same identity binding as availability actions: the resolved Management
    // id keeps a re-created slug's promotions from colliding with a dead
    // Angel's records.
    const body = { ...commandBody(command) as Record<string, unknown>, resolvedAngelId: angelId };
    await control.promoteProduction(angelId, input, {
      method: "POST",
      path: "/api/demo/action",
      idempotencyKey: await demoMutationKey(body, production?.id ?? "none"),
      body,
    });
  }

  private async view(state?: ManagementState): Promise<DemoView> {
    let managementState = state;
    if (managementState === undefined) {
      if (await this.ctx.storage.get<ManagementState>("management") === undefined) {
        throw new RegistryError(409, "demo Account is not initialized");
      }
      // Route the raw read through ManagementControl so its restore repair for
      // pre-fix dangling availability (issue #1) applies to this projection
      // like every other read path.
      managementState = (await this.management()).exportState();
    }
    return buildDemoView(
      managementState,
      (_angelId, slug) => this.managementFleet(slug),
      { gatewayBaseUrl: this.env.GATEWAY_BASE_URL },
    );
  }

  private async providerState(): Promise<ProviderManagementState> {
    const state = await this.ctx.storage.get<ProviderManagementState>("providers");
    if (state === undefined) return emptyProviderManagementState();
    if (state.schemaVersion !== 1 || !Array.isArray(state.providerApps) || !Array.isArray(state.connections) || typeof state.oauthStates !== "object") {
      throw new Error("provider state is malformed");
    }
    return structuredClone(state);
  }

  private async reconcileProviderApps(providerApps: ProviderAppSummary[]): Promise<void> {
    const state = await this.providerState();
    state.providerApps = structuredClone(providerApps);
    await this.ctx.storage.put("providers", state);
  }

  private async reconcileProviderConnections(connections: ConnectionSummary[]): Promise<void> {
    const state = await this.providerState();
    state.connections = structuredClone(connections);
    await this.ctx.storage.put("providers", state);
    const control = await this.management();
    const current = control.exportState();
    const referenced = new Set(
      current.deployments.flatMap((deployment) => Object.values(deployment.bindings).flat()),
    );
    const nextConnections = reconcileManagementConnections(this.env.ACCOUNT_ID, current.connections, connections, referenced);
    control.reconcileConnections(nextConnections);
    await this.ctx.storage.put("management", control.exportState());
  }

  private async reconcileFromBroker(): Promise<void> {
    const response = await this.env.BROKER.fetch(new Request(
      `https://broker.internal/internal/connections?accountId=${encodeURIComponent(this.env.ACCOUNT_ID)}`,
      { headers: { authorization: `Bearer ${this.env.CONTROL_BROKER_TOKEN}` } },
    ));
    if (!response.ok) throw new Error("Broker Connection reconciliation failed");
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("Broker returned invalid Connection reconciliation JSON");
    }
    if (!Array.isArray(value) || !value.every(isConnectionSummary)) {
      throw new Error("Broker returned an invalid Connection reconciliation list");
    }
    await this.reconcileProviderConnections(value);
  }

  private assertProviderAccount(accountId: string, summaryAccountId: string): void {
    if (accountId !== summaryAccountId || accountId !== this.env.ACCOUNT_ID) {
      throw new RegistryError(404, "not found");
    }
  }

  private async management(): Promise<ManagementControl> {
    const existing = await this.ctx.storage.get<ManagementState>("management");
    const state = existing ?? createManagementState({
      account: { ...DEMO_ACCOUNT, id: this.env.ACCOUNT_ID },
      connections: managementConnectionsFromProviderSummaries(
        this.env.ACCOUNT_ID,
        (await this.providerState()).connections,
      ),
    });
    return ManagementControl.restore(state, {
      replayVault: new AesGcmResponseReplayVault(
        (this.env as ControlEnv & { CONTROL_RESPONSE_KEK: string }).CONTROL_RESPONSE_KEK,
      ),
      fleetFor: (_angelId, angelSlug) => this.managementFleet(angelSlug),
      randomId,
      checkpoint: {
        persist: async (nextState) => {
          await this.ctx.storage.put("management", nextState);
        },
      },
    });
  }

  private managementFleet(angelId: string): ServiceGateFleet {
    return new ServiceGateFleet({
      accountId: this.env.ACCOUNT_ID,
      angelId,
      gatewayControlToken: this.env.CONTROL_GATEWAY_TOKEN,
      brokerControlToken: this.env.CONTROL_BROKER_TOKEN,
      gateway: this.env.GATEWAY,
      broker: this.env.BROKER,
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function managementConnections(accountId: string): ManagementConnection[] {
  return [
    {
      id: "con_personal_google",
      accountId,
      nickname: "personal-google",
      identityLabel: "Personal Google",
      credential: "google_oauth",
      providers: ["gmail", "docs"],
      health: "healthy",
    },
    {
      id: "con_work_google",
      accountId,
      nickname: "work-google",
      identityLabel: "Work Google",
      credential: "google_oauth",
      providers: ["gmail"],
      health: "healthy",
    },
  ];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return `${prefix}_${value}`;
}

function availabilityAlready(
  availability: ReturnType<ManagementControl["getEnvironment"]>["availability"],
  change:
    | { kind: "all"; enabled: boolean }
    | { kind: "tool"; tool: string; enabled: boolean }
    | { kind: "tool_connection"; tool: string; connectionId: string; enabled: boolean },
): boolean {
  if (change.kind === "all") {
    return availability.defaultEnabled === change.enabled
      && Object.keys(availability.toolOverrides).length === 0
      && Object.keys(availability.connectionOverrides).length === 0;
  }
  const toolEnabled = availability.toolOverrides[change.tool] ?? availability.defaultEnabled;
  if (change.kind === "tool") {
    return toolEnabled === change.enabled
      && availability.connectionOverrides[change.tool] === undefined;
  }
  return (availability.connectionOverrides[change.tool]?.[change.connectionId] ?? toolEnabled)
    === change.enabled;
}

async function demoMutationKey(
  body: unknown,
  generation: string | number,
): Promise<string> {
  return `demo_${await sha256Hex(canonicalJson({ command: body, generation }))}`;
}

function commandBody(command: Extract<AccountRegistryCommand, { operation: "action" }>): unknown {
  const { operation: _operation, ...body } = command;
  return body;
}

class RegistryError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
