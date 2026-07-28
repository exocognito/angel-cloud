import type { GateFleet } from "./control";
import type { DeploymentEnvironment, HostedVersionContent } from "./domain";
import type {
  GateAvailability,
  GateAvailabilityCommand,
  GateInstallation,
  GateKind,
  GateToolBinding,
} from "./gate";
import { sha256Hex } from "@smcllns/angel-core";
import { canonicalJson, validateArtifactAdapters } from "@smcllns/angel-core";
import type { StoredManagementConnection } from "./management-internal";
import type {
  AgentKey,
  AgentKeyView,
  CreateKeyResponse,
  DeleteAngelRequest,
  DeleteAngelResponse,
  DeployStagingRequest,
  EnsureAngelResponse,
  ManagementAngel,
  ManagementAngelView,
  ManagementAvailabilityChange,
  ManagementAvailabilityView,
  ManagementConnection,
  ManagementDeployment,
  ManagementDeploymentView,
  ManagementEnvironment,
  ManagementEnvironmentView,
  ManagementState,
  MutationIdentity,
  PromoteProductionRequest,
  PublishedAngelVersion,
  PublishVersionRequest,
  RevokeKeyResponse,
  RotateKeyResponse,
} from "./management-contract";

export * from "./management-contract";

export interface ResponseReplayVault {
  seal(plaintext: string): Promise<string>;
  open(ciphertext: string): Promise<string>;
}

export class AesGcmResponseReplayVault implements ResponseReplayVault {
  private readonly keyMaterial: string;

  constructor(keyMaterial: string) {
    if (keyMaterial.trim() === "") throw new Error("response replay key must be non-empty");
    this.keyMaterial = keyMaterial;
  }

