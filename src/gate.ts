import type {
  DeploymentEnvironment,
  HostedTool,
  HostedVersionArtifact,
  ToolRequest,
} from "./domain";
import {
  canonicalJson,
  compileRules,
  evaluateToolCall,
  sha256Hex,
  timingSafeEqualText,
} from "@smcllns/angel-core";
import type { AngelTool, ArgGuard } from "@smcllns/angel-core";

export type GateKind = "gateway" | "broker";

export interface GateToolBinding {
  tool: string;
  connectionRef: string;
  connectionId: string;
  provider: string;
  identityLabel: string;
}

export interface RuntimeConnectionChoice {
  ref: string;
  provider: string;
  identity: string;
}

export interface AvailableRuntimeTool {
  tool: HostedTool;
  connections: RuntimeConnectionChoice[];
}

export interface GateAvailability {
  defaultEnabled: boolean;
  overrides: Record<string, boolean>;
  connectionOverrides: Record<string, Record<string, boolean>>;
  revision: number;
}

export interface GateIdentity {
  accountId: string;
  angelId: string;
  environment: DeploymentEnvironment;
}

export interface GateInstallation extends GateIdentity {
  gate: GateKind;
  deploymentId: string;
  version: number;
  policyDigest: string;
  bindingsDigest: string;
  artifact: HostedVersionArtifact;
  bindings: GateToolBinding[];
}

export interface GateReceipt extends GateIdentity {
  sequence: number;
  gate: GateKind;
  deploymentId: string;
  version: number;
  policyDigest: string;
  bindingsDigest: string;
  availabilityDigest: string;
  requestId: string;
  tool: string;
  provider: string | null;
  operation: string | null;
  connectionId: string | null;
  connectionRef: string | null;
  connectionIdentityLabel: string | null;
  argumentsDigest: string;
  decision: "allow" | "deny";
  detail: string;
  previousHash: string;
  hash: string;
}

export const GATE_RECEIPT_IDENTITY_FIELDS = [
  "deploymentId",
  "version",
  "policyDigest",
  "bindingsDigest",
  "availabilityDigest",
  "tool",
  "connectionRef",
] as const;

export type GateReceiptIdentity = Pick<
  GateReceipt,
  (typeof GATE_RECEIPT_IDENTITY_FIELDS)[number]
>;

export interface GateReceiptMismatch {
  field: (typeof GATE_RECEIPT_IDENTITY_FIELDS)[number];
  expected: string | number | null;
  actual: string | number | null;
}

export function gateReceiptIdentity(receipt: GateReceipt): GateReceiptIdentity {
  return {
    deploymentId: receipt.deploymentId,
    version: receipt.version,
    policyDigest: receipt.policyDigest,
    bindingsDigest: receipt.bindingsDigest,
    availabilityDigest: receipt.availabilityDigest,
    tool: receipt.tool,
    connectionRef: receipt.connectionRef,
  };
}

export function gateReceiptMismatch(
  expected: GateReceiptIdentity,
  actual: GateReceipt,
): GateReceiptMismatch | null {
  for (const field of GATE_RECEIPT_IDENTITY_FIELDS) {
    if (expected[field] !== actual[field]) {
      return { field, expected: expected[field], actual: actual[field] };
    }
  }
  return null;
}

export interface PolicyGateState {
  schemaVersion: 1;
  gate: GateKind;
  identity: GateIdentity | null;
  installation: GateInstallation | null;
  /**
   * Legacy single gateway key hash. Retained for back-compat and mirrored to the
   * first entry of `gatewayKeyHashes`; `gatewayKeyHashes` is the authoritative set.
   */
  gatewayKeyHash: string | null;
  /**
   * Active gateway key hashes. Any presented key whose SHA-256 is in this set
   * authenticates; a revoked key is absent and therefore rejected. Additive:
   * states persisted before named keys have no `gatewayKeyHashes` and fall back to
   * the legacy single hash on read.
   */
  gatewayKeyHashes?: string[];
  availability: GateAvailability;
  deploymentFingerprints: Record<string, string>;
  receipts: GateReceipt[];
  checkpoint: string;
}

