import type {
  CredentialKind,
  HostedVersionArtifact,
} from "./domain";
import type { HostedEnvironment } from "./environments";
import {
  PolicyGate,
  createPolicyGateState,
  gateReceiptIdentity,
  gateReceiptMismatch,
  type GateAvailability,
  type GateAvailabilityCommand,
  type GateInstallCommand,
  type GateInstallation,
  type GateEvaluation,
  type GateEvaluationInput,
  type GateKind,
  type GateReceipt,
  type GateToolBinding,
  type PolicyGateState,
} from "./gate";
import { sha256Hex } from "@smcllns/angel-core";

export interface GateFleet {
  reset(gate: GateKind, environment: HostedEnvironment): Promise<void>;
  install(gate: GateKind, command: GateInstallCommand): Promise<GateInstallation>;
  change(
    gate: GateKind,
    environment: HostedEnvironment,
    command: GateAvailabilityCommand,
  ): Promise<GateAvailability>;
  reconcileKeys(
    gate: GateKind,
    environment: HostedEnvironment,
    hashes: string[],
  ): Promise<string[]>;
  snapshot(gate: GateKind, environment: HostedEnvironment): Promise<PolicyGateState>;
  activity(gate: GateKind, environment: HostedEnvironment): Promise<GateReceipt[]>;
}

export interface MemoryGateFleetState {
  schemaVersion: 1;
  gates: Record<HostedEnvironment, Record<GateKind, PolicyGateState>>;
}

export interface MemoryGateFleetEvent {
  operation: "install" | "availability";
  gate: GateKind;
  environment: HostedEnvironment;
}

export class MemoryGateFleet implements GateFleet {
  private readonly gates: Record<HostedEnvironment, Record<GateKind, PolicyGate>>;
  private readonly events: MemoryGateFleetEvent[] = [];

  constructor(state: MemoryGateFleetState = emptyFleetState()) {
    if (state.schemaVersion !== 1) throw new Error("unsupported memory GateFleet state schema");
    this.gates = {
      preview: {
        gateway: new PolicyGate(state.gates.preview.gateway),
        broker: new PolicyGate(state.gates.preview.broker),
      },
      production: {
        gateway: new PolicyGate(state.gates.production.gateway),
        broker: new PolicyGate(state.gates.production.broker),
      },
    };
  }

  async reset(gate: GateKind, environment: HostedEnvironment): Promise<void> {
    assertEnvironment(environment);
    this.gates[environment][gate] = new PolicyGate(createPolicyGateState(gate));
  }

  async install(gate: GateKind, command: GateInstallCommand): Promise<GateInstallation> {
    assertEnvironment(command.environment);
    this.events.push({ operation: "install", gate, environment: command.environment });
    return this.gates[command.environment][gate].install(command);
  }

  async change(
    gate: GateKind,
    environment: HostedEnvironment,
    command: GateAvailabilityCommand,
  ): Promise<GateAvailability> {
    assertEnvironment(environment);
    this.events.push({ operation: "availability", gate, environment });
    return this.gates[environment][gate].changeAvailability(command);
  }

  async reconcileKeys(
    gate: GateKind,
    environment: HostedEnvironment,
    hashes: string[],
  ): Promise<string[]> {
    assertEnvironment(environment);
    return this.gates[environment][gate].reconcileGatewayKeys(hashes);
  }

  async snapshot(gate: GateKind, environment: HostedEnvironment): Promise<PolicyGateState> {
    assertEnvironment(environment);
    return this.gates[environment][gate].snapshot();
  }

  async activity(gate: GateKind, environment: HostedEnvironment): Promise<GateReceipt[]> {
    return (await this.snapshot(gate, environment)).receipts;
  }

  async evaluate(
    gate: GateKind,
    environment: HostedEnvironment,
    input: GateEvaluationInput,
  ): Promise<GateEvaluation> {
    assertEnvironment(environment);
    return this.gates[environment][gate].evaluate(input);
  }

  history(): MemoryGateFleetEvent[] {
    return structuredClone(this.events);
  }

