import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileHostedAngel, type HostedVersionArtifact } from "../../src/domain";
import {
  DemoControl,
  MemoryGateFleet,
  type DemoBootstrapInput,
  type GateFleet,
} from "../../src/control";
import type {
  GateEvaluationInput,
  GateAvailabilityCommand,
  GateInstallCommand,
  GateInstallation,
  GateKind,
  GateReceipt,
  PolicyGateState,
} from "../../src/gate";
import type { DeploymentEnvironment } from "../../src/domain";

const fixtures = join(import.meta.dir, "../../research/hosted-platform/example-configurations");
const v1Source = readFileSync(join(fixtures, "golden-research-assistant.v1.hosted.yaml"), "utf8")
  .replace("${GOLDEN_GOOGLE_DOC_ID}", "doc_golden_1");
const v2Source = readFileSync(join(fixtures, "golden-research-assistant.v2.hosted.yaml"), "utf8")
  .replace("${GOLDEN_GOOGLE_DOC_ID}", "doc_golden_1");

const bootstrapInput: DemoBootstrapInput = {
  account: { id: "acct_personal", name: "Personal" },
  angel: { id: "golden-research-assistant", name: "Golden Research Assistant" },
  endpoint: "https://gateway.example/v1/a/acct_personal/golden-research-assistant/production/mcp",
  connections: [{
    id: "con_google",
    accountId: "acct_personal",
    credential: "google_oauth",
    label: "Golden Google",
    apps: ["Gmail", "Google Docs"],
    health: "healthy",
  }],
};

const bindings = {
  gmail: {
    connectionId: "con_google",
    identityLabel: "Golden Google",
  },
  docs: {
    connectionId: "con_google",
    identityLabel: "Golden Google",
  },
};

async function artifacts(): Promise<{ v1: HostedVersionArtifact; v2: HostedVersionArtifact }> {
  return {
    v1: await compileHostedAngel(v1Source),
    v2: await compileHostedAngel(v2Source),
  };
}

async function boot(fleet: GateFleet = new MemoryGateFleet()) {
  return DemoControl.bootstrap({ ...bootstrapInput, fleet });
}