export interface GateInstallCommand extends GateIdentity {
  deploymentId: string;
  version: number;
  artifact: HostedVersionArtifact;
  bindings: GateToolBinding[];
  /** Legacy single-key install: a stable gateway key hash. */
  gatewayKeyHash?: string;
  /**
   * Named-keys install: the full set of active gateway key hashes. Replaces the
   * gate's active set (rotation/revocation propagate here). Takes precedence over
   * `gatewayKeyHash` when both are present.
   */
  gatewayKeyHashes?: string[];
}

export type GateAvailabilityCommand =
  | {
      kind: "all";
      enabled: boolean;
      expectedRevision: number;
    }
  | {
      kind: "tool";
      tool: string;
      enabled: boolean;
      expectedRevision: number;
    }
  | {
      kind: "tool_connection";
      tool: string;
      connectionRef: string;
      enabled: boolean;
      expectedRevision: number;
    };

export interface GateEvaluationInput {
  requestId: string;
  presentedKey?: string;
  tool: string;
  arguments: Record<string, unknown>;
  connectionRef?: string;
}

export type GateEvaluation =
  | {
      allowed: true;
      reason: "allowed";
      effectiveArguments: Record<string, unknown>;
      // Sealed execution data straight from the installed artifact: the
      // matched tool's request template and its provider's pinned origin.
      // Lives on the evaluation, not the hash-chained receipt.
      execution: {
        origin: string;
        request: ToolRequest;
      };
      receipt: GateReceipt;
    }
  | {
      allowed: false;
      reason:
        | "unauthorized"
        | "unknown_tool"
        | "tool_paused"
        | "connection_required"
        | "connection_paused"
        | "connection_unavailable"
        | "guard_denied";
      receipt: GateReceipt;
    };

export interface GateChainVerification {
  ok: boolean;
  checked: number;
  error?: string;
}

const ZERO_HASH = "0".repeat(64);
const SHA256_HEX = /^[a-f0-9]{64}$/;

export function createPolicyGateState(gate: GateKind): PolicyGateState {
  return {
    schemaVersion: 1,
    gate,
    identity: null,
    installation: null,
    gatewayKeyHash: null,
    gatewayKeyHashes: [],
    availability: {
      defaultEnabled: true,
      overrides: {},
      connectionOverrides: {},
      revision: 0,
    },
    deploymentFingerprints: {},
    receipts: [],
    checkpoint: ZERO_HASH,
  };
}

export class PolicyGate {
  private readonly state: PolicyGateState;

  constructor(state: PolicyGateState) {
    this.state = structuredClone(state);
    if (this.state.schemaVersion !== 1) throw new Error("unsupported gate state schema");
    if (!SHA256_HEX.test(this.state.checkpoint)) throw new Error("gate checkpoint is malformed");
    // Migrate a pre-named-keys state: seed the active-key set from the legacy hash.
    this.state.gatewayKeyHashes ??= this.state.gatewayKeyHash === null
      ? []
      : [this.state.gatewayKeyHash];
  }

  private activeKeyHashes(): string[] {
    return this.state.gatewayKeyHashes ?? (this.state.gatewayKeyHash === null ? [] : [this.state.gatewayKeyHash]);
  }

  snapshot(): PolicyGateState {
    return structuredClone(this.state);
  }

  availability(): GateAvailability {
    return structuredClone(this.state.availability);
  }