  exportState(): MemoryGateFleetState {
    return {
      schemaVersion: 1,
      gates: {
        preview: {
          gateway: this.gates.preview.gateway.snapshot(),
          broker: this.gates.preview.broker.snapshot(),
        },
        production: {
          gateway: this.gates.production.gateway.snapshot(),
          broker: this.gates.production.broker.snapshot(),
        },
      },
    };
  }
}

export interface DemoAccountSummary {
  id: string;
  name: string;
}

export interface DemoAngelSummary {
  id: string;
  name: string;
}

export interface DemoConnection {
  id: string;
  accountId: string;
  credential: CredentialKind;
  label: string;
  apps: string[];
  health: "healthy" | "error";
}

export interface DemoBootstrapInput {
  account: DemoAccountSummary;
  angel: DemoAngelSummary;
  endpoint?: string;
  connections: DemoConnection[];
  fleet?: GateFleet;
}

interface DemoVersion {
  number: number;
  artifact: HostedVersionArtifact;
}

export interface DemoBinding {
  connectionId: string;
  identityLabel: string;
}

export interface DemoDeployment {
  id: string;
  environment: HostedEnvironment;
  version: number;
  digest: string;
  bindings: Record<string, DemoBinding>;
  runtimeBindings: GateToolBinding[];
}

interface DemoEnvironmentState {
  activeDeploymentId: string | null;
  pendingDeploymentId: string | null;
  keyHash: string;
  keyFingerprint: string;
  pendingAvailability: null | {
    change: DemoAvailabilityChange;
    target: GateAvailability;
  };
}

export interface DemoControlState {
  schemaVersion: 1;
  account: DemoAccountSummary;
  angel: DemoAngelSummary & { enabled: boolean };
  endpoint?: string;
  connections: DemoConnection[];
  versions: DemoVersion[];
  deployments: DemoDeployment[];
  environments: Record<HostedEnvironment, DemoEnvironmentState>;
}

export interface DemoControlCheckpoint {
  persist(state: DemoControlState): Promise<void>;
}

const noCheckpoint: DemoControlCheckpoint = {
  async persist() {},
};

export interface DemoKeys {
  preview: string;
  production: string;
}

export interface DemoPublishInput {
  artifact: HostedVersionArtifact;
  bindings: Record<string, DemoBinding>;
}

export interface DemoPromoteInput {
  stagedDeploymentId: string;
  expectedDigest: string;
}

export type DemoAvailabilityChange =
  | { kind: "all"; enabled: boolean }
  | { kind: "tool"; tool: string; enabled: boolean };

export interface DemoToolView {
  name: string;
  app: string;
  identity: string;
  group: string;
  available: boolean;
  guards: string[];
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
    | { action: "pause_tool" | "resume_tool"; tool: string };
  availability: GateAvailability;
  tools: DemoToolView[];
}