  async seal(plaintext: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await this.key(),
      new TextEncoder().encode(plaintext),
    );
    return `v1.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
  }

  async open(payload: string): Promise<string> {
    const [version, encodedIv, encodedCiphertext, surplus] = payload.split(".");
    if (version !== "v1" || !encodedIv || !encodedCiphertext || surplus !== undefined) {
      throw new Error("invalid encrypted replay payload");
    }
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unbase64(encodedIv) },
      await this.key(),
      unbase64(encodedCiphertext),
    );
    return new TextDecoder().decode(plaintext);
  }

  private async key(): Promise<CryptoKey> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.keyMaterial));
    return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
}

export interface ManagementCheckpoint {
  persist(state: ManagementState): Promise<void>;
}

export interface ManagementDependencies {
  replayVault: ResponseReplayVault;
  fleetFor(angelId: string, angelSlug: string): GateFleet;
  randomId(prefix: string): string;
  checkpoint: ManagementCheckpoint;
  /**
   * Wall-clock source, returning an ISO-8601 UTC instant. Injectable so tests can
   * pin recorded timestamps; defaults to the real clock. Only ever called at the
   * moment an event actually happens — never to back-fill history.
   */
  now?: () => string;
}

export function createManagementState(input: {
  account: { id: string; name: string };
  connections: StoredManagementConnection[];
}): ManagementState {
  return {
    schemaVersion: 1,
    account: structuredClone(input.account),
    connections: structuredClone(input.connections),
    angels: [],
    versions: [],
    deployments: [],
    idempotency: {},
    timestamps: {},
  };
}

export class ManagementControl {
  private readonly state: ManagementState;

  private constructor(state: ManagementState, private readonly dependencies: ManagementDependencies) {
    if (state.schemaVersion !== 1) throw new Error("unsupported management state schema");
    this.state = structuredClone(state);
    this.state.timestamps ??= {};
    for (const angel of this.state.angels) {
      for (const environment of ["staging", "production"] as const) {
        const environmentState = angel.environments[environment];
        environmentState.availability ??= defaultAvailability();
        environmentState.pendingAvailability ??= null;
        // Migrate a legacy single key into the named-keys model. The migrated key
        // preserves the exact hash/fingerprint (so gate auth never breaks) and is
        // named "Default key". Its id is derived deterministically from the hash so
        // repeated loads yield a stable id; no createdAt is fabricated for it.
        if (environmentState.keys === undefined) {
          environmentState.keys = [{
            id: `key_${environmentState.keyHash.slice(0, 24)}`,
            name: "Default key",
            fingerprint: environmentState.keyFingerprint,
            hash: environmentState.keyHash,
            status: "active",
          }];
        }
      }
    }
  }

  private now(): string {
    return (this.dependencies.now ?? (() => new Date().toISOString()))();
  }

  static restore(state: ManagementState, dependencies: ManagementDependencies): ManagementControl {
    return new ManagementControl(state, dependencies);
  }

  exportState(): ManagementState {
    return structuredClone(this.state);
  }

  listAngels(): ManagementAngelView[] {
    return this.state.angels.map((angel) => this.angelView(angel));
  }

  listConnections(accountId: string): ManagementConnection[] {
    // grantedScopes is hosted state, not part of the target-neutral
    // management contract — the core CLI parses this response with exact
    // keys, so the wire shape stays the contract's.
    this.assertAccount(accountId);
    return this.state.connections.map(({ grantedScopes: _grantedScopes, ...connection }) => structuredClone(connection));
  }

  reconcileConnections(connections: readonly ManagementConnection[]): void {
    if (connections.some((connection) => connection.accountId !== this.state.account.id)) {
      throw new ManagementError(404, "Connection not found");
    }
    this.state.connections = structuredClone([...connections]);
  }

  getAngel(angelId: string): ManagementAngelView {
    return this.angelView(this.angel(angelId));
  }

  getAngelBySlug(accountId: string, slug: string): ManagementAngelView {
    this.assertAccount(accountId);
    const angel = this.state.angels.find((candidate) => candidate.slug === slug);
    if (angel === undefined) throw new ManagementError(404, "not found");
    return this.angelView(angel);
  }

  getVersion(angelId: string, versionId: string): PublishedAngelVersion {
    this.angel(angelId);
    return structuredClone(this.version(angelId, versionId));
  }

  getEnvironment(angelId: string, environment: DeploymentEnvironment): ManagementEnvironmentView {
    const state = this.angel(angelId).environments[environment];
    // NOTE: named `keys` are deliberately NOT surfaced here. This response is the
    // angel-core `/v1` ManagementEnvironmentView, which the pinned @smcllns/angel-core
    // CLI client validates with an EXACT schema — an extra `keys` field makes
    // that client reject the response. Keys are exposed through the repo-local
    // demo-view and the create/rotate/revoke command responses instead.
    return {
      environment,
      keyFingerprint: state.keyFingerprint,
      activeDeployment: this.deploymentSummary(angelId, state.activeDeploymentId),
      pendingDeployment: this.deploymentSummary(angelId, state.pendingDeploymentId),
      repair: state.repair,
      availability: this.availabilityView(angelId, environment, state.availability),
      pendingAvailability: structuredClone(state.pendingAvailability?.change ?? null),
    };
  }

  /** Read the named keys for an environment (repo-local; not part of the /v1 view). */
  listKeys(angelId: string, environment: DeploymentEnvironment): AgentKeyView[] {
    return environmentKeyViews(this.angel(angelId).environments[environment]);
  }

  async ensureAngel(
    accountId: string,
    slug: string,
    mutation: MutationIdentity,
  ): Promise<EnsureAngelResponse> {
    this.assertAccount(accountId);
    requiredSlug(slug);
    return this.mutate(mutation, true, async () => {
      const existing = this.state.angels.find((candidate) => candidate.slug === slug);
      if (existing) return { angel: this.angelView(existing) };

      const staging = await this.environmentKey("staging");
      const production = await this.environmentKey("production");
      const angel: ManagementAngel = {
        id: this.dependencies.randomId("ang"),
        accountId,
        slug,
        environments: {
          staging: staging.environment,
          production: production.environment,
        },
      };
      this.state.angels.push(angel);
      return {
        angel: this.angelView(angel),
        keys: { staging: staging.plaintext, production: production.plaintext },
      };
    });
  }

  /**
   * Hard-delete an Angel: nothing survives, the coordinate 404s afterwards, and
   * the slug is immediately reusable. Teardown follows ADR 0003's disable path —
   * keys revoked first (nothing authenticates mid-teardown), Broker closed
   * before Gateway, partial state visible and repairable by calling delete
   * again (every step is idempotent).
   */
  async deleteAngel(
    accountId: string,
    slug: string,
    input: DeleteAngelRequest,
    mutation: MutationIdentity,
  ): Promise<DeleteAngelResponse> {
    this.assertAccount(accountId);
    requiredSlug(slug);
    return this.mutate(mutation, false, async () => {
      const angel = this.state.angels.find((candidate) => candidate.slug === slug);
      if (angel === undefined) throw new ManagementError(404, "not found");
      if (input.confirm !== undefined && input.confirm !== slug) {
        throw new ManagementError(400, "confirm must equal the Angel slug");
      }
      // A production deployment that is pending repair may already be serving
      // at both gates (only the final persist was lost), so pending demands
      // the confirmation exactly like active.
      const production = angel.environments.production;
      if (
        (production.activeDeploymentId !== null || production.pendingDeploymentId !== null)
        && input.confirm !== slug
      ) {
        throw new ManagementError(
          409,
          `deleting an Angel with a live production deployment requires confirm: "${slug}"`,
        );
      }
      const fleet = this.dependencies.fleetFor(angel.id, angel.slug);
      const environments = ["staging", "production"] as const;
      // 1. Revoke every key — recorded and persisted BEFORE touching any gate
      //    (persist-then-act, like deploy's repair marker), then pushed: the
      //    Gateway holds the runtime keys, and an empty reconcile locks it, so
      //    no key authenticates from here on.
      for (const environment of environments) {
        for (const key of keysOf(angel.environments[environment])) {
          if (key.status === "active") {
            key.status = "revoked";
            key.revokedAt = this.now();
          }
        }
      }
      await this.dependencies.checkpoint.persist(this.exportState());
      for (const environment of environments) await fleet.reconcileKeys("gateway", environment, []);
      // 2. Broker closes first, 3. Gateway second.
      for (const environment of environments) await fleet.reset("broker", environment);
      for (const environment of environments) await fleet.reset("gateway", environment);
      // 4. Drop the Angel with its Deployments and Versions. Connections are
      //    referenced only from Deployment bindings, so dropping the
      //    Deployments releases them.
      const dropped = new Set([
        ...this.state.versions.filter((version) => version.angelId === angel.id).map((version) => version.id),
        ...this.state.deployments
          .filter((deployment) => deployment.angelId === angel.id)
          .map((deployment) => deployment.id),
      ]);
      this.state.angels = this.state.angels.filter((candidate) => candidate.id !== angel.id);
      this.state.versions = this.state.versions.filter((version) => version.angelId !== angel.id);
      this.state.deployments = this.state.deployments.filter((deployment) => deployment.angelId !== angel.id);
      for (const id of dropped) delete this.state.timestamps?.[id];
      // 5. Purge the dead Angel's idempotency records so the coordinate is
      //    genuinely reusable: the pinned CLI derives its Idempotency-Key from
      //    method+path+body, and a surviving ensure record would replay the
      //    dead Angel's sealed response (stale id, spent keys) instead of
      //    creating a fresh one. The delete's own record is stored after this
      //    runs, so its replay remains available.
      const coordinatePath = `/v1/accounts/${accountId}/angels/${slug}`;
      for (const [key, record] of Object.entries(this.state.idempotency)) {
        if (record.path === undefined) continue;
        if (record.path === coordinatePath || record.path.startsWith(`/v1/angels/${angel.id}/`)) {
          delete this.state.idempotency[key];
        }
      }
      return { id: angel.id, slug: angel.slug, deleted: true as const };
    });
  }

  async publishVersion(
    angelId: string,
    input: PublishVersionRequest,
    mutation: MutationIdentity,
  ): Promise<PublishedAngelVersion> {
    const angel = this.angel(angelId);
    return this.mutate(mutation, false, async () => {
      await assertArtifact(input.artifact, input.expectedDigest, angel.slug);
      const existing = this.state.versions.find(
        (candidate) => candidate.angelId === angelId && candidate.digest === input.artifact.digest,
      );
      if (existing) return structuredClone(existing);
      const version: PublishedAngelVersion = {
        id: this.dependencies.randomId("ver"),
        angelId,
        number: this.state.versions.filter((candidate) => candidate.angelId === angelId).length + 1,
        digest: input.artifact.digest,
        artifact: structuredClone(input.artifact),
      };
      this.state.versions.push(version);
      this.stamp(version.id);
      return structuredClone(version);
    });
  }

  async deployStaging(
    angelId: string,
    input: DeployStagingRequest,
    mutation: MutationIdentity,
  ): Promise<ManagementDeploymentView> {
    this.angel(angelId);
    return this.mutate(mutation, false, async () => {
      const version = this.version(angelId, input.versionId);
      if (version.digest !== input.expectedDigest) {
        throw new ManagementError(409, "expected digest does not match Version");
      }
      return this.deploy(angelId, "staging", version, input.bindings);
    });
  }

  async promoteProduction(
    angelId: string,
    input: PromoteProductionRequest,
    mutation: MutationIdentity,
  ): Promise<ManagementDeploymentView> {
    const angel = this.angel(angelId);
    return this.mutate(mutation, false, async () => {
      const stagedId = angel.environments.staging.activeDeploymentId;
      if (stagedId === null || stagedId !== input.stagedDeploymentId) {
        throw new ManagementError(409, "promotion requires the active staged deployment");
      }
      const staged = this.deployment(angelId, stagedId);
      if (staged.digest !== input.expectedDigest) {
        throw new ManagementError(409, "expected digest does not match staged deployment");
      }
      return this.deploy(
        angelId,
        "production",
        this.version(angelId, staged.versionId),
        input.bindings,
      );
    });
  }

  async changeAvailability(
    angelId: string,
    environment: DeploymentEnvironment,
    input: ManagementAvailabilityChange,
    mutation: MutationIdentity,
  ): Promise<ManagementAvailabilityView> {
    const angel = this.angel(angelId);
    return this.mutate(mutation, false, async () => {
      const environmentState = angel.environments[environment];
      if (environmentState.activeDeploymentId === null) {
        throw new ManagementError(409, "availability requires an active deployment");
      }
      if (environmentState.pendingDeploymentId !== null) {
        throw new ManagementError(409, "repair the pending deployment before changing availability");
      }
      const deployment = this.deployment(angelId, environmentState.activeDeploymentId);
      const command = availabilityCommand(input, deployment, environmentState.availability);
      const target = applyAvailability(environmentState.availability, command);
      if (environmentState.pendingAvailability === null) {
        environmentState.pendingAvailability = { change: structuredClone(input), command, target };
        environmentState.repair = "broker";
        await this.dependencies.checkpoint.persist(this.exportState());
      } else if (canonicalJson(environmentState.pendingAvailability.change) !== canonicalJson(input)) {
        throw new ManagementError(409, "repair the pending availability change first");
      }
      const pending = environmentState.pendingAvailability;
      const fleet = this.dependencies.fleetFor(angelId, angel.slug);
      await reconcileAvailabilityGate(fleet, "broker", environment, pending.command, pending.target);
      environmentState.repair = "gateway";
      await this.dependencies.checkpoint.persist(this.exportState());
      await reconcileAvailabilityGate(fleet, "gateway", environment, pending.command, pending.target);
      environmentState.availability = structuredClone(pending.target);
      environmentState.pendingAvailability = null;
      environmentState.repair = null;
      environmentState.availabilityChangedAt = this.now();
      await this.dependencies.checkpoint.persist(this.exportState());
      return this.availabilityView(angelId, environment, environmentState.availability);
    });
  }

  private async deploy(
    angelId: string,
    environment: DeploymentEnvironment,
    version: PublishedAngelVersion,
    bindings: Readonly<Record<string, readonly string[]>>,
  ): Promise<ManagementDeploymentView> {
    const angel = this.angel(angelId);
    const environmentState = angel.environments[environment];
    if (environmentState.pendingAvailability !== null) {
      throw new ManagementError(409, `repair the pending ${environment} availability change first`);
    }
    const normalizedBindings = this.validateBindings(version, bindings);
    let deployment = environmentState.pendingDeploymentId === null
      ? undefined
      : this.deployment(angelId, environmentState.pendingDeploymentId);
    if (deployment === undefined) {
      deployment = {
        id: this.dependencies.randomId("dep"),
        angelId,
        environment,
        versionId: version.id,
        version: version.number,
        digest: version.digest,
        bindings: normalizedBindings,
        runtimeBindings: this.runtimeBindings(version, normalizedBindings),
      };
      this.state.deployments.push(deployment);
      environmentState.pendingDeploymentId = deployment.id;
      environmentState.repair = "broker";
      await this.dependencies.checkpoint.persist(this.exportState());
    } else if (
      deployment.environment !== environment
      || deployment.versionId !== version.id
      || deployment.digest !== version.digest
      || canonicalJson(deployment.bindings) !== canonicalJson(normalizedBindings)
    ) {
      throw new ManagementError(409, `repair the pending ${environment} deployment first`);
    }

    const fleet = this.dependencies.fleetFor(angelId, angel.slug);
    await this.reconcileGate(fleet, "broker", angel, deployment);
    environmentState.repair = "gateway";
    await this.dependencies.checkpoint.persist(this.exportState());
    await this.reconcileGate(fleet, "gateway", angel, deployment);
    // Stamp the recorded time at CONVERGENCE, not at creation: this is the moment
    // the deployment actually became effective. A failed attempt that is later
    // repaired records the repair-completion time, never the failed attempt's. The
    // deployment surfaces in demo-view only once active, so this is the only time
    // the projected event genuinely happened. Re-stamped on each convergence so a
    // repair overwrites any earlier (never-effective) value.
    this.stamp(deployment.id);
    environmentState.activeDeploymentId = deployment.id;
    environmentState.pendingDeploymentId = null;
    environmentState.repair = null;
    await this.dependencies.checkpoint.persist(this.exportState());
    return deploymentView(deployment);
  }

  private async reconcileGate(
    fleet: GateFleet,
    gate: GateKind,
    angel: ManagementAngel,
    deployment: ManagementDeployment,
  ): Promise<void> {
    const snapshot = await fleet.snapshot(gate, deployment.environment);
    if (installationMatches(snapshot.installation, deployment)) return;
    const installed = await fleet.install(gate, {
      accountId: angel.accountId,
      angelId: angel.slug,
      environment: deployment.environment,
      deploymentId: deployment.id,
      version: deployment.version,
      artifact: this.version(angel.id, deployment.versionId).artifact,
      bindings: deployment.runtimeBindings,
      ...(gate === "gateway"
        ? { gatewayKeyHashes: activeKeyHashes(angel.environments[deployment.environment]) }
        : {}),
    });
    if (!installationMatches(installed, deployment)) {
      throw new Error(`${gate} did not install the recorded deployment target`);
    }
  }

  private validateBindings(
    version: PublishedAngelVersion,
    bindings: Readonly<Record<string, readonly string[]>>,
  ): Record<string, string[]> {
    // A Version published before the v2 migration has no sealed requests to
    // execute — name the problem instead of crashing on absent fields.
    if (version.artifact.format !== "angel.version.v2") {
      throw new ManagementError(
        400,
        `unsupported artifact format: ${String(version.artifact.format)} — republish from unchanged sources`,
      );
    }
    const requiredIds = version.artifact.bindingRequirements.map((requirement) => requirement.id).sort();
    const suppliedIds = Object.keys(bindings).sort();
    if (canonicalJson(requiredIds) !== canonicalJson(suppliedIds)) {
      throw new ManagementError(400, "bindings must exactly cover the Version requirements");
    }
    return Object.fromEntries(requiredIds.map((id) => {
      const requirement = version.artifact.bindingRequirements.find((candidate) => candidate.id === id)!;
      const ids = bindings[id];
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new ManagementError(400, `binding ${id} must contain at least one Connection ID`);
      }
      const unique = [...new Set(ids)];
      if (unique.length !== ids.length || unique.some((connectionId) => typeof connectionId !== "string")) {
        throw new ManagementError(400, `binding ${id} must contain unique Connection IDs`);
      }
      for (const connectionId of unique) {
        const connection = this.state.connections.find((candidate) => candidate.id === connectionId);
        if (connection === undefined) {
          throw new ManagementError(404, `Connection for binding ${id} not found`);
        }
        if (connection.health !== "healthy") {
          throw new ManagementError(409, `Connection for binding ${id} is not healthy`);
        }
        if (
          connection.accountId !== this.state.account.id
          || connection.credential !== requirement.credential
          || !connection.providers.includes(requirement.provider)
        ) {
          throw new ManagementError(404, `Connection for binding ${id} not found`);
        }
        // Granted scopes must cover the requirement's spec-derived consent —
        // a write Angel must fail here, not at Google after deployment.
        const granted = connection.grantedScopes ?? [];
        const missing = requirement.requiredScopes.filter((scope) => !granted.includes(scope));
        if (missing.length > 0) {
          throw new ManagementError(
            409,
            `Connection for binding ${id} is missing required scopes: ${missing.join(", ")}`,
          );
        }
      }
      return [id, unique] as const;
    }));
  }

  private runtimeBindings(
    version: PublishedAngelVersion,
    bindings: Record<string, string[]>,
  ): GateToolBinding[] {
    const refs = new Map<string, string>();
    const output: GateToolBinding[] = [];
    for (const requirement of version.artifact.bindingRequirements) {
      for (const connectionId of bindings[requirement.id]!) {
        const connection = this.state.connections.find((candidate) => candidate.id === connectionId)!;
        let connectionRef = refs.get(connectionId);
        if (connectionRef === undefined) {
          connectionRef = this.dependencies.randomId("arc");
          refs.set(connectionId, connectionRef);
        }
        for (const tool of requirement.tools) {
          output.push({
            tool,
            connectionRef,
            connectionId,
            provider: requirement.provider,
            identityLabel: connection.identityLabel,
          });
        }
      }
    }
    return output.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  }

  private async mutate<T>(
    mutation: MutationIdentity,
    encrypted: boolean,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = mutation.idempotencyKey.trim();
    if (key === "") throw new ManagementError(400, "Idempotency-Key must be non-empty");
    const fingerprint = await sha256Hex(canonicalJson({
      method: mutation.method.toUpperCase(),
      path: canonicalPath(mutation.path),
      body: mutation.body,
    }));
    const prior = this.state.idempotency[key];
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        throw new ManagementError(409, "Idempotency-Key was already used for different input");
      }
      const json = "ciphertext" in prior
        ? await this.dependencies.replayVault.open(prior.ciphertext)
        : prior.responseJson;
      return JSON.parse(json) as T;
    }

    const response = await action();
    const responseJson = JSON.stringify(response);
    const path = canonicalPath(mutation.path);
    this.state.idempotency[key] = encrypted
      ? { fingerprint, ciphertext: await this.dependencies.replayVault.seal(responseJson), path }
      : { fingerprint, responseJson, path };
    await this.dependencies.checkpoint.persist(this.exportState());
    return structuredClone(response);
  }

  private async environmentKey(environment: DeploymentEnvironment): Promise<{
    plaintext: string;
    environment: ManagementEnvironment;
  }> {
    const minted = await this.mintKey(environment, "Default key");
    return {
      plaintext: minted.plaintext,
      environment: {
        activeDeploymentId: null,
        pendingDeploymentId: null,
        keyHash: minted.key.hash,
        keyFingerprint: minted.key.fingerprint,
        keys: [minted.key],
        repair: null,
        availability: defaultAvailability(),
        pendingAvailability: null,
      },
    };
  }

  /**
   * Mint a fresh named key: server-generated secret, hashed for storage. The
   * plaintext is returned to the caller exactly once and is NEVER persisted.
   */
  private async mintKey(
    environment: DeploymentEnvironment,
    name: string,
  ): Promise<{ plaintext: string; key: AgentKey }> {
    const plaintext = this.dependencies.randomId(`ak_${environment}`);
    const hash = await sha256Hex(plaintext);
    return {
      plaintext,
      key: {
        id: this.dependencies.randomId("key"),
        name,
        fingerprint: hash.slice(0, 12),
        hash,
        status: "active",
        createdAt: this.now(),
      },
    };
  }

  /** Record an ISO-8601 UTC time for an event this backend just performed. */
  private stamp(id: string): void {
    (this.state.timestamps ??= {})[id] = this.now();
  }

  async createKey(
    angelId: string,
    environment: DeploymentEnvironment,
    input: { name: string },
    mutation: MutationIdentity,
  ): Promise<CreateKeyResponse> {
    const angel = this.angel(angelId);
    const name = requiredKeyName(input.name);
    return this.mutate(mutation, true, async () => {
      const environmentState = angel.environments[environment];
      const minted = await this.mintKey(environment, name);
      keysOf(environmentState).push(minted.key);
      await this.reconcileKeys(angel, environment);
      return { key: keyView(minted.key), plaintext: minted.plaintext };
    });
  }

  async rotateKey(
    angelId: string,
    environment: DeploymentEnvironment,
    input: { keyId: string },
    mutation: MutationIdentity,
  ): Promise<RotateKeyResponse> {
    const angel = this.angel(angelId);
    return this.mutate(mutation, true, async () => {
      const environmentState = angel.environments[environment];
      const keys = keysOf(environmentState);
      const previous = keys.find((candidate) => candidate.id === input.keyId);
      if (previous === undefined) throw new ManagementError(404, "not found");
      if (previous.status === "revoked") {
        throw new ManagementError(409, "a revoked key cannot be rotated");
      }
      const minted = await this.mintKey(environment, previous.name);
      // Atomic replacement: the old key is revoked and the replacement activated in
      // the same recorded moment, then pushed to the gate together.
      previous.status = "revoked";
      previous.revokedAt = this.now();
      keys.push(minted.key);
      this.syncLegacyKey(environmentState);
      await this.reconcileKeys(angel, environment);
      return { key: keyView(minted.key), revokedKeyId: previous.id, plaintext: minted.plaintext };
    });
  }

  async revokeKey(
    angelId: string,
    environment: DeploymentEnvironment,
    input: { keyId: string },
    mutation: MutationIdentity,
  ): Promise<RevokeKeyResponse> {
    const angel = this.angel(angelId);
    return this.mutate(mutation, false, async () => {
      const environmentState = angel.environments[environment];
      const keys = keysOf(environmentState);
      const target = keys.find((candidate) => candidate.id === input.keyId);
      if (target === undefined) throw new ManagementError(404, "not found");
      // Fail loud on a FRESH revoke of an already-revoked key. (An idempotent replay
      // of the ORIGINAL revoke never reaches here — mutate() returns the cached
      // success first — so replay stays 200 while a new revoke is a hard error.)
      if (target.status === "revoked") {
        throw new ManagementError(409, "key is already revoked");
      }
      if (keys.filter((candidate) => candidate.status === "active").length <= 1) {
        throw new ManagementError(409, "the last active key cannot be revoked");
      }
      target.status = "revoked";
      target.revokedAt = this.now();
      this.syncLegacyKey(environmentState);
      await this.reconcileKeys(angel, environment);
      return { key: keyView(target) };
    });
  }

  /**
   * Keep the legacy single-key fields pointing at the first active key so gate
   * installs and views that still read them stay consistent through migration.
   */
  private syncLegacyKey(environmentState: ManagementEnvironment): void {
    const active = keysOf(environmentState).find((candidate) => candidate.status === "active");
    if (active !== undefined) {
      environmentState.keyHash = active.hash;
      environmentState.keyFingerprint = active.fingerprint;
    }
  }

  /**
   * Push the environment's current ACTIVE key hashes to its gateway gate so a new
   * key authenticates and a revoked key is rejected immediately — not only after
   * the next deploy. Broker gates hold no runtime keys.
   */
  private async reconcileKeys(
    angel: ManagementAngel,
    environment: DeploymentEnvironment,
  ): Promise<void> {
    const hashes = activeKeyHashes(angel.environments[environment]);
    if (hashes.length === 0) throw new Error("an environment must retain at least one active key");
    const fleet = this.dependencies.fleetFor(angel.id, angel.slug);
    await fleet.reconcileKeys("gateway", environment, hashes);
  }

  private assertAccount(accountId: string): void {
    if (accountId !== this.state.account.id) throw new ManagementError(404, "not found");
  }

  private angel(angelId: string): ManagementAngel {
    const angel = this.state.angels.find((candidate) => candidate.id === angelId);
    if (angel === undefined || angel.accountId !== this.state.account.id) {
      throw new ManagementError(404, "not found");
    }
    return angel;
  }

  private version(angelId: string, versionId: string): PublishedAngelVersion {
    const version = this.state.versions.find(
      (candidate) => candidate.id === versionId && candidate.angelId === angelId,
    );
    if (version === undefined) throw new ManagementError(404, "not found");
    return version;
  }

  private deployment(angelId: string, deploymentId: string): ManagementDeployment {
    const deployment = this.state.deployments.find(
      (candidate) => candidate.id === deploymentId && candidate.angelId === angelId,
    );
    if (deployment === undefined) throw new ManagementError(404, "not found");
    return deployment;
  }

  private deploymentSummary(angelId: string, deploymentId: string | null) {
    if (deploymentId === null) return null;
    const deployment = this.deployment(angelId, deploymentId);
    return {
      id: deployment.id,
      versionId: deployment.versionId,
      digest: deployment.digest,
      bindings: structuredClone(deployment.bindings),
    };
  }

  private angelView(angel: ManagementAngel): ManagementAngelView {
    return {
      id: angel.id,
      accountId: angel.accountId,
      slug: angel.slug,
      environments: {
        staging: this.getEnvironment(angel.id, "staging"),
        production: this.getEnvironment(angel.id, "production"),
      },
    };
  }

  private availabilityView(
    angelId: string,
    environment: DeploymentEnvironment,
    availability: GateAvailability,
  ): ManagementAvailabilityView {
    const angel = this.angel(angelId);
    const activeId = angel.environments[environment].activeDeploymentId;
    const refs = new Map<string, string>();
    for (const deployment of this.state.deployments) {
      if (deployment.id !== activeId) continue;
      for (const binding of deployment.runtimeBindings) refs.set(binding.connectionRef, binding.connectionId);
    }
    return {
      defaultEnabled: availability.defaultEnabled,
      toolOverrides: structuredClone(availability.overrides),
      connectionOverrides: Object.fromEntries(
        Object.entries(availability.connectionOverrides).map(([tool, overrides]) => [
          tool,
          Object.fromEntries(Object.entries(overrides).map(([ref, enabled]) => {
            const connectionId = refs.get(ref);
            if (connectionId === undefined) throw new Error("availability references an inactive Connection ref");
            return [connectionId, enabled];
          })),
        ]),
      ),
      revision: availability.revision,
    };
  }
}

export class ManagementError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function keysOf(environmentState: ManagementEnvironment): AgentKey[] {
  return (environmentState.keys ??= [{
    id: `key_${environmentState.keyHash.slice(0, 24)}`,
    name: "Default key",
    fingerprint: environmentState.keyFingerprint,
    hash: environmentState.keyHash,
    status: "active",
  }]);
}

function activeKeyHashes(environmentState: ManagementEnvironment): string[] {
  return keysOf(environmentState)
    .filter((key) => key.status === "active")
    .map((key) => key.hash);
}

function keyView(key: AgentKey): AgentKeyView {
  return {
    id: key.id,
    name: key.name,
    fingerprint: key.fingerprint,
    status: key.status,
    createdAt: key.createdAt ?? null,
    revokedAt: key.revokedAt ?? null,
  };
}

function environmentKeyViews(environmentState: ManagementEnvironment): AgentKeyView[] {
  return keysOf(environmentState).map(keyView);
}

function requiredKeyName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ManagementError(400, "key name must be a non-empty string");
  }
  return value;
}

async function assertArtifact(
  artifact: PublishVersionRequest["artifact"],
  expectedDigest: string,
  angelSlug: string,
): Promise<void> {
  if (artifact.name !== angelSlug) throw new ManagementError(400, "artifact name does not match Angel slug");
  const actualDigest = await sha256Hex(artifact.canonicalSource);
  if (artifact.digest !== actualDigest || expectedDigest !== actualDigest) {
    throw new ManagementError(400, "artifact digest mismatch");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact.canonicalSource);
  } catch {
    throw new ManagementError(400, "artifact canonical source must be valid JSON");
  }
  const content: HostedVersionContent = {
    format: artifact.format,
    name: artifact.name,
    charter: artifact.charter,
    children: artifact.children,
    providers: artifact.providers,
    bindingRequirements: artifact.bindingRequirements,
    tools: artifact.tools,
  };
  if (canonicalJson(parsed) !== canonicalJson(content)) {
    throw new ManagementError(400, "artifact content does not match canonical source");
  }
  // ADR 0005's Control piece: sealed requests, provider pins, and consent
  // sets must equal what the reviewed registry derives — an operation
  // without a reviewed template cannot publish.
  // The compiler never emits a tool-less artifact; a self-consistent empty
  // one must not publish as a no-op Version.
  if (artifact.tools.length === 0) {
    throw new ManagementError(400, "artifact must contain at least one tool");
  }
  try {
    validateArtifactAdapters(content);
  } catch (error) {
    throw new ManagementError(400, error instanceof Error ? error.message : "artifact failed adapter validation");
  }
  const requirementIds = artifact.bindingRequirements.map((requirement) => requirement.id);
  if (
    requirementIds.some((id) => typeof id !== "string" || id.trim() === "")
    || new Set(requirementIds).size !== requirementIds.length
  ) {
    throw new ManagementError(400, "artifact binding requirement IDs must be unique and non-empty");
  }
}

function installationMatches(
  installation: GateInstallation | null,
  deployment: ManagementDeployment,
): boolean {
  return installation !== null
    && installation.deploymentId === deployment.id
    && installation.version === deployment.version
    && installation.policyDigest === deployment.digest;
}

function deploymentView(deployment: ManagementDeployment): ManagementDeploymentView {
  const { runtimeBindings: _runtimeBindings, ...view } = deployment;
  return structuredClone(view);
}

function requiredSlug(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new ManagementError(400, "Angel slug must be lowercase letters, numbers, and hyphens");
  }
  return value;
}

function canonicalPath(value: string): string {
  if (!value.startsWith("/")) throw new ManagementError(400, "mutation path must be absolute");
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

function defaultAvailability(): GateAvailability {
  return { defaultEnabled: true, overrides: {}, connectionOverrides: {}, revision: 0 };
}

function availabilityCommand(
  input: ManagementAvailabilityChange,
  deployment: ManagementDeployment,
  current: GateAvailability,
): GateAvailabilityCommand {
  if (input.kind === "all") {
    return { ...input, expectedRevision: current.revision };
  }
  const tool = deployment.runtimeBindings.find(
    (binding) => binding.tool.toUpperCase() === input.tool.toUpperCase(),
  )?.tool;
  if (tool === undefined) throw new ManagementError(404, "not found");
  if (input.kind === "tool") {
    return { kind: "tool", tool, enabled: input.enabled, expectedRevision: current.revision };
  }
  const binding = deployment.runtimeBindings.find(
    (candidate) => candidate.tool === tool && candidate.connectionId === input.connectionId,
  );
  if (binding === undefined) throw new ManagementError(404, "not found");
  return {
    kind: "tool_connection",
    tool,
    connectionRef: binding.connectionRef,
    enabled: input.enabled,
    expectedRevision: current.revision,
  };
}

function applyAvailability(current: GateAvailability, command: GateAvailabilityCommand): GateAvailability {
  if (command.kind === "all") {
    return {
      defaultEnabled: command.enabled,
      overrides: {},
      connectionOverrides: {},
      revision: current.revision + 1,
    };
  }
  if (command.kind === "tool") {
    const overrides = { ...current.overrides };
    if (command.enabled === current.defaultEnabled) delete overrides[command.tool];
    else overrides[command.tool] = command.enabled;
    const connectionOverrides = structuredClone(current.connectionOverrides);
    delete connectionOverrides[command.tool];
    return { ...current, overrides, connectionOverrides, revision: current.revision + 1 };
  }
  const connectionOverrides = structuredClone(current.connectionOverrides);
  const overrides = connectionOverrides[command.tool] ?? {};
  const base = current.overrides[command.tool] ?? current.defaultEnabled;
  if (command.enabled === base) delete overrides[command.connectionRef];
  else overrides[command.connectionRef] = command.enabled;
  if (Object.keys(overrides).length === 0) delete connectionOverrides[command.tool];
  else connectionOverrides[command.tool] = overrides;
  return { ...current, connectionOverrides, revision: current.revision + 1 };
}

async function reconcileAvailabilityGate(
  fleet: GateFleet,
  gate: GateKind,
  environment: DeploymentEnvironment,
  command: GateAvailabilityCommand,
  target: GateAvailability,
): Promise<void> {
  const current = (await fleet.snapshot(gate, environment)).availability;
  if (canonicalJson(current) === canonicalJson(target)) return;
  if (current.revision !== command.expectedRevision) {
    throw new Error(`${gate} availability diverged from the recorded repair target`);
  }
  const changed = await fleet.change(gate, environment, command);
  if (canonicalJson(changed) !== canonicalJson(target)) {
    throw new Error(`${gate} did not apply the recorded availability target`);
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(value: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("invalid encrypted replay payload");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