  async install(command: GateInstallCommand): Promise<GateInstallation> {
    assertSupportedArtifactFormat(command.artifact);
    assertArtifactContent(command.artifact);
    const actualDigest = await sha256Hex(command.artifact.canonicalSource);
    if (actualDigest !== command.artifact.digest) throw new Error("artifact digest mismatch");
    if (command.artifact.name !== command.angelId) {
      throw new Error("artifact identity does not match Angel");
    }
    this.assertIdentity(command);
    this.assertBindings(command.artifact, command.bindings);
    const deploymentId = requiredText(command.deploymentId, "deployment ID");
    const version = positiveInteger(command.version, "version");
    const gatewayKeyHashes = this.validatedGatewayKeys(command);

    const bindings = canonicalBindings(command.bindings);
    const bindingsDigest = await sha256Hex(canonicalJson(bindings));
    const installation: GateInstallation = {
      gate: this.state.gate,
      accountId: command.accountId,
      angelId: command.angelId,
      environment: command.environment,
      deploymentId,
      version,
      policyDigest: command.artifact.digest,
      bindingsDigest,
      artifact: structuredClone(command.artifact),
      bindings,
    };
    const deploymentFingerprint = await sha256Hex(canonicalJson({
      accountId: installation.accountId,
      angelId: installation.angelId,
      environment: installation.environment,
      deploymentId: installation.deploymentId,
      version: installation.version,
      policyDigest: installation.policyDigest,
      bindingsDigest: installation.bindingsDigest,
    }));
    const existingFingerprint = this.state.deploymentFingerprints[installation.deploymentId];
    if (existingFingerprint !== undefined && existingFingerprint !== deploymentFingerprint) {
      throw new Error("deployment ID is already installed with different content");
    }

    const activeTools = new Map(
      installation.artifact.tools.map((tool) => [tool.name.toUpperCase(), tool.name]),
    );
    this.state.availability.overrides = Object.fromEntries(
      Object.entries(this.state.availability.overrides)
        .flatMap(([tool, enabled]) => {
          const canonical = activeTools.get(tool.toUpperCase());
          return canonical === undefined ? [] : [[canonical, enabled] as const];
        })
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    this.state.availability.connectionOverrides = Object.fromEntries(
      Object.entries(this.state.availability.connectionOverrides)
        .flatMap(([toolName, overrides]) => {
          const tool = activeTools.get(toolName.toUpperCase());
          if (tool === undefined) return [];
          const activeRefs = new Set(
            installation.bindings
              .filter((binding) => binding.tool.toUpperCase() === tool.toUpperCase())
              .map((binding) => binding.connectionRef),
          );
          const surviving = Object.fromEntries(
            Object.entries(overrides)
              .filter(([connectionRef]) => activeRefs.has(connectionRef))
              .sort(([left], [right]) => left.localeCompare(right)),
          );
          return Object.keys(surviving).length === 0 ? [] : [[tool, surviving] as const];
        })
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    this.state.identity = {
      accountId: command.accountId,
      angelId: command.angelId,
      environment: command.environment,
    };
    this.state.gatewayKeyHashes = gatewayKeyHashes;
    this.state.gatewayKeyHash = gatewayKeyHashes[0] ?? null;
    this.state.deploymentFingerprints[installation.deploymentId] = deploymentFingerprint;
    this.state.installation = installation;
    return structuredClone(installation);
  }

  changeAvailability(command: GateAvailabilityCommand): GateAvailability {
    const installation = this.requireInstallation();
    if (command.expectedRevision !== this.state.availability.revision) {
      throw new Error("availability revision mismatch");
    }
    if (command.kind === "all") {
      this.state.availability.defaultEnabled = command.enabled;
      this.state.availability.overrides = {};
      this.state.availability.connectionOverrides = {};
    } else if (command.kind === "tool") {
      const tool = findTool(installation.artifact, command.tool);
      if (!tool) throw new Error(`unknown deployed tool: ${command.tool}`);
      if (command.enabled === this.state.availability.defaultEnabled) {
        delete this.state.availability.overrides[tool.name];
      } else {
        this.state.availability.overrides[tool.name] = command.enabled;
      }
      this.state.availability.overrides = Object.fromEntries(
        Object.entries(this.state.availability.overrides)
          .sort(([left], [right]) => left.localeCompare(right)),
      );
      delete this.state.availability.connectionOverrides[tool.name];
    } else {
      const tool = findTool(installation.artifact, command.tool);
      if (!tool) throw new Error(`unknown deployed tool: ${command.tool}`);
      const binding = installation.bindings.find(
        (candidate) => candidate.tool.toUpperCase() === tool.name.toUpperCase()
          && candidate.connectionRef === command.connectionRef,
      );
      if (binding === undefined) {
        throw new Error(`unknown deployed tool Connection: ${command.tool} / ${command.connectionRef}`);
      }
      const baseEnabled = this.state.availability.overrides[tool.name]
        ?? this.state.availability.defaultEnabled;
      const overrides = this.state.availability.connectionOverrides[tool.name] ?? {};
      if (command.enabled === baseEnabled) {
        delete overrides[binding.connectionRef];
      } else {
        overrides[binding.connectionRef] = command.enabled;
      }
      if (Object.keys(overrides).length === 0) {
        delete this.state.availability.connectionOverrides[tool.name];
      } else {
        this.state.availability.connectionOverrides[tool.name] = Object.fromEntries(
          Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right)),
        );
      }
      this.state.availability.connectionOverrides = Object.fromEntries(
        Object.entries(this.state.availability.connectionOverrides)
          .sort(([left], [right]) => left.localeCompare(right)),
      );
    }
    this.state.availability.revision += 1;
    return this.availability();
  }