export interface DemoView {
  schema: "angelmcp.demo.v1";
  account: DemoAccountSummary;
  angel: DemoAngelSummary & {
    endpoints?: Record<HostedEnvironment, string>;
    enabled: boolean;
    connections: Array<{
      id: string;
      label: string;
      apps: string[];
      health: "healthy" | "error";
    }>;
    environments: Record<HostedEnvironment, DemoEnvironmentView>;
    versions: Array<{
      number: number;
      digest: string;
      label: string;
      status: "staged" | "live" | "history";
      tools: string[];
    }>;
  };
  readyForProduction: null | {
    stagedDeploymentId: string;
    expectedDigest: string;
    fromVersion: number | null;
    toVersion: number;
    diff: { added: string[]; removed: string[] };
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

export class DemoControl {
  private readonly state: DemoControlState;

  private constructor(
    state: DemoControlState,
    private readonly fleet: GateFleet,
    private readonly checkpoint: DemoControlCheckpoint,
  ) {
    if (state.schemaVersion !== 1) throw new Error("unsupported DemoControl state schema");
    this.state = structuredClone(state);
    for (const environment of environments()) {
      this.state.environments[environment].pendingDeploymentId ??= null;
      this.state.environments[environment].pendingAvailability ??= null;
    }
  }

  static async bootstrap(input: DemoBootstrapInput): Promise<{
    control: DemoControl;
    keys: DemoKeys;
  }> {
    const preview = await createKey("preview");
    const production = await createKey("production");
    const state: DemoControlState = {
      schemaVersion: 1,
      account: structuredClone(input.account),
      angel: { ...structuredClone(input.angel), enabled: true },
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      connections: structuredClone(input.connections),
      versions: [],
      deployments: [],
      environments: {
        preview: environmentState(preview),
        production: environmentState(production),
      },
    };
    return {
      control: new DemoControl(
        state,
        input.fleet ?? new MemoryGateFleet(),
        noCheckpoint,
      ),
      keys: { preview: preview.plaintext, production: production.plaintext },
    };
  }

  static restore(
    state: DemoControlState,
    fleet: GateFleet,
    checkpoint: DemoControlCheckpoint = noCheckpoint,
  ): DemoControl {
    return new DemoControl(state, fleet, checkpoint);
  }

  exportState(): DemoControlState {
    return structuredClone(this.state);
  }

  async publish(input: DemoPublishInput): Promise<DemoDeployment> {
    this.assertArtifact(input.artifact);
    this.assertBindings(input.artifact, input.bindings);
    const pendingId = this.state.environments.preview.pendingDeploymentId;
    const version = pendingId === null
      ? this.versionFor(input.artifact)
      : this.version(this.deployment(pendingId).version);
    if (
      version.artifact.digest !== input.artifact.digest
      || version.artifact.canonicalSource !== input.artifact.canonicalSource
    ) {
      throw new Error("retry the pending preview deployment before publishing another Version");
    }
    return this.deploy("preview", version, input.bindings);
  }

  async promote(input: DemoPromoteInput): Promise<DemoDeployment> {
    const activeId = this.state.environments.preview.activeDeploymentId;
    if (activeId === null || activeId !== input.stagedDeploymentId) {
      throw new Error("promotion requires the active staged deployment");
    }
    const staged = this.deployment(activeId);
    if (staged.digest !== input.expectedDigest) {
      throw new Error("promotion expected digest does not match staged deployment");
    }
    const version = this.version(staged.version);
    return this.deploy("production", version, staged.bindings);
  }

  private async deploy(
    environment: HostedEnvironment,
    version: DemoVersion,
    bindings: Record<string, DemoBinding>,
  ): Promise<DemoDeployment> {
    const environmentState = this.state.environments[environment];
    const deployment = environmentState.pendingDeploymentId === null
      ? this.newDeployment(environment, version, bindings)
      : this.deployment(environmentState.pendingDeploymentId);
    if (environmentState.pendingDeploymentId === null) {
      environmentState.pendingDeploymentId = deployment.id;
      await this.checkpoint.persist(this.exportState());
    }
    if (
      deployment.environment !== environment
      || deployment.version !== version.number
      || deployment.digest !== version.artifact.digest
      || !sameBindings(deployment.bindings, bindings)
    ) {
      throw new Error(`retry the pending ${environment} deployment before starting another`);
    }

    await this.reconcileDeploymentGate("broker", deployment, version.artifact);
    await this.reconcileDeploymentGate("gateway", deployment, version.artifact);
    const [broker, gateway] = await Promise.all([
      this.fleet.snapshot("broker", environment),
      this.fleet.snapshot("gateway", environment),
    ]);
    if (
      !installationMatchesDeployment(broker.installation, deployment, this.state)
      || !installationMatchesDeployment(gateway.installation, deployment, this.state)
    ) {
      throw new Error("deployment gates did not converge on the recorded target");
    }
    environmentState.activeDeploymentId = deployment.id;
    environmentState.pendingDeploymentId = null;
    return structuredClone(deployment);
  }

  private async reconcileDeploymentGate(
    gate: GateKind,
    deployment: DemoDeployment,
    artifact: HostedVersionArtifact,
  ): Promise<void> {
    const current = await this.fleet.snapshot(gate, deployment.environment);
    if (installationMatchesDeployment(current.installation, deployment, this.state)) return;
    const installed = await this.install(gate, deployment, artifact);
    if (!installationMatchesDeployment(installed, deployment, this.state)) {
      throw new Error(`${gate} did not install the recorded deployment target`);
    }
  }

  async changeAvailability(
    environment: HostedEnvironment,
    change: DemoAvailabilityChange,
  ): Promise<void> {
    assertEnvironment(environment);
    const environmentState = this.state.environments[environment];
    let pending = environmentState.pendingAvailability;
    if (pending !== null && !sameAvailabilityChange(pending.change, change)) {
      throw new Error("retry the pending availability change before starting another");
    }
    if (pending === null) {
      const [broker, gateway] = await Promise.all([
        this.fleet.snapshot("broker", environment),
        this.fleet.snapshot("gateway", environment),
      ]);
      if (!sameAvailability(broker.availability, gateway.availability)) {
        throw new Error("availability gates are not aligned and no repair target is recorded");
      }
      pending = {
        change: structuredClone(change),
        target: deriveAvailabilityTarget(gateway, change),
      };
      environmentState.pendingAvailability = pending;
      await this.checkpoint.persist(this.exportState());
    }

    await this.reconcileAvailabilityGate("broker", environment, pending);
    await this.reconcileAvailabilityGate("gateway", environment, pending);
    const [broker, gateway] = await Promise.all([
      this.fleet.snapshot("broker", environment),
      this.fleet.snapshot("gateway", environment),
    ]);
    if (!sameAvailability(broker.availability, pending.target)
      || !sameAvailability(gateway.availability, pending.target)) {
      throw new Error("availability gates did not converge on the recorded target");
    }
    environmentState.pendingAvailability = null;
  }

  private async reconcileAvailabilityGate(
    gate: GateKind,
    environment: HostedEnvironment,
    pending: NonNullable<DemoEnvironmentState["pendingAvailability"]>,
  ): Promise<void> {
    const current = (await this.fleet.snapshot(gate, environment)).availability;
    if (sameAvailability(current, pending.target)) return;
    if (current.revision !== pending.target.revision - 1) {
      throw new Error(`${gate} availability cannot advance to recorded revision ${pending.target.revision}`);
    }
    const changed = await this.fleet.change(gate, environment, {
      ...pending.change,
      expectedRevision: current.revision,
    });
    if (!sameAvailability(changed, pending.target)) {
      throw new Error(`${gate} availability did not match the recorded target`);
    }
  }

  async view(): Promise<DemoView> {
    const [preview, production, activity] = await Promise.all([
      this.environmentView("preview"),
      this.environmentView("production"),
      this.activityView(),
    ]);
    return {
      schema: "angelmcp.demo.v1",
      account: structuredClone(this.state.account),
      angel: {
        ...structuredClone(this.state.angel),
        ...(this.state.endpoint === undefined ? {} : {
          endpoints: {
            preview: environmentEndpoint(this.state.endpoint, "preview"),
            production: environmentEndpoint(this.state.endpoint, "production"),
          },
        }),
        connections: this.state.connections.map(({ id, label, apps, health }) => ({
          id,
          label,
          apps: [...apps],
          health,
        })),
        environments: { preview, production },
        versions: this.versionViews(preview, production),
      },
      readyForProduction: this.readyForProduction(preview, production),
      activity,
    };
  }

  private assertArtifact(artifact: HostedVersionArtifact): void {
    if (artifact.name !== this.state.angel.id) {
      throw new Error("artifact identity does not match Angel");
    }
  }

  private assertBindings(
    artifact: HostedVersionArtifact,
    bindings: Record<string, DemoBinding>,
  ): void {
    const required = artifact.bindingRequirements.map((requirement) => requirement.id).sort();
    const supplied = Object.keys(bindings).sort();
    if (JSON.stringify(required) !== JSON.stringify(supplied)) {
      throw new Error(`bindings must exactly match requirements: ${required.join(", ")}`);
    }
    for (const requirement of artifact.bindingRequirements) {
      const binding = bindings[requirement.id]!;
      const connection = this.state.connections.find(
        (candidate) => candidate.id === binding.connectionId,
      );
      if (!connection) throw new Error(`unknown Connection: ${binding.connectionId}`);
      if (connection.accountId !== this.state.account.id) {
        throw new Error(`Connection belongs to another Account: ${connection.id}`);
      }
      if (connection.credential !== requirement.credential) {
        throw new Error(`Connection credential kind does not match requirement ${requirement.id}`);
      }
      if (connection.health !== "healthy") {
        throw new Error(`Connection is not healthy: ${connection.id}`);
      }
      if (binding.identityLabel.trim() === "") throw new Error("binding identity label must not be empty");
    }
  }

  private versionFor(artifact: HostedVersionArtifact): DemoVersion {
    const existing = this.state.versions.find((candidate) => candidate.artifact.digest === artifact.digest);
    if (existing) {
      if (existing.artifact.canonicalSource !== artifact.canonicalSource) {
        throw new Error("version digest collision");
      }
      return existing;
    }
    const version = {
      number: (this.state.versions.at(-1)?.number ?? 0) + 1,
      artifact: structuredClone(artifact),
    };
    this.state.versions.push(version);
    return version;
  }

  private newDeployment(
    environment: HostedEnvironment,
    version: DemoVersion,
    bindings: Record<string, DemoBinding>,
  ): DemoDeployment {
    const deployment: DemoDeployment = {
      id: `dep_${environment}_${crypto.randomUUID().replaceAll("-", "")}`,
      environment,
      version: version.number,
      digest: version.artifact.digest,
      bindings: structuredClone(bindings),
      runtimeBindings: this.demoRuntimeBindings(version.artifact, bindings),
    };
    this.state.deployments.push(deployment);
    return deployment;
  }

  private async install(
    gate: GateKind,
    deployment: DemoDeployment,
    artifact: HostedVersionArtifact,
  ): Promise<GateInstallation> {
    const command: GateInstallCommand = {
      accountId: this.state.account.id,
      angelId: this.state.angel.id,
      environment: deployment.environment,
      deploymentId: deployment.id,
      version: deployment.version,
      artifact,
      bindings: deployment.runtimeBindings,
      ...(gate === "gateway"
        ? { gatewayKeyHash: this.state.environments[deployment.environment].keyHash }
        : {}),
    };
    return this.fleet.install(gate, command);
  }

  private demoRuntimeBindings(
    artifact: HostedVersionArtifact,
    bindings: Record<string, DemoBinding>,
  ): GateToolBinding[] {
    const refs = new Map<string, string>();
    return artifact.bindingRequirements.flatMap((requirement) => {
      const binding = bindings[requirement.id]!;
      let connectionRef = refs.get(binding.connectionId);
      if (connectionRef === undefined) {
        connectionRef = `arc_${crypto.randomUUID().replaceAll("-", "")}`;
        refs.set(binding.connectionId, connectionRef);
      }
      return requirement.tools.map((tool) => ({
        tool,
        connectionRef,
        connectionId: binding.connectionId,
        provider: requirement.provider,
        identityLabel: binding.identityLabel,
      }));
    });
  }

  private deployment(id: string): DemoDeployment {
    const deployment = this.state.deployments.find((candidate) => candidate.id === id);
    if (!deployment) throw new Error(`unknown deployment: ${id}`);
    return deployment;
  }

  private version(number: number): DemoVersion {
    const version = this.state.versions.find((candidate) => candidate.number === number);
    if (!version) throw new Error(`unknown version: ${number}`);
    return version;
  }

  private async environmentView(environment: HostedEnvironment): Promise<DemoEnvironmentView> {
    const [broker, gateway] = await Promise.all([
      this.fleet.snapshot("broker", environment),
      this.fleet.snapshot("gateway", environment),
    ]);
    const installationAligned = installationsAligned(broker, gateway);
    const availabilityAligned = sameAvailability(broker.availability, gateway.availability);
    const installation = installationAligned
      ? gateway.installation
      : broker.installation ?? gateway.installation;
    const installationMismatch = !installationAligned && installation !== null;
    const availability = availabilityAligned
      ? gateway.availability
      : conservativeAvailability(broker.availability, gateway.availability);
    return {
      version: installation?.version ?? null,
      digest: installation?.policyDigest ?? null,
      deploymentId: installation?.deploymentId ?? null,
      keyFingerprint: this.state.environments[environment].keyFingerprint,
      gateAlignment: {
        installation: installationAligned ? "aligned" : "mismatched",
        availability: availabilityAligned ? "aligned" : "mismatched",
      },
      pendingAvailabilityRepair: availabilityRepair(
        this.state.environments[environment].pendingAvailability?.change ?? null,
      ),
      availability,
      tools: installation === null
        ? []
        : installation.artifact.tools.map((tool) => {
          const binding = installation.bindings.find(
            (candidate) => candidate.tool.toUpperCase() === tool.name.toUpperCase(),
          );
          return {
            name: tool.name,
            app: appName(tool.provider),
            identity: binding?.identityLabel ?? "Unbound",
            group: groupName(tool.operation),
            available: installationAligned
              && availabilityAligned
              && enabled(broker.availability, tool.name)
              && enabled(gateway.availability, tool.name),
            guards: [
              ...guardLabels(tool.argGuards),
              ...(installationMismatch ? ["gate mismatch: broker and gateway installations are not aligned"] : []),
              ...(!availabilityAligned ? ["gate mismatch: broker and gateway availability are not aligned"] : []),
            ],
          };
        }),
    };
  }

  private versionViews(
    preview: DemoEnvironmentView,
    production: DemoEnvironmentView,
  ): DemoView["angel"]["versions"] {
    return this.state.versions.map((version) => ({
      number: version.number,
      digest: version.artifact.digest,
      label: `Version ${version.number}`,
      status: production.version === version.number && production.digest === version.artifact.digest
        ? "live"
        : preview.version === version.number && preview.digest === version.artifact.digest
        ? "staged"
        : "history",
      tools: version.artifact.tools.map((tool) => tool.name),
    }));
  }

  private readyForProduction(
    preview: DemoEnvironmentView,
    production: DemoEnvironmentView,
  ): DemoView["readyForProduction"] {
    const activeId = this.state.environments.preview.activeDeploymentId;
    if (
      activeId === null
      || preview.deploymentId !== activeId
      || preview.digest === null
      || preview.version === null
      || (
        this.state.environments.production.pendingDeploymentId === null
        && preview.digest === production.digest
        && preview.version === production.version
      )
    ) return null;
    const stagedTools = new Set(preview.tools.map((tool) => tool.name));
    const pendingPromotion = this.state.environments.production.pendingDeploymentId !== null;
    const activeProductionId = this.state.environments.production.activeDeploymentId;
    const activeProduction = pendingPromotion && activeProductionId !== null
      ? this.deployment(activeProductionId)
      : null;
    const productionTools = new Set(
      pendingPromotion
        ? activeProduction === null
          ? []
          : this.version(activeProduction.version).artifact.tools.map((tool) => tool.name)
        : production.tools.map((tool) => tool.name),
    );
    return {
      stagedDeploymentId: activeId,
      expectedDigest: preview.digest,
      fromVersion: pendingPromotion ? activeProduction?.version ?? null : production.version,
      toVersion: preview.version,
      diff: {
        added: [...stagedTools].filter((tool) => !productionTools.has(tool)).sort(),
        removed: [...productionTools].filter((tool) => !stagedTools.has(tool)).sort(),
      },
    };
  }

  private async activityView(): Promise<DemoView["activity"]> {
    const activity: DemoView["activity"] = [];
    for (const environment of environments()) {
      const [gateway, broker] = await Promise.all([
        this.fleet.activity("gateway", environment),
        this.fleet.activity("broker", environment),
      ]);
      for (const receipt of gateway) {
        const brokerReceipt = broker.find((candidate) => candidate.requestId === receipt.requestId);
        const mismatch = brokerReceipt === undefined
          ? null
          : gateReceiptMismatch(gateReceiptIdentity(receipt), brokerReceipt);
        const effectiveReceipt = brokerReceipt ?? receipt;
        activity.push({
          requestId: receipt.requestId,
          environment,
          tool: receipt.tool,
          decision: mismatch === null ? effectiveReceipt.decision : "deny",
          detail: mismatch === null
            ? effectiveReceipt.detail
            : `gate receipt mismatch: ${mismatch.field} differs between gateway and broker`,
          gateway: { digest: receipt.policyDigest, decision: receipt.decision },
          broker: brokerReceipt === undefined
            ? null
            : { digest: brokerReceipt.policyDigest, decision: brokerReceipt.decision },
        });
      }
    }
    return activity;
  }
}

function environmentEndpoint(endpoint: string, environment: HostedEnvironment): string {
  const match = /\/(preview|production)\/mcp$/.exec(endpoint);
  if (match === null) throw new Error("MCP endpoint must end with an environment and /mcp");
  return `${endpoint.slice(0, match.index)}/${environment}/mcp`;
}

function emptyFleetState(): MemoryGateFleetState {
  return {
    schemaVersion: 1,
    gates: {
      preview: {
        gateway: createPolicyGateState("gateway"),
        broker: createPolicyGateState("broker"),
      },
      production: {
        gateway: createPolicyGateState("gateway"),
        broker: createPolicyGateState("broker"),
      },
    },
  };
}

async function createKey(environment: HostedEnvironment): Promise<{
  plaintext: string;
  hash: string;
  fingerprint: string;
}> {
  const plaintext = `ak_${environment}_${crypto.randomUUID().replaceAll("-", "")}`;
  const hash = await sha256Hex(plaintext);
  return {
    plaintext,
    hash,
    fingerprint: `sha256:${hash.slice(0, 12)}`,
  };
}

function environmentState(key: { hash: string; fingerprint: string }): DemoEnvironmentState {
  return {
    activeDeploymentId: null,
    pendingDeploymentId: null,
    keyHash: key.hash,
    keyFingerprint: key.fingerprint,
    pendingAvailability: null,
  };
}

function deriveAvailabilityTarget(
  state: PolicyGateState,
  change: DemoAvailabilityChange,
): GateAvailability {
  if (state.installation === null) throw new Error("cannot change availability before deployment");
  if (change.kind === "all") {
    return {
      defaultEnabled: change.enabled,
      overrides: {},
      connectionOverrides: {},
      revision: state.availability.revision + 1,
    };
  }
  const tool = state.installation.artifact.tools.find(
    (candidate) => candidate.name.toUpperCase() === change.tool.toUpperCase(),
  );
  if (tool === undefined) throw new Error(`unknown deployed tool: ${change.tool}`);
  const overrides = { ...state.availability.overrides };
  if (change.enabled === state.availability.defaultEnabled) {
    delete overrides[tool.name];
  } else {
    overrides[tool.name] = change.enabled;
  }
  return {
    defaultEnabled: state.availability.defaultEnabled,
    overrides: Object.fromEntries(
      Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right)),
    ),
    connectionOverrides: {},
    revision: state.availability.revision + 1,
  };
}