describe("DemoControl release and promotion", () => {
  test("resets a reused gate fleet to a pristine environment", async () => {
    const fleet = new MemoryGateFleet();
    const { control } = await boot(fleet);
    const { v1 } = await artifacts();
    await control.publish({ artifact: v1, bindings });
    await control.changeAvailability("staging", { kind: "all", enabled: false });

    await fleet.reset("broker", "staging");
    await fleet.reset("gateway", "staging");

    expect(await fleet.snapshot("broker", "staging")).toEqual(
      expect.objectContaining({ installation: null, receipts: [] }),
    );
    expect(await fleet.snapshot("gateway", "staging")).toEqual(
      expect.objectContaining({
        installation: null,
        receipts: [],
        availability: {
          defaultEnabled: true,
          overrides: {},
          connectionOverrides: {},
          revision: 0,
        },
      }),
    );
  });

  test("bootstraps opaque environment keys and publishes v1 to staging only", async () => {
    const fleet = new MemoryGateFleet();
    const { control, keys } = await boot(fleet);
    const { v1 } = await artifacts();

    expect(keys.staging).not.toBe(keys.production);
    expect(keys.staging).toMatch(/^ak_staging_/);
    expect(keys.production).toMatch(/^ak_production_/);
    expect(JSON.stringify(control.exportState())).not.toContain(keys.staging);
    expect(JSON.stringify(control.exportState())).not.toContain(keys.production);

    const staged = await control.publish({ artifact: v1, bindings });
    const view = await control.view();

    expect(staged).toMatchObject({ environment: "staging", version: 1, digest: v1.digest });
    expect(fleet.history().map((entry) => `${entry.operation}:${entry.gate}:${entry.environment}`))
      .toEqual(["install:broker:staging", "install:gateway:staging"]);
    expect(view).toMatchObject({
      schema: "angelmcp.demo.v1",
      account: bootstrapInput.account,
      angel: {
        id: bootstrapInput.angel.id,
        name: bootstrapInput.angel.name,
        endpoints: {
          staging: bootstrapInput.endpoint!.replace("/production", "/staging"),
          production: bootstrapInput.endpoint,
        },
        enabled: true,
        environments: {
          staging: { version: 1, digest: v1.digest, deploymentId: staged.id },
          production: { version: null, digest: null, deploymentId: null },
        },
      },
      readyForProduction: {
        stagedDeploymentId: staged.id,
        expectedDigest: v1.digest,
        fromVersion: null,
        toVersion: 1,
      },
      activity: [],
    });
    expect(view.angel.connections).toEqual([{
      id: "con_google",
      label: "Golden Google",
      apps: ["Gmail", "Google Docs"],
      health: "healthy",
    }]);
    expect(view.angel.versions).toEqual([{
      number: 1,
      digest: v1.digest,
      label: "Version 1",
      status: "staged",
      tools: v1.tools.map((tool) => tool.name),
    }]);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  test("promotes only the active staged deployment and exact expected digest", async () => {
    const fleet = new MemoryGateFleet();
    const { control } = await boot(fleet);
    const { v1 } = await artifacts();
    const staged = await control.publish({ artifact: v1, bindings });

    await expect(control.promote({
      stagedDeploymentId: "dep_stale",
      expectedDigest: v1.digest,
    })).rejects.toThrow(/active staged deployment/);
    await expect(control.promote({
      stagedDeploymentId: staged.id,
      expectedDigest: "0".repeat(64),
    })).rejects.toThrow(/expected digest/);
    expect(fleet.history()).toHaveLength(2);

    const production = await control.promote({
      stagedDeploymentId: staged.id,
      expectedDigest: v1.digest,
    });
    expect(production).toMatchObject({ environment: "production", version: 1, digest: v1.digest });
    expect(fleet.history().slice(2).map((entry) => `${entry.operation}:${entry.gate}:${entry.environment}`))
      .toEqual(["install:broker:production", "install:gateway:production"]);
    expect((await control.view()).readyForProduction).toBeNull();
  });

  test("restores and retries the exact pending promotion after one gate fails", async () => {
    const memory = new MemoryGateFleet();
    const { control } = await boot(memory);
    const { v1, v2 } = await artifacts();
    const stagedV1 = await control.publish({ artifact: v1, bindings });
    await control.promote({ stagedDeploymentId: stagedV1.id, expectedDigest: v1.digest });
    await control.changeAvailability("production", { kind: "all", enabled: false });
    const stagedV2 = await control.publish({ artifact: v2, bindings });
    const beforeFailure = control.exportState();
    const failingControl = DemoControl.restore(
      beforeFailure,
      new FailOnceFleet(memory, "gateway", "install"),
    );

    await expect(failingControl.promote({
      stagedDeploymentId: stagedV2.id,
      expectedDigest: v2.digest,
    })).rejects.toThrow("injected gateway failure");

    const failedState = JSON.parse(JSON.stringify(failingControl.exportState())) as typeof beforeFailure & {
      environments: {
        production: { pendingDeploymentId: string | null };
      };
    };
    const pendingDeploymentId = failedState.environments.production.pendingDeploymentId;
    const activeDeploymentId = beforeFailure.environments.production.activeDeploymentId;
    expect(pendingDeploymentId).toMatch(/^dep_production_/);
    if (pendingDeploymentId === null || activeDeploymentId === null) {
      throw new Error("test setup requires active and pending production deployments");
    }
    expect(failedState.environments.production.activeDeploymentId)
      .toBe(activeDeploymentId);
    expect(failedState.deployments).toHaveLength(beforeFailure.deployments.length + 1);
    expect((await memory.snapshot("broker", "production")).installation?.deploymentId)
      .toBe(pendingDeploymentId);
    expect((await memory.snapshot("gateway", "production")).installation?.deploymentId)
      .toBe(activeDeploymentId);
    expect((await failingControl.view()).readyForProduction).toMatchObject({
      stagedDeploymentId: stagedV2.id,
      expectedDigest: v2.digest,
      fromVersion: 1,
      toVersion: 2,
    });

    const restoredFleet = new MemoryGateFleet(
      JSON.parse(JSON.stringify(memory.exportState())),
    );
    const restored = DemoControl.restore(failedState, restoredFleet);
    const production = await restored.promote({
      stagedDeploymentId: stagedV2.id,
      expectedDigest: v2.digest,
    });

    expect(production.id).toBe(pendingDeploymentId);
    expect(restored.exportState().deployments).toHaveLength(failedState.deployments.length);
    expect(restored.exportState().versions).toHaveLength(failedState.versions.length);
    expect(restored.exportState().environments.production).toMatchObject({
      activeDeploymentId: pendingDeploymentId,
      pendingDeploymentId: null,
    });
    expect(restoredFleet.history()).toEqual([
      { operation: "install", gate: "gateway", environment: "production" },
    ]);
    for (const gate of ["broker", "gateway"] as const) {
      const snapshot = await restoredFleet.snapshot(gate, "production");
      expect(snapshot.installation?.deploymentId).toBe(pendingDeploymentId);
      expect(snapshot.installation?.version).toBe(2);
      expect(snapshot.availability).toEqual({
        defaultEnabled: false,
        overrides: {},
        connectionOverrides: {},
        revision: 1,
      });
    }
  });

  test("describes a partial first promotion from the last active production state", async () => {
    const memory = new MemoryGateFleet();
    const { control } = await boot(memory);
    const { v1 } = await artifacts();
    const staged = await control.publish({ artifact: v1, bindings });
    const failingControl = DemoControl.restore(
      control.exportState(),
      new FailOnceFleet(memory, "gateway", "install"),
    );

    await expect(failingControl.promote({
      stagedDeploymentId: staged.id,
      expectedDigest: v1.digest,
    })).rejects.toThrow("injected gateway failure");

    expect((await failingControl.view()).readyForProduction).toEqual({
      stagedDeploymentId: staged.id,
      expectedDigest: v1.digest,
      fromVersion: null,
      toVersion: 1,
      diff: {
        added: v1.tools.map((tool) => tool.name).sort(),
        removed: [],
      },
    });
  });

  test("keeps the production key identity stable while v2 remains staged until exact promotion", async () => {
    const fleet = new MemoryGateFleet();
    const { control } = await boot(fleet);
    const { v1, v2 } = await artifacts();
    const stagedV1 = await control.publish({ artifact: v1, bindings });
    await control.promote({ stagedDeploymentId: stagedV1.id, expectedDigest: v1.digest });
    const productionFingerprint = (await control.view()).angel.environments.production.keyFingerprint;

    await control.changeAvailability("production", { kind: "all", enabled: false });
    const stagedV2 = await control.publish({ artifact: v2, bindings });
    let view = await control.view();
    expect(view.angel.environments.staging).toMatchObject({ version: 2, digest: v2.digest });
    expect(view.angel.environments.production).toMatchObject({
      version: 1,
      digest: v1.digest,
      keyFingerprint: productionFingerprint,
      availability: { defaultEnabled: false },
    });

    await control.promote({ stagedDeploymentId: stagedV2.id, expectedDigest: v2.digest });
    view = await control.view();
    expect(view.angel.environments.production.keyFingerprint).toBe(productionFingerprint);
    expect(view.angel.environments.production.version).toBe(2);
    expect(view.angel.environments.production.tools.find(
      (tool) => tool.name === "gmail.users.labels.list",
    )?.available).toBe(false);
    expect(view.angel.environments.staging.tools.find(
      (tool) => tool.name === "gmail.users.labels.list",
    )?.available).toBe(true);
  });

  test("freezes and resumes one environment through broker then gateway", async () => {
    const fleet = new MemoryGateFleet();
    const { control } = await boot(fleet);
    const { v1 } = await artifacts();
    const staged = await control.publish({ artifact: v1, bindings });
    await control.promote({ stagedDeploymentId: staged.id, expectedDigest: v1.digest });

    await control.changeAvailability("staging", { kind: "tool", tool: v1.tools[0]!.name, enabled: false });
    expect(fleet.history().slice(-2).map((entry) => `${entry.operation}:${entry.gate}`))
      .toEqual(["availability:broker", "availability:gateway"]);
    let view = await control.view();
    expect(view.angel.environments.staging.tools.find(
      (tool) => tool.name === v1.tools[0]!.name,
    )?.available).toBe(false);
    expect(view.angel.environments.production.tools.find(
      (tool) => tool.name === v1.tools[0]!.name,
    )?.available).toBe(true);

    await control.changeAvailability("staging", { kind: "all", enabled: false });
    await control.changeAvailability("staging", { kind: "tool", tool: v1.tools[0]!.name, enabled: true });
    view = await control.view();
    expect(view.angel.environments.staging.availability.defaultEnabled).toBe(false);
    expect(view.angel.environments.staging.tools.find(
      (tool) => tool.name === v1.tools[0]!.name,
    )?.available).toBe(true);
  });

  test("repairs a one-gate availability failure on retry without advancing the repaired gate twice", async () => {
    const memory = new MemoryGateFleet();
    const fleet = new FailOnceFleet(memory, "gateway", "availability");
    const { control } = await boot(fleet);
    const { v1 } = await artifacts();
    await control.publish({ artifact: v1, bindings });
    const target = v1.tools[0]!.name;

    await expect(control.changeAvailability("staging", { kind: "tool", tool: target, enabled: false }))
      .rejects.toThrow("injected gateway failure");
    expect((await memory.snapshot("broker", "staging")).availability).toEqual({
      defaultEnabled: true,
      overrides: { [target]: false },
      connectionOverrides: {},
      revision: 1,
    });
    expect((await memory.snapshot("gateway", "staging")).availability).toEqual({
      defaultEnabled: true,
      overrides: {},
      connectionOverrides: {},
      revision: 0,
    });
    const partial = (await control.view()).angel.environments.staging;
    expect(partial.gateAlignment).toEqual({
      installation: "aligned",
      availability: "mismatched",
    });
    expect(partial.pendingAvailabilityRepair).toEqual({ action: "pause_tool", tool: target });
    expect(partial.availability).toEqual({
      defaultEnabled: true,
      overrides: { [target]: false },
      connectionOverrides: {},
      revision: 1,
    });
    expect(partial.tools.every((tool) => !tool.available)).toBe(true);

    await memory.change("gateway", "staging", {
      kind: "tool",
      tool: target,
      enabled: false,
      expectedRevision: 0,
    });
    const convergedWithPendingIntent = (await control.view()).angel.environments.staging;
    expect(convergedWithPendingIntent.gateAlignment).toEqual({
      installation: "aligned",
      availability: "aligned",
    });
    expect(convergedWithPendingIntent.pendingAvailabilityRepair).toEqual({
      action: "pause_tool",
      tool: target,
    });

    await control.changeAvailability("staging", { kind: "tool", tool: target, enabled: false });

    const broker = (await memory.snapshot("broker", "staging")).availability;
    const gateway = (await memory.snapshot("gateway", "staging")).availability;
    expect(broker).toEqual({
      defaultEnabled: true,
      overrides: { [target]: false },
      connectionOverrides: {},
      revision: 1,
    });
    expect(gateway).toEqual(broker);
    expect(control.exportState().environments.staging.pendingAvailability).toBeNull();
    const repaired = (await control.view()).angel.environments.staging;
    expect(repaired.gateAlignment).toEqual({
      installation: "aligned",
      availability: "aligned",
    });
    expect(repaired.pendingAvailabilityRepair).toBeNull();
    expect(repaired.tools.find((tool) => tool.name === target)?.available).toBe(false);
    expect(repaired.tools.filter((tool) => tool.name !== target).every((tool) => tool.available)).toBe(true);
  });

  test("reports changed availability between Gateway allow and Broker deny as a convergence failure", async () => {
    const fleet = new MemoryGateFleet();
    const { control, keys } = await boot(fleet);
    const { v1 } = await artifacts();
    await control.publish({ artifact: v1, bindings });
    const tool = v1.tools[0]!.name;
    const input: GateEvaluationInput = {
      requestId: "req_broker_denied_after_gateway_allow",
      tool,
      arguments: {},
    };

    await fleet.evaluate("gateway", "staging", { ...input, presentedKey: keys.staging });
    await fleet.change("broker", "staging", {
      kind: "tool",
      tool,
      enabled: false,
      expectedRevision: 0,
    });
    await fleet.evaluate("broker", "staging", input);

    expect((await control.view()).activity).toContainEqual(expect.objectContaining({
      requestId: input.requestId,
      decision: "deny",
      detail: "gate receipt mismatch: availabilityDigest differs between gateway and broker",
      gateway: expect.objectContaining({ decision: "allow" }),
      broker: expect.objectContaining({ decision: "deny" }),
    }));
  });

  test("retains an identity-matching Broker policy denial as the aggregate decision", async () => {
    const fleet = new MemoryGateFleet();
    const { control, keys } = await boot(fleet);
    const { v1 } = await artifacts();
    await control.publish({ artifact: v1, bindings });
    const tool = "gmail.users.messages.list";
    const requestId = "req_matching_broker_denial";

    const gateway = await fleet.evaluate("gateway", "staging", {
      requestId,
      presentedKey: keys.staging,
      tool,
      arguments: { maxResults: 5 },
    });
    const broker = await fleet.evaluate("broker", "staging", {
      requestId,
      tool,
      arguments: { maxResults: 6 },
    });
    expect(gateway.allowed).toBe(true);
    expect(broker.allowed).toBe(false);

    expect((await control.view()).activity).toContainEqual(expect.objectContaining({
      requestId,
      decision: "deny",
      detail: "argGuard: maxResults is pinned to 5",
      gateway: expect.objectContaining({ decision: "allow" }),
      broker: expect.objectContaining({ decision: "deny" }),
    }));
  });

  test("reports mismatched allowed gate receipts as an aggregate convergence failure", async () => {
    const fleet = new MemoryGateFleet();
    const { control, keys } = await boot(fleet);
    const { v1 } = await artifacts();
    await control.publish({ artifact: v1, bindings });
    const tool = v1.tools[0]!.name;
    const input: GateEvaluationInput = {
      requestId: "req_allowed_receipt_mismatch",
      tool,
      arguments: {},
    };

    const gateway = await fleet.evaluate("gateway", "staging", {
      ...input,
      presentedKey: keys.staging,
    });
    await fleet.change("broker", "staging", {
      kind: "all",
      enabled: true,
      expectedRevision: 0,
    });
    const broker = await fleet.evaluate("broker", "staging", input);
    expect(gateway.allowed).toBe(true);
    expect(broker.allowed).toBe(true);

    expect((await control.view()).activity).toContainEqual(expect.objectContaining({
      requestId: input.requestId,
      decision: "deny",
      detail: "gate receipt mismatch: availabilityDigest differs between gateway and broker",
      gateway: expect.objectContaining({ decision: "allow" }),
      broker: expect.objectContaining({ decision: "allow" }),
    }));
  });

  test("rejects bindings outside the Account or with the wrong credential kind", async () => {
    const { v1 } = await artifacts();
    const outside = await DemoControl.bootstrap({
      ...bootstrapInput,
      connections: [{ ...bootstrapInput.connections[0]!, accountId: "acct_other" }],
      fleet: new MemoryGateFleet(),
    });
    await expect(outside.control.publish({ artifact: v1, bindings }))
      .rejects.toThrow(/Connection belongs to another Account/);

    const wrongKind = await DemoControl.bootstrap({
      ...bootstrapInput,
      connections: [{ ...bootstrapInput.connections[0]!, credential: "bot_token" }],
      fleet: new MemoryGateFleet(),
    });
    await expect(wrongKind.control.publish({ artifact: v1, bindings }))
      .rejects.toThrow(/credential kind/);
  });

  test("surfaces a broker/gateway partial deployment instead of presenting it as active", async () => {
    const memory = new MemoryGateFleet();
    const fleet = new FailOnceFleet(memory, "gateway", "install");
    const { control } = await boot(fleet);
    const { v1 } = await artifacts();

    await expect(control.publish({ artifact: v1, bindings })).rejects.toThrow("injected gateway failure");
    const view = await control.view();
    expect(view.angel.environments.staging).toMatchObject({
      version: 1,
      digest: v1.digest,
      deploymentId: expect.any(String),
    });
    expect(view.angel.environments.staging.tools).not.toHaveLength(0);
    expect(view.angel.environments.staging.tools.every((tool) => !tool.available)).toBe(true);
    expect(view.angel.environments.staging.tools[0]!.guards.join(" ")).toMatch(/gate mismatch/);
  });
});

class FailOnceFleet implements GateFleet {
  private failed = false;

  constructor(
    private readonly inner: GateFleet,
    private readonly failedGate: GateKind,
    private readonly failedOperation: "install" | "availability",
  ) {}

  async install(gate: GateKind, command: GateInstallCommand): Promise<GateInstallation> {
    if (!this.failed && gate === this.failedGate && this.failedOperation === "install") {
      this.failed = true;
      throw new Error("injected gateway failure");
    }
    return this.inner.install(gate, command);
  }

  async change(
    gate: GateKind,
    environment: DeploymentEnvironment,
    command: GateAvailabilityCommand,
  ) {
    if (!this.failed && gate === this.failedGate && this.failedOperation === "availability") {
      this.failed = true;
      throw new Error("injected gateway failure");
    }
    return this.inner.change(gate, environment, command);
  }

  reconcileKeys(
    gate: GateKind,
    environment: DeploymentEnvironment,
    hashes: string[],
  ): Promise<string[]> {
    return this.inner.reconcileKeys(gate, environment, hashes);
  }

  snapshot(gate: GateKind, environment: DeploymentEnvironment): Promise<PolicyGateState> {
    return this.inner.snapshot(gate, environment);
  }

  activity(gate: GateKind, environment: DeploymentEnvironment): Promise<GateReceipt[]> {
    return this.inner.activity(gate, environment);
  }

  reset(gate: GateKind, environment: DeploymentEnvironment): Promise<void> {
    return this.inner.reset(gate, environment);
  }
}