  async evaluate(input: GateEvaluationInput): Promise<GateEvaluation> {
    const installation = this.requireInstallation();
    requiredText(input.requestId, "request ID");
    requiredText(input.tool, "tool");

    if (this.state.gate === "gateway" && !await this.authenticated(input.presentedKey)) {
      return this.denied(
        installation,
        input,
        undefined,
        null,
        await sha256Hex("arguments withheld before authentication"),
        "unauthorized",
        "invalid Angel key",
      );
    }
    // A persisted pre-v2 installation must fail loudly here — after auth (an
    // unauthenticated probe still gets its 401 receipt) but before any other
    // receipt is chained: its tools carry no sealed requests to execute.
    assertSupportedArtifactFormat(installation.artifact);
    const tool = findTool(installation.artifact, input.tool);
    const argumentsDigest = await sha256Hex(canonicalJson(input.arguments));
    if (!tool) {
      return this.denied(
        installation,
        input,
        tool,
        null,
        argumentsDigest,
        "unknown_tool",
        "not allowlisted",
      );
    }
    const selection = selectBinding(
      this.state.gate,
      installation,
      this.state.availability,
      tool,
      input,
    );
    if (!selection.ok) {
      return this.denied(
        installation,
        input,
        tool,
        null,
        argumentsDigest,
        selection.reason,
        selection.detail,
      );
    }

    const rule: AngelTool = { tool: tool.name, argGuards: tool.argGuards };
    const decision = evaluateToolCall({
      rules: compileRules([rule]),
      tool: tool.name,
      bodyText: canonicalJson(selection.arguments),
      // Sealed path defaults materialize BEFORE guards (core decision
      // contract): the object that is guarded, ledgered, and forwarded is one
      // and the same. Guard pins win over template defaults.
      defaults: { ...tool.request.pathDefaults, ...pinDefaults(tool.argGuards) },
    });
    if (!decision.ok) {
      return this.denied(
        installation,
        input,
        tool,
        selection.binding,
        argumentsDigest,
        "guard_denied",
        decision.denied,
      );
    }

    const receipt = await this.appendReceipt({
      installation,
      input,
      tool,
      source: selection.binding,
      argumentsDigest: await sha256Hex(canonicalJson(decision.args)),
      decision: "allow",
      detail: "exact policy allowed",
    });
    const provider = installation.artifact.providers[tool.provider];
    if (!provider) {
      throw new Error(`installed artifact has no providers entry for ${tool.provider}`);
    }
    return {
      allowed: true,
      reason: "allowed",
      effectiveArguments: structuredClone(decision.args),
      execution: {
        origin: provider.origin,
        request: structuredClone(tool.request),
      },
      receipt,
    };
  }

  async verifyChain(): Promise<GateChainVerification> {
    let previousHash = ZERO_HASH;
    for (let index = 0; index < this.state.receipts.length; index++) {
      const receipt = this.state.receipts[index]!;
      if (receipt.previousHash !== previousHash) {
        return { ok: false, checked: index, error: `receipt ${index} previous hash mismatch` };
      }
      const expected = await receiptHash(receiptWithoutHash(receipt), receipt.previousHash);
      if (expected !== receipt.hash) {
        return { ok: false, checked: index, error: `receipt ${index} hash mismatch` };
      }
      previousHash = receipt.hash;
    }
    if (this.state.checkpoint !== previousHash) {
      return {
        ok: false,
        checked: this.state.receipts.length,
        error: "checkpoint does not match chain tail",
      };
    }
    return { ok: true, checked: this.state.receipts.length };
  }

  private assertIdentity(command: GateIdentity): void {
    const identity = this.state.identity;
    if (!identity) return;
    if (
      identity.accountId !== command.accountId
      || identity.angelId !== command.angelId
      || identity.environment !== command.environment
    ) {
      throw new Error("gate identity mismatch");
    }
  }