function sameAvailability(left: GateAvailability, right: GateAvailability): boolean {
  return left.defaultEnabled === right.defaultEnabled
    && left.revision === right.revision
    && JSON.stringify(left.overrides) === JSON.stringify(right.overrides)
    && JSON.stringify(left.connectionOverrides) === JSON.stringify(right.connectionOverrides);
}

function sameAvailabilityChange(left: DemoAvailabilityChange, right: DemoAvailabilityChange): boolean {
  return left.kind === right.kind
    && left.enabled === right.enabled
    && (left.kind === "all" || (right.kind === "tool" && left.tool === right.tool));
}

function availabilityRepair(
  change: DemoAvailabilityChange | null,
): DemoEnvironmentView["pendingAvailabilityRepair"] {
  if (change === null) return null;
  if (change.kind === "all") return { action: change.enabled ? "resume_all" : "pause_all" };
  return {
    action: change.enabled ? "resume_tool" : "pause_tool",
    tool: change.tool,
  };
}

function installationsAligned(broker: PolicyGateState, gateway: PolicyGateState): boolean {
  if (broker.installation === null || gateway.installation === null) {
    return broker.installation === gateway.installation;
  }
  return broker.installation.deploymentId === gateway.installation.deploymentId
    && broker.installation.version === gateway.installation.version
    && broker.installation.policyDigest === gateway.installation.policyDigest
    && broker.installation.bindingsDigest === gateway.installation.bindingsDigest;
}

function installationMatchesDeployment(
  installation: GateInstallation | null,
  deployment: DemoDeployment,
  state: Pick<DemoControlState, "account" | "angel">,
): boolean {
  return installation !== null
    && installation.accountId === state.account.id
    && installation.angelId === state.angel.id
    && installation.environment === deployment.environment
    && installation.deploymentId === deployment.id
    && installation.version === deployment.version
    && installation.policyDigest === deployment.digest
    && sameRuntimeBindings(installation.bindings, deployment.runtimeBindings);
}

function sameBindings(
  left: Record<string, DemoBinding>,
  right: Record<string, DemoBinding>,
): boolean {
  const entries = (bindings: Record<string, DemoBinding>) => Object.entries(bindings)
    .map(([slot, binding]) => [slot, binding.connectionId, binding.identityLabel] as const)
    .sort(([leftSlot], [rightSlot]) => leftSlot.localeCompare(rightSlot));
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

function sameRuntimeBindings(left: GateToolBinding[], right: GateToolBinding[]): boolean {
  const entries = (bindings: GateToolBinding[]) => bindings
    .map((binding) => [
      binding.tool,
      binding.connectionRef,
      binding.connectionId,
      binding.provider,
      binding.identityLabel,
    ])
    .sort(([leftTool], [rightTool]) => leftTool!.localeCompare(rightTool!));
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

function conservativeAvailability(
  broker: GateAvailability,
  gateway: GateAvailability,
): GateAvailability {
  const defaultEnabled = broker.defaultEnabled && gateway.defaultEnabled;
  const overrides = Object.fromEntries(
    [...new Set([...Object.keys(broker.overrides), ...Object.keys(gateway.overrides)])]
      .sort()
      .flatMap((tool) => {
        const available = enabled(broker, tool) && enabled(gateway, tool);
        return available === defaultEnabled ? [] : [[tool, available]];
      }),
  );
  return {
    defaultEnabled,
    overrides,
    connectionOverrides: {},
    revision: Math.max(broker.revision, gateway.revision),
  };
}

function enabled(availability: GateAvailability, tool: string): boolean {
  return availability.overrides[tool] ?? availability.defaultEnabled;
}

function guardLabels(guards: HostedVersionArtifact["tools"][number]["argGuards"]): string[] {
  return guards.map((guard) => {
    if ("pin" in guard) return `${guard.field} pinned to ${guard.pin}`;
    if ("forbid" in guard) return `${guard.field} forbidden`;
    return `${guard.field} forbids ${guard.forbiddenValues.join(", ")}`;
  });
}

function appName(adapter: string): string {
  const segment = adapter.split(".")[1] ?? adapter;
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

function groupName(operation: string): string {
  const action = operation.split(".").at(-1)?.toLowerCase();
  return action === "get" || action === "list" ? "Read" : "Use";
}

function environments(): HostedEnvironment[] {
  return ["preview", "production"];
}

function assertEnvironment(environment: HostedEnvironment): void {
  if (environment !== "preview" && environment !== "production") {
    throw new Error(`unknown deployment environment: ${String(environment)}`);
  }
}