  private assertBindings(
    artifact: HostedVersionArtifact,
    bindings: GateToolBinding[],
  ): void {
    if (!Array.isArray(bindings)) throw new Error("tool bindings must be a list");
    const required = new Set(artifact.tools.map((tool) => tool.name.toUpperCase()));
    const supplied = new Set<string>();
    const tuples = new Set<string>();
    const refs = new Map<string, Pick<GateToolBinding, "connectionId" | "identityLabel">>();
    for (const binding of bindings) {
      requiredText(binding.tool, "binding tool");
      requiredText(binding.connectionRef, "Connection ref");
      requiredText(binding.connectionId, "Connection ID");
      requiredText(binding.provider, "provider");
      requiredText(binding.identityLabel, "Connection identity label");
      const tool = findTool(artifact, binding.tool);
      if (tool === undefined) throw new Error(`binding references unknown deployed tool: ${binding.tool}`);
      if (binding.provider !== tool.provider) {
        throw new Error(`binding provider does not match deployed tool: ${binding.tool}`);
      }
      supplied.add(tool.name.toUpperCase());
      const tuple = `${tool.name.toUpperCase()}\u0000${binding.connectionRef}`;
      if (tuples.has(tuple)) throw new Error(`duplicate tool Connection binding: ${tool.name}`);
      tuples.add(tuple);
      const existing = refs.get(binding.connectionRef);
      if (
        existing !== undefined
        && (
          existing.connectionId !== binding.connectionId
          || existing.identityLabel !== binding.identityLabel
        )
      ) {
        throw new Error(`Connection ref collision: ${binding.connectionRef}`);
      }
      refs.set(binding.connectionRef, {
        connectionId: binding.connectionId,
        identityLabel: binding.identityLabel,
      });
    }
    const missing = [...required].filter((tool) => !supplied.has(tool));
    if (missing.length > 0) {
      throw new Error(`tool bindings must cover every deployed tool: ${missing.join(", ")}`);
    }
  }

  private validatedGatewayKeys(command: GateInstallCommand): string[] {
    if (this.state.gate === "broker") {
      if (command.gatewayKeyHash !== undefined || command.gatewayKeyHashes !== undefined) {
        throw new Error("broker cannot install a gateway key hash");
      }
      return [];
    }
    const current = this.activeKeyHashes();
    // Named-keys mode: the caller supplies the full active set, which replaces the
    // gate's set (this is how rotation/revocation propagate through a deploy).
    if (command.gatewayKeyHashes !== undefined) {
      return normalizeGatewayKeyHashes(command.gatewayKeyHashes);
    }
    // Legacy single-key mode: the hash is stable across installs.
    if (command.gatewayKeyHash !== undefined) {
      if (!SHA256_HEX.test(command.gatewayKeyHash)) {
        throw new Error("gateway install requires a SHA-256 key hash");
      }
      if (current.length === 0) return [command.gatewayKeyHash];
      if (current.length !== 1 || current[0] !== command.gatewayKeyHash) {
        throw new Error("gateway key hash is stable across installs");
      }
      return current;
    }
    // Neither supplied: a first gateway install must carry a key; a reinstall keeps
    // the existing active set (e.g. a repair that does not touch keys).
    if (current.length === 0) throw new Error("gateway install requires a SHA-256 key hash");
    return current;
  }

  /**
   * Replace the gateway's active key set out-of-band from a deploy, so a newly
   * created key authenticates and a revoked key is rejected immediately. Gateway
   * gates only; the broker holds no runtime keys.
   */
  reconcileGatewayKeys(hashes: string[]): string[] {
    if (this.state.gate !== "gateway") {
      throw new Error("broker gate has no runtime keys");
    }
    const normalized = normalizeGatewayKeyHashes(hashes);
    this.state.gatewayKeyHashes = normalized;
    this.state.gatewayKeyHash = normalized[0] ?? null;
    return [...normalized];
  }

  private requireInstallation(): GateInstallation {
    if (!this.state.installation) throw new Error("gate has no active installation");
    return this.state.installation;
  }

  private async authenticated(presentedKey: string | undefined): Promise<boolean> {
    if (presentedKey === undefined) return false;
    const hashes = this.activeKeyHashes();
    if (hashes.length === 0) return false;
    const presentedHash = await sha256Hex(presentedKey);
    let matched = false;
    // Check every active hash (no early return) to keep the comparison time
    // independent of which key matched.
    for (const hash of hashes) {
      if (await timingSafeEqualText(presentedHash, hash)) matched = true;
    }
    return matched;
  }

  private async denied(
    installation: GateInstallation,
    input: GateEvaluationInput,
    tool: HostedTool | undefined,
    source: GateToolBinding | null,
    argumentsDigest: string,
    reason: Extract<GateEvaluation, { allowed: false }>["reason"],
    detail: string,
  ): Promise<Extract<GateEvaluation, { allowed: false }>> {
    return {
      allowed: false,
      reason,
      receipt: await this.appendReceipt({
        installation,
        input,
        tool,
        source,
        argumentsDigest,
        decision: "deny",
        detail,
      }),
    };
  }

  private async appendReceipt(input: {
    installation: GateInstallation;
    input: GateEvaluationInput;
    tool: HostedTool | undefined;
    source: GateToolBinding | null;
    argumentsDigest: string;
    decision: GateReceipt["decision"];
    detail: string;
  }): Promise<GateReceipt> {
    const availabilityDigest = await sha256Hex(canonicalJson({
      policyDigest: input.installation.policyDigest,
      ...this.state.availability,
    }));
    const previousHash = this.state.checkpoint;
    const body: Omit<GateReceipt, "previousHash" | "hash"> = {
      sequence: this.state.receipts.length,
      gate: this.state.gate,
      accountId: input.installation.accountId,
      angelId: input.installation.angelId,
      environment: input.installation.environment,
      deploymentId: input.installation.deploymentId,
      version: input.installation.version,
      policyDigest: input.installation.policyDigest,
      bindingsDigest: input.installation.bindingsDigest,
      availabilityDigest,
      requestId: input.input.requestId,
      tool: input.tool?.name ?? input.input.tool,
      provider: input.source?.provider ?? null,
      operation: input.tool?.operation ?? null,
      connectionId: input.source?.connectionId ?? null,
      connectionRef: input.source?.connectionRef ?? null,
      connectionIdentityLabel: input.source?.identityLabel ?? null,
      argumentsDigest: input.argumentsDigest,
      decision: input.decision,
      detail: input.detail,
    };
    const receipt: GateReceipt = {
      ...body,
      previousHash,
      hash: await receiptHash(body, previousHash),
    };
    this.state.receipts.push(receipt);
    this.state.checkpoint = receipt.hash;
    return structuredClone(receipt);
  }
}

type BindingSelection =
  | {
      ok: true;
      binding: GateToolBinding;
      arguments: Record<string, unknown>;
    }
  | {
      ok: false;
      reason:
        | "tool_paused"
        | "connection_required"
        | "connection_paused"
        | "connection_unavailable";
      detail: string;
    };

function selectBinding(
  gate: GateKind,
  installation: GateInstallation,
  availability: GateAvailability,
  tool: HostedTool,
  input: GateEvaluationInput,
): BindingSelection {
  const bindings = installation.bindings.filter(
    (binding) => binding.tool.toUpperCase() === tool.name.toUpperCase(),
  );
  const activeBindings = bindings.filter(
    (binding) => isToolConnectionEnabled(availability, tool.name, binding.connectionRef),
  );
  const { angel_connection: publicSelector, ...providerArguments } = input.arguments;
  const selector = gate === "gateway" ? publicSelector : input.connectionRef;
  if (selector === undefined) {
    if (activeBindings.length === 0) {
      return { ok: false, reason: "tool_paused", detail: "tool has no active Connections" };
    }
    if (activeBindings.length !== 1) {
      return {
        ok: false,
        reason: "connection_required",
        detail: "angel_connection is required when more than one Connection is available",
      };
    }
    return { ok: true, binding: activeBindings[0]!, arguments: providerArguments };
  }
  if (typeof selector !== "string" || selector === "") {
    return {
      ok: false,
      reason: "connection_unavailable",
      detail: "angel_connection is not an available Connection",
    };
  }
  const binding = bindings.find((candidate) => candidate.connectionRef === selector);
  if (binding === undefined) {
    return {
      ok: false,
      reason: "connection_unavailable",
      detail: "angel_connection is not an available Connection",
    };
  }
  if (!isToolConnectionEnabled(availability, tool.name, binding.connectionRef)) {
    return {
      ok: false,
      reason: "connection_paused",
      detail: "angel_connection is paused for this tool",
    };
  }
  return { ok: true, binding, arguments: providerArguments };
}

function findTool(artifact: HostedVersionArtifact, name: string): HostedTool | undefined {
  const folded = name.toUpperCase();
  return artifact.tools.find((tool) => tool.name.toUpperCase() === folded);
}

export function availableTools(state: PolicyGateState): HostedTool[] {
  return state.installation?.artifact.tools.filter(
    (tool) => state.installation!.bindings.some(
      (binding) => binding.tool.toUpperCase() === tool.name.toUpperCase()
        && isToolConnectionEnabled(state.availability, tool.name, binding.connectionRef),
    ),
  ) ?? [];
}

export function availableRuntimeTools(state: PolicyGateState): AvailableRuntimeTool[] {
  const installation = state.installation;
  if (installation === null) return [];
  return installation.artifact.tools.flatMap((tool) => {
    const connections = installation.bindings
      .filter((binding) => binding.tool.toUpperCase() === tool.name.toUpperCase())
      .filter((binding) => isToolConnectionEnabled(
        state.availability,
        tool.name,
        binding.connectionRef,
      ))
      .map((binding) => ({
        ref: binding.connectionRef,
        provider: binding.provider,
        identity: binding.identityLabel,
      }))
      .sort((left, right) => left.ref.localeCompare(right.ref));
    return connections.length === 0 ? [] : [{ tool, connections }];
  });
}

function isToolEnabled(availability: GateAvailability, tool: string): boolean {
  return availability.overrides[tool] ?? availability.defaultEnabled;
}

function isToolConnectionEnabled(
  availability: GateAvailability,
  tool: string,
  connectionRef: string,
): boolean {
  return availability.connectionOverrides[tool]?.[connectionRef]
    ?? isToolEnabled(availability, tool);
}

function pinDefaults(guards: ArgGuard[]): Record<string, string> {
  return Object.fromEntries(
    guards
      .filter((guard): guard is { field: string; pin: string } => "pin" in guard)
      .map((guard) => [guard.field, guard.pin]),
  );
}

function canonicalBindings(bindings: GateToolBinding[]): GateToolBinding[] {
  return bindings
    .map((binding) => ({ ...binding }))
    .sort((left, right) => {
      const byTool = left.tool.localeCompare(right.tool);
      return byTool === 0
        ? left.connectionRef.localeCompare(right.connectionRef)
        : byTool;
    });
}

function assertSupportedArtifactFormat(artifact: HostedVersionArtifact): void {
  if (artifact.format !== "angel.version.v2") {
    throw new Error(`unsupported artifact format: ${String(artifact.format)} — republish from unchanged sources`);
  }
}

function assertArtifactContent(artifact: HostedVersionArtifact): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact.canonicalSource);
  } catch {
    throw new Error("artifact canonical source is not valid JSON");
  }
  const structured = {
    format: artifact.format,
    name: artifact.name,
    charter: artifact.charter,
    children: artifact.children,
    providers: artifact.providers,
    bindingRequirements: artifact.bindingRequirements,
    tools: artifact.tools,
  };
  if (canonicalJson(parsed) !== canonicalJson(structured)) {
    throw new Error("artifact content does not match canonical source");
  }
}

function requiredText(value: string, label: string): string {
  if (value.trim() === "") throw new Error(`${label} must not be empty`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

/**
 * Validate an active gateway key set: a non-empty list of unique SHA-256 hashes,
 * returned in a canonical (sorted) order so equal sets serialize identically.
 */
function normalizeGatewayKeyHashes(hashes: readonly string[]): string[] {
  if (!Array.isArray(hashes) || hashes.length === 0) {
    throw new Error("gateway install requires at least one SHA-256 key hash");
  }
  const unique = new Set<string>();
  for (const hash of hashes) {
    if (typeof hash !== "string" || !SHA256_HEX.test(hash)) {
      throw new Error("gateway key hash must be a SHA-256 hex string");
    }
    unique.add(hash);
  }
  return [...unique].sort();
}

function receiptWithoutHash(
  receipt: GateReceipt,
): Omit<GateReceipt, "previousHash" | "hash"> {
  const { previousHash: _previousHash, hash: _hash, ...body } = receipt;
  return body;
}

async function receiptHash(
  receipt: Omit<GateReceipt, "previousHash" | "hash">,
  previousHash: string,
): Promise<string> {
  return sha256Hex(canonicalJson({ ...receipt, previousHash }));
}
