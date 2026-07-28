import { describe, expect, test } from "bun:test";
import { compileHostedAngel, sha256Hex } from "@smcllns/angel-core";
import { buildDemoView } from "../../src/demo-view";
import type { HostedVersionArtifact } from "../../src/domain";
import type { ManagementConnection } from "../../src/management-contract";
import type {
  GateAvailability,
  GateAvailabilityCommand,
  GateInstallCommand,
  GateInstallation,
  GateKind,
  GateReceipt,
  PolicyGateState,
} from "../../src/gate";
import {
  AesGcmResponseReplayVault,
  ManagementControl,
  ManagementError,
  createManagementState,
  type ManagementDependencies,
  type ResponseReplayVault,
} from "../../src/management";

const account = { id: "acct_personal", name: "Personal" };
const connections = [
  {
    id: "con_personal_google",
    accountId: account.id,
    nickname: "personal-google",
    identityLabel: "sam@example.com",
    credential: "google_oauth" as const,
    providers: ["gmail", "docs"],
    grantedScopes: [
      "https://www.googleapis.com/auth/documents.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    health: "healthy" as const,
  },
  {
    id: "con_work_google",
    accountId: account.id,
    nickname: "work-google",
    identityLabel: "sam@work.example",
    credential: "google_oauth" as const,
    providers: ["gmail"],
    grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    health: "healthy" as const,
  },
];

describe("ManagementControl", () => {
  test("encrypts replay payloads under the dedicated response key", async () => {
    const vault = new AesGcmResponseReplayVault("dedicated-response-replay-key");
    const plaintext = JSON.stringify({ staging: "ak_staging_secret" });

    const ciphertext = await vault.seal(plaintext);

    expect(ciphertext).not.toContain("ak_staging_secret");
    expect(await vault.open(ciphertext)).toBe(plaintext);
    expect(() => new AesGcmResponseReplayVault("")).toThrow("response replay key must be non-empty");
  });

  test("ensures one Angel by Account and slug and replays shown-once keys from ciphertext", async () => {
    const harness = managementHarness();
    const control = harness.control;
    const request = mutation("PUT", "/v1/accounts/acct_personal/angels/golden-assistant", "ensure-1", {});

    const first = await control.ensureAngel(account.id, "golden-assistant", request);
    const replay = await control.ensureAngel(account.id, "golden-assistant", request);
    const serialized = JSON.stringify(control.exportState());

    expect(first).toEqual(replay);
    expect(first.keys).toBeDefined();
    expect(first.angel).toMatchObject({ accountId: account.id, slug: "golden-assistant" });
    expect(first.keys!.staging).toMatch(/^ak_staging_/);
    expect(first.keys!.production).toMatch(/^ak_production_/);
    expect(first.keys!.staging).not.toBe(first.keys!.production);
    expect(serialized).not.toContain(first.keys!.staging);
    expect(serialized).not.toContain(first.keys!.production);
    expect(harness.vault.sealed).toHaveLength(1);
    expect(control.listAngels()).toHaveLength(1);
  });

  test("rejects an idempotency key reused for a different fingerprint", async () => {
    const { control } = managementHarness();
    await control.ensureAngel(
      account.id,
      "first",
      mutation("PUT", "/v1/accounts/acct_personal/angels/first", "same-key", {}),
    );

    await expect(control.ensureAngel(
      account.id,
      "second",
      mutation("PUT", "/v1/accounts/acct_personal/angels/second", "same-key", {}),
    )).rejects.toMatchObject({ status: 409 });
  });

  test("lists only management Connection metadata for its Account", () => {
    const { control } = managementHarness();

    // grantedScopes is hosted state; the contract wire shape omits it.
    expect(control.listConnections(account.id)).toEqual(
      connections.map(({ grantedScopes: _grantedScopes, ...connection }) => connection),
    );
    expect(() => control.listConnections("acct_other")).toThrow(ManagementError);
    expect(() => control.listConnections("acct_other")).toThrow("not found");
  });

  test("re-digests uploaded bytes and publishes one immutable Version per Angel digest", async () => {
    const { control } = managementHarness();
    const ensured = await ensure(control);
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const body = { artifact, expectedDigest: artifact.digest };

    const first = await control.publishVersion(
      ensured.angel.id,
      body,
      mutation("POST", `/v1/angels/${ensured.angel.id}/versions`, "publish-1", body),
    );
    const second = await control.publishVersion(
      ensured.angel.id,
      body,
      mutation("POST", `/v1/angels/${ensured.angel.id}/versions`, "publish-2", body),
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({ number: 1, digest: artifact.digest });
    expect(control.getVersion(ensured.angel.id, first.id)).toEqual(first);

    const forged = { ...artifact, digest: "0".repeat(64) };
    await expect(control.publishVersion(
      ensured.angel.id,
      { artifact: forged, expectedDigest: forged.digest },
      mutation("POST", `/v1/angels/${ensured.angel.id}/versions`, "publish-forged", {
        artifact: forged,
        expectedDigest: forged.digest,
      }),
    )).rejects.toThrow("artifact digest mismatch");
  });

  test("rejects a binding whose Connection grants do not cover the requirement scopes", async () => {
    const { control } = managementHarness();
    const ensured = await ensure(control);
    // drafts.create needs gmail.compose; both fixture connections that lack
    // it must be rejected at deploy, not fail later at Google.
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list", "gmail.users.drafts.create"]),
    ]);
    const version = await publish(control, ensured.angel.id, artifact);
    await expect(stage(control, ensured.angel.id, version, artifact.digest, {
      gmail: ["con_work_google"],
    })).rejects.toThrow(/scope/);
  });

  test("rejects an artifact whose sealed request disagrees with the reviewed registry", async () => {
    const { control } = managementHarness();
    const ensured = await ensure(control);
    const honest = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    // Tamper the sealed request but keep bytes/digest self-consistent so only
    // the registry validation can catch it.
    const content = JSON.parse(honest.canonicalSource) as Record<string, unknown> & { tools: { request: { method: string } }[] };
    content.tools[0]!.request.method = "DELETE";
    const canonicalSource = JSON.stringify(content);
    const tampered = {
      ...content,
      canonicalSource,
      digest: await sha256Hex(canonicalSource),
    } as unknown as HostedVersionArtifact;
    await expect(control.publishVersion(
      ensured.angel.id,
      { artifact: tampered, expectedDigest: tampered.digest },
      mutation("POST", `/v1/angels/${ensured.angel.id}/versions`, "publish-tampered", {
        artifact: tampered,
        expectedDigest: tampered.digest,
      }),
    )).rejects.toThrow(/reviewed spec template/);
  });

  test("rejects deploying a stored pre-v2 Version with a named format error", async () => {
    const { control } = managementHarness();
    const ensured = await ensure(control);
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version = await publish(control, ensured.angel.id, artifact);
    // Simulate a Version published before the v2 migration surviving in state.
    const state = control.exportState();
    const stored = state.versions.find((candidate) => candidate.id === version.id)!;
    (stored.artifact as unknown as Record<string, unknown>).format = "angel.version.v1";
    for (const req of stored.artifact.bindingRequirements) {
      delete (req as unknown as Record<string, unknown>).requiredScopes;
    }
    const restored = ManagementControl.restore(state, managementHarness().dependencies);
    await expect(stage(restored, ensured.angel.id, version, artifact.digest, {
      gmail: ["con_personal_google"],
    })).rejects.toThrow(/unsupported artifact format/);
  });

  test("rejects a self-consistent artifact with no tools", async () => {
    const { control } = managementHarness();
    const ensured = await ensure(control);
    const content = {
      format: "angel.version.v2" as const,
      name: "golden-assistant",
      charter: "empty",
      children: [],
      providers: {},
      bindingRequirements: [],
      tools: [],
    };
    const canonicalSource = JSON.stringify(content);
    const empty = {
      ...content,
      canonicalSource,
      digest: await sha256Hex(canonicalSource),
    } as unknown as HostedVersionArtifact;
    await expect(control.publishVersion(
      ensured.angel.id,
      { artifact: empty, expectedDigest: empty.digest },
      mutation("POST", `/v1/angels/${ensured.angel.id}/versions`, "publish-empty", {
        artifact: empty,
        expectedDigest: empty.digest,
      }),
    )).rejects.toThrow(/tool/);
  });

  test("rejects the retired v1 artifact format", async () => {
    const { control } = managementHarness();
    const ensured = await ensure(control);
    const honest = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const content = JSON.parse(honest.canonicalSource) as Record<string, unknown>;
    content.format = "angel.version.v1";
    const canonicalSource = JSON.stringify(content);
    const v1 = {
      ...content,
      canonicalSource,
      digest: await sha256Hex(canonicalSource),
    } as unknown as HostedVersionArtifact;
    await expect(control.publishVersion(
      ensured.angel.id,
      { artifact: v1, expectedDigest: v1.digest },
      mutation("POST", `/v1/angels/${ensured.angel.id}/versions`, "publish-v1", {
        artifact: v1,
        expectedDigest: v1.digest,
      }),
    )).rejects.toThrow(/format/);
  });

  test("deploys explicit staging bindings Broker first and persists opaque agent-plane refs", async () => {
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
      requirement("docs", "docs", ["docs.documents.get"]),
    ]);
    const version = await publish(harness.control, ensured.angel.id, artifact);
    const body = {
      versionId: version.id,
      expectedDigest: artifact.digest,
      bindings: {
        gmail: ["con_personal_google", "con_work_google"],
        docs: ["con_personal_google"],
      },
    };

    const deployment = await harness.control.deployStaging(
      ensured.angel.id,
      body,
      mutation("POST", `/v1/angels/${ensured.angel.id}/environments/staging/deployments`, "stage-1", body),
    );

    expect(harness.fleets.events).toEqual(["install:broker:staging", "install:gateway:staging"]);
    expect(deployment.bindings).toEqual(body.bindings);
    expect("runtimeBindings" in deployment).toBe(false);
    const installed = harness.control.exportState().deployments.find((entry) => entry.id === deployment.id)!;
    expect(installed.runtimeBindings).toHaveLength(3);
    expect(installed.runtimeBindings.every((binding) => binding.connectionRef.startsWith("arc_"))).toBe(true);
    expect(JSON.stringify(installed.runtimeBindings)).not.toContain("personal-google");
    expect(harness.control.getEnvironment(ensured.angel.id, "staging")).toEqual({
      environment: "staging",
      keyFingerprint: expect.any(String),
      activeDeployment: {
        id: deployment.id,
        versionId: version.id,
        digest: version.digest,
        bindings: body.bindings,
      },
      pendingDeployment: null,
      pendingAvailability: null,
      repair: null,
      availability: {
        defaultEnabled: true,
        toolOverrides: {},
        connectionOverrides: {},
        revision: 0,
      },
    });
  });

  test("rejects a revoked or tombstoned Connection for a new deployment", async () => {
    const harness = managementHarness({
      connections: connections.map((connection) => connection.id === "con_personal_google"
        ? { ...connection, health: "error" as const }
        : connection),
    });
    const ensured = await ensure(harness.control);
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version = await publish(harness.control, ensured.angel.id, artifact);
    const body = {
      versionId: version.id,
      expectedDigest: artifact.digest,
      bindings: { gmail: ["con_personal_google"] },
    };

    await expect(harness.control.deployStaging(
      ensured.angel.id,
      body,
      mutation("POST", `/v1/angels/${ensured.angel.id}/environments/staging/deployments`, "stage-unhealthy", body),
    )).rejects.toMatchObject({ status: 409, message: "Connection for binding gmail is not healthy" });
  });

  test("leaves a failed Gateway install visible and repairs the same pending deployment", async () => {
    const harness = managementHarness({ failGatewayOnce: true });
    const ensured = await ensure(harness.control);
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version = await publish(harness.control, ensured.angel.id, artifact);
    const body = {
      versionId: version.id,
      expectedDigest: version.digest,
      bindings: { gmail: ["con_personal_google"] },
    };
    const call = mutation(
      "POST",
      `/v1/angels/${ensured.angel.id}/environments/staging/deployments`,
      "stage-repair",
      body,
    );

    await expect(harness.control.deployStaging(ensured.angel.id, body, call))
      .rejects.toThrow("injected Gateway failure");
    const pending = harness.control.getEnvironment(ensured.angel.id, "staging");
    expect(pending).toMatchObject({ activeDeployment: null, repair: "gateway" });
    expect(pending.pendingDeployment?.id).toMatch(/^dep_/);

    const repaired = await harness.control.deployStaging(ensured.angel.id, body, call);
    expect(repaired.id).toBe(pending.pendingDeployment!.id);
    expect(harness.fleets.events).toEqual([
      "install:broker:staging",
      "install:gateway:staging",
      "install:gateway:staging",
    ]);
    expect(harness.control.getEnvironment(ensured.angel.id, "staging")).toMatchObject({
      activeDeployment: { id: repaired.id, versionId: version.id, digest: version.digest },
      pendingDeployment: null,
      repair: null,
    });
  });

  test("promotes only the exact staged ID and digest with explicit production bindings", async () => {
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version = await publish(harness.control, ensured.angel.id, artifact);
    const staged = await stage(harness.control, ensured.angel.id, version, artifact.digest, {
      gmail: ["con_personal_google", "con_work_google"],
    });

    const body = {
      stagedDeploymentId: staged.id,
      expectedDigest: staged.digest,
      bindings: { gmail: ["con_work_google"] },
    };
    const production = await harness.control.promoteProduction(
      ensured.angel.id,
      body,
      mutation("POST", `/v1/angels/${ensured.angel.id}/environments/production/promotions`, "prod-1", body),
    );

    expect(production).toMatchObject({ environment: "production", versionId: version.id, digest: staged.digest });
    expect(production.bindings).toEqual({ gmail: ["con_work_google"] });
    expect(harness.fleets.events.slice(-2)).toEqual([
      "install:broker:production",
      "install:gateway:production",
    ]);

    await expect(harness.control.promoteProduction(
      ensured.angel.id,
      { ...body, stagedDeploymentId: "dep_stale" },
      mutation("POST", `/v1/angels/${ensured.angel.id}/environments/production/promotions`, "prod-stale", {
        ...body,
        stagedDeploymentId: "dep_stale",
      }),
    )).rejects.toMatchObject({ status: 409 });
  });

  test("pauses one tool Connection through Broker then Gateway and repairs without exposing runtime refs", async () => {
    const harness = managementHarness({ failGatewayAvailabilityOnce: true });
    const ensured = await ensure(harness.control);
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version = await publish(harness.control, ensured.angel.id, artifact);
    await stage(harness.control, ensured.angel.id, version, artifact.digest, {
      gmail: ["con_personal_google", "con_work_google"],
    });
    const body = {
      kind: "tool_connection" as const,
      tool: "gmail.users.messages.list",
      connectionId: "con_personal_google",
      enabled: false,
    };
    const call = mutation(
      "POST",
      `/v1/angels/${ensured.angel.id}/environments/staging/availability`,
      "pause-personal",
      body,
    );

    await expect(harness.control.changeAvailability(ensured.angel.id, "staging", body, call))
      .rejects.toThrow("injected Gateway availability failure");
    expect(harness.control.getEnvironment(ensured.angel.id, "staging")).toMatchObject({
      repair: "gateway",
      pendingAvailability: body,
    });
    const ownerAngel = JSON.stringify(harness.control.getAngel(ensured.angel.id));
    expect(ownerAngel).not.toContain("arc_");
    expect(ownerAngel).not.toContain("keyHash");
    const redeploy = {
      versionId: version.id,
      expectedDigest: artifact.digest,
      bindings: { gmail: ["con_personal_google", "con_work_google"] },
    };
    await expect(harness.control.deployStaging(
      ensured.angel.id,
      redeploy,
      mutation(
        "POST",
        `/v1/angels/${ensured.angel.id}/environments/staging/deployments`,
        "stage-while-availability-pending",
        redeploy,
      ),
    )).rejects.toMatchObject({ status: 409 });

    const repaired = await harness.control.changeAvailability(ensured.angel.id, "staging", body, call);
    expect(harness.fleets.events.slice(-3)).toEqual([
      "availability:broker:staging",
      "availability:gateway:staging",
      "availability:gateway:staging",
    ]);
    expect(repaired).toEqual({
      defaultEnabled: true,
      toolOverrides: {},
      connectionOverrides: {
        "gmail.users.messages.list": { con_personal_google: false },
      },
      revision: 1,
    });
    expect(JSON.stringify(repaired)).not.toContain("arc_");
    expect(harness.control.getEnvironment(ensured.angel.id, "staging")).toMatchObject({
      repair: null,
      pendingAvailability: null,
      activeDeployment: {
        bindings: { gmail: ["con_personal_google", "con_work_google"] },
      },
      availability: repaired,
    });
  });

  test("keeps a connection-scoped override readable across a promote by remapping refs", async () => {
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const angelId = ensured.angel.id;
    const v1 = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version1 = await publish(harness.control, angelId, v1);
    const staged1 = await stage(harness.control, angelId, version1, v1.digest, {
      gmail: ["con_personal_google", "con_work_google"],
    });
    const promote1 = {
      stagedDeploymentId: staged1.id,
      expectedDigest: staged1.digest,
      bindings: { gmail: ["con_personal_google", "con_work_google"] },
    };
    await harness.control.promoteProduction(
      angelId,
      promote1,
      mutation("POST", `/v1/angels/${angelId}/environments/production/promotions`, "prod-1", promote1),
    );
    const change = {
      kind: "tool_connection" as const,
      tool: "gmail.users.messages.list",
      connectionId: "con_personal_google",
      enabled: false,
    };
    await harness.control.changeAvailability(
      angelId,
      "production",
      change,
      mutation("POST", `/v1/angels/${angelId}/environments/production/availability`, "pause-personal", change),
    );

    const v2 = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list", "gmail.users.labels.list"]),
    ]);
    const version2 = await publish(harness.control, angelId, v2);
    const staged2 = await stage(harness.control, angelId, version2, v2.digest, {
      gmail: ["con_personal_google", "con_work_google"],
    });
    const promote2 = {
      stagedDeploymentId: staged2.id,
      expectedDigest: staged2.digest,
      bindings: { gmail: ["con_personal_google", "con_work_google"] },
    };
    await harness.control.promoteProduction(
      angelId,
      promote2,
      mutation("POST", `/v1/angels/${angelId}/environments/production/promotions`, "prod-2", promote2),
    );

    const environment = harness.control.getEnvironment(angelId, "production");
    expect(environment.availability).toEqual({
      defaultEnabled: true,
      toolOverrides: {},
      connectionOverrides: {
        "gmail.users.messages.list": { con_personal_google: false },
      },
      revision: 1,
    });
    // The stored override is keyed by the NEW active deployment's connectionRef.
    const state = harness.control.exportState();
    const active = state.deployments.find(
      (candidate) => candidate.id === environment.activeDeployment!.id,
    )!;
    const newRef = active.runtimeBindings.find(
      (binding) => binding.tool === "gmail.users.messages.list"
        && binding.connectionId === "con_personal_google",
    )!.connectionRef;
    expect(state.angels[0]!.environments.production.availability.connectionOverrides).toEqual({
      "gmail.users.messages.list": { [newRef]: false },
    });
  });

  test("drops a connection override whose Connection is no longer bound after a promote", async () => {
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const angelId = ensured.angel.id;
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version = await publish(harness.control, angelId, artifact);
    const staged1 = await stage(harness.control, angelId, version, artifact.digest, {
      gmail: ["con_personal_google", "con_work_google"],
    });
    const promote1 = {
      stagedDeploymentId: staged1.id,
      expectedDigest: staged1.digest,
      bindings: { gmail: ["con_personal_google", "con_work_google"] },
    };
    await harness.control.promoteProduction(
      angelId,
      promote1,
      mutation("POST", `/v1/angels/${angelId}/environments/production/promotions`, "prod-1", promote1),
    );
    const change = {
      kind: "tool_connection" as const,
      tool: "gmail.users.messages.list",
      connectionId: "con_personal_google",
      enabled: false,
    };
    await harness.control.changeAvailability(
      angelId,
      "production",
      change,
      mutation("POST", `/v1/angels/${angelId}/environments/production/availability`, "pause-personal", change),
    );

    // Re-stage the same Version, then promote WITHOUT the overridden Connection.
    const body = {
      versionId: version.id,
      expectedDigest: artifact.digest,
      bindings: { gmail: ["con_work_google"] },
    };
    const staged2 = await harness.control.deployStaging(
      angelId,
      body,
      mutation("POST", `/v1/angels/${angelId}/environments/staging/deployments`, "stage-narrow", body),
    );
    const promote2 = {
      stagedDeploymentId: staged2.id,
      expectedDigest: staged2.digest,
      bindings: { gmail: ["con_work_google"] },
    };
    await harness.control.promoteProduction(
      angelId,
      promote2,
      mutation("POST", `/v1/angels/${angelId}/environments/production/promotions`, "prod-2", promote2),
    );

    const environment = harness.control.getEnvironment(angelId, "production");
    expect(environment.availability).toEqual({
      defaultEnabled: true,
      toolOverrides: {},
      connectionOverrides: {},
      revision: 1,
    });
  });

  test("returns tenant-safe not found for Angel resources outside the Account", async () => {
    const { control } = managementHarness();
    await ensure(control);

    expect(() => control.getAngel("ang_missing")).toThrow(ManagementError);
    expect(() => control.getAngel("ang_missing")).toThrow("not found");
    expect(() => control.getEnvironment("ang_missing", "staging")).toThrow("not found");
  });
});

const MANAGEMENT_NOW = "2026-07-22T12:00:00.000Z";

function managementHarness(options: {
  failGatewayOnce?: boolean;
  failGatewayAvailabilityOnce?: boolean;
  connections?: ManagementConnection[];
  now?: () => string;
} = {}) {
  const vault = new MemoryReplayVault();
  const fleets = new FakeFleetFactory(
    options.failGatewayOnce ?? false,
    options.failGatewayAvailabilityOnce ?? false,
  );
  let sequence = 0;
  const dependencies: ManagementDependencies = {
    replayVault: vault,
    fleetFor: (angelId) => fleets.forAngel(angelId),
    randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
    checkpoint: { persist: async () => {} },
    now: options.now ?? (() => MANAGEMENT_NOW),
  };
  const control = ManagementControl.restore(
    createManagementState({ account, connections: options.connections ?? connections }),
    dependencies,
  );
  return { control, vault, fleets, dependencies };
}

class MemoryReplayVault implements ResponseReplayVault {
  readonly sealed: string[] = [];

  async seal(plaintext: string): Promise<string> {
    const ciphertext = `sealed:${btoa(plaintext)}`;
    this.sealed.push(ciphertext);
    return ciphertext;
  }

  async open(ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith("sealed:")) throw new Error("invalid ciphertext");
    return atob(ciphertext.slice("sealed:".length));
  }
}

class FakeFleetFactory {
  readonly events: string[] = [];
  private readonly fleets = new Map<string, FakeFleet>();

  constructor(
    private failGatewayOnce: boolean,
    private failGatewayAvailabilityOnce: boolean,
  ) {}

  forAngel(angelId: string): FakeFleet {
    let fleet = this.fleets.get(angelId);
    if (!fleet) {
      fleet = new FakeFleet(this.events, this.failGatewayOnce, this.failGatewayAvailabilityOnce);
      this.failGatewayOnce = false;
      this.failGatewayAvailabilityOnce = false;
      this.fleets.set(angelId, fleet);
    }
    return fleet;
  }
}

class FakeFleet {
  private readonly installations = new Map<string, GateInstallation>();
  private readonly availability = new Map<string, GateAvailability>();
  readonly keyHashes = new Map<string, string[]>();

  constructor(
    private readonly events: string[],
    private failGatewayOnce: boolean,
    private failGatewayAvailabilityOnce: boolean,
  ) {}

  async reset(): Promise<void> {}

  async reconcileKeys(
    gate: GateKind,
    environment: "staging" | "production",
    hashes: string[],
  ): Promise<string[]> {
    this.events.push(`reconcile_keys:${gate}:${environment}`);
    this.keyHashes.set(`${gate}:${environment}`, [...hashes]);
    return [...hashes];
  }

  async install(gate: GateKind, command: GateInstallCommand): Promise<GateInstallation> {
    this.events.push(`install:${gate}:${command.environment}`);
    if (gate === "gateway" && this.failGatewayOnce) {
      this.failGatewayOnce = false;
      throw new Error("injected Gateway failure");
    }
    const installation = {
      ...command,
      gate,
      policyDigest: command.artifact.digest,
      bindingsDigest: "f".repeat(64),
    } as GateInstallation;
    this.installations.set(`${gate}:${command.environment}`, installation);
    return structuredClone(installation);
  }

  async snapshot(gate: GateKind, environment: "staging" | "production"): Promise<PolicyGateState> {
    return {
      schemaVersion: 1,
      gate,
      identity: null,
      installation: structuredClone(this.installations.get(`${gate}:${environment}`) ?? null),
      gatewayKeyHash: null,
      availability: structuredClone(this.availability.get(`${gate}:${environment}`) ?? {
        defaultEnabled: true,
        overrides: {},
        connectionOverrides: {},
        revision: 0,
      }),
      deploymentFingerprints: {},
      receipts: [],
      checkpoint: "0".repeat(64),
    };
  }

  async change(
    gate: GateKind,
    environment: "staging" | "production",
    command: GateAvailabilityCommand,
  ): Promise<GateAvailability> {
    this.events.push(`availability:${gate}:${environment}`);
    if (gate === "gateway" && this.failGatewayAvailabilityOnce) {
      this.failGatewayAvailabilityOnce = false;
      throw new Error("injected Gateway availability failure");
    }
    const current = (await this.snapshot(gate, environment)).availability;
    let next: GateAvailability;
    if (command.kind === "all") {
      next = {
        defaultEnabled: command.enabled,
        overrides: {},
        connectionOverrides: {},
        revision: current.revision + 1,
      };
    } else if (command.kind === "tool") {
      next = {
        ...current,
        overrides: { ...current.overrides, [command.tool]: command.enabled },
        revision: current.revision + 1,
      };
    } else {
      next = {
        ...current,
        connectionOverrides: {
          ...current.connectionOverrides,
          [command.tool]: {
            ...current.connectionOverrides[command.tool],
            [command.connectionRef]: command.enabled,
          },
        },
        revision: current.revision + 1,
      };
    }
    this.availability.set(`${gate}:${environment}`, next);
    return structuredClone(next);
  }

  async activity(): Promise<GateReceipt[]> {
    return [];
  }
}

function mutation(method: string, path: string, idempotencyKey: string, body: unknown) {
  return { method, path, idempotencyKey, body };
}

async function ensure(control: ManagementControl) {
  return control.ensureAngel(
    account.id,
    "golden-assistant",
    mutation("PUT", "/v1/accounts/acct_personal/angels/golden-assistant", "ensure", {}),
  );
}

async function publish(control: ManagementControl, angelId: string, artifact: HostedVersionArtifact) {
  const body = { artifact, expectedDigest: artifact.digest };
  return control.publishVersion(
    angelId,
    body,
    mutation("POST", `/v1/angels/${angelId}/versions`, `publish-${artifact.digest}`, body),
  );
}

async function stage(
  control: ManagementControl,
  angelId: string,
  version: { id: string },
  expectedDigest: string,
  bindings: Record<string, string[]>,
) {
  const body = { versionId: version.id, expectedDigest, bindings };
  return control.deployStaging(
    angelId,
    body,
    mutation("POST", `/v1/angels/${angelId}/environments/staging/deployments`, `stage-${version.id}`, body),
  );
}

function requirement(id: string, provider: string, tools: string[]) {
  return { id, source: id, provider, credential: "google_oauth" as const, tools };
}

async function versionArtifact(
  name: string,
  bindingRequirements: ReturnType<typeof requirement>[],
): Promise<HostedVersionArtifact> {
  // Real compilation keeps every fixture a faithful v2 artifact — sealed
  // requests, providers block, and spec-derived requiredScopes included.
  const tools = bindingRequirements.flatMap((entry) => entry.tools);
  const yaml = [
    `name: ${name}`,
    "charter: deterministic management fixture",
    "tools:",
    ...tools.map((tool) => `  - tool: ${tool}`),
  ].join("\n");
  return await compileHostedAngel(yaml);
}

describe("ManagementControl recorded timestamps", () => {
  test("stamps recorded ISO times on publish, deploy, and availability change", async () => {
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const angelId = ensured.angel.id;
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version = await publish(harness.control, angelId, artifact);
    await stage(harness.control, angelId, version, artifact.digest, {
      gmail: ["con_personal_google"],
    });

    const state = harness.control.exportState();
    // Version publish time is keyed by the Version id; deploy time by the Deployment id.
    expect(state.timestamps![version.id]).toBe(MANAGEMENT_NOW);
    const deployment = state.deployments[0]!;
    expect(state.timestamps![deployment.id]).toBe(MANAGEMENT_NOW);

    await harness.control.changeAvailability(
      angelId,
      "staging",
      { kind: "all", enabled: false },
      mutation("POST", `/v1/angels/${angelId}/environments/staging/availability`, "avail-1", {
        kind: "all",
        enabled: false,
      }),
    );
    expect(
      harness.control.exportState().angels[0]!.environments.staging.availabilityChangedAt,
    ).toBe(MANAGEMENT_NOW);
  });

  test("a state persisted without timestamps records nothing (events stay derived)", async () => {
    const seed = managementHarness();
    const ensured = await ensure(seed.control);
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version = await publish(seed.control, ensured.angel.id, artifact);
    await stage(seed.control, ensured.angel.id, version, artifact.digest, {
      gmail: ["con_personal_google"],
    });
    const legacy = seed.control.exportState();
    delete legacy.timestamps; // emulate a state persisted before named-timestamp support

    const control = ManagementControl.restore(legacy, freshDependencies(seed));
    const restored = control.exportState();
    // Nothing is back-filled: the timestamps map is empty after migration.
    expect(restored.timestamps).toEqual({});
  });

  test("stamps a deployment at CONVERGENCE, not at a failed attempt that was later repaired", async () => {
    let clock = "2026-07-22T00:00:00.000Z"; // T0 — the (failing) first attempt
    const harness = managementHarness({ failGatewayOnce: true, now: () => clock });
    const ensured = await ensure(harness.control);
    const angelId = ensured.angel.id;
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version = await publish(harness.control, angelId, artifact);
    const body = {
      versionId: version.id,
      expectedDigest: version.digest,
      bindings: { gmail: ["con_personal_google"] },
    };
    const stageMutation = mutation(
      "POST",
      `/v1/angels/${angelId}/environments/staging/deployments`,
      "stage-1",
      body,
    );

    // The first attempt fails at the Gateway, BEFORE the deployment converges.
    await expect(harness.control.deployStaging(angelId, body, stageMutation))
      .rejects.toThrow(/injected Gateway failure/);
    // The pending, never-effective deployment carries no recorded time yet.
    const afterFailure = harness.control.exportState();
    expect(afterFailure.timestamps![afterFailure.deployments[0]!.id]).toBeUndefined();

    // Advance the clock, then repair by retrying the SAME command.
    clock = "2026-07-22T05:00:00.000Z"; // T1 — convergence
    await harness.control.deployStaging(angelId, body, stageMutation);

    const state = harness.control.exportState();
    const deployment = state.deployments[0]!;
    // The recorded time reflects when the deployment became effective (T1), never
    // the failed attempt (T0).
    expect(state.timestamps![deployment.id]).toBe("2026-07-22T05:00:00.000Z");

    const view = await buildDemoView(
      state,
      (aid) => harness.fleets.forAngel(aid),
      { gatewayBaseUrl: "https://gw.test" },
    );
    const deployEvent = view.angels[0]!.environments.staging.lifecycle.find(
      (event) => event.kind === "staging_deploy",
    )!;
    expect(deployEvent).toMatchObject({ source: "recorded", at: "2026-07-22T05:00:00.000Z" });
  });
});

describe("ManagementControl named keys", () => {
  function keyPath(angelId: string, environment: string, suffix = ""): string {
    return `/v1/angels/${angelId}/environments/${environment}/keys${suffix}`;
  }

  test("mints a Default key per environment on ensure without leaking a hash", async () => {
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const keys = harness.control.listKeys(ensured.angel.id, "staging");
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      name: "Default key",
      status: "active",
      createdAt: MANAGEMENT_NOW,
      revokedAt: null,
    });
    expect(JSON.stringify(keys)).not.toContain("hash");
  });

  test("create_key returns plaintext once, stores only the hash, and replays identically", async () => {
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const angelId = ensured.angel.id;
    const body = { name: "CI deploy key" };
    const created = await harness.control.createKey(
      angelId,
      "staging",
      body,
      mutation("POST", keyPath(angelId, "staging"), "create-ci", body),
    );
    expect(created.plaintext).toMatch(/^ak_staging_/);
    expect(created.key).toMatchObject({ name: "CI deploy key", status: "active", revokedAt: null });

    // The state stores the hash of the plaintext; the returned view never does.
    const createdHash = await sha256Hex(created.plaintext);
    const stored = harness.control.exportState().angels[0]!.environments.staging.keys!;
    expect(stored.some((key) => key.hash === createdHash)).toBe(true);
    expect(JSON.stringify(created.key)).not.toContain(createdHash);

    // Idempotent replay: identical response including the SAME plaintext (from the
    // encrypted replay vault) — never a freshly minted secret.
    const replay = await harness.control.createKey(
      angelId,
      "staging",
      body,
      mutation("POST", keyPath(angelId, "staging"), "create-ci", body),
    );
    expect(replay).toEqual(created);

    // The gateway received the full active set (Default key + the new key).
    const pushed = harness.fleets.forAngel(angelId).keyHashes.get("gateway:staging")!;
    expect(pushed).toHaveLength(2);
    expect(pushed).toContain(await sha256Hex(created.plaintext));
  });

  test("rotate_key mints a replacement, revokes the old atomically, and drops it from the gate", async () => {
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const angelId = ensured.angel.id;
    const created = await harness.control.createKey(
      angelId,
      "production",
      { name: "agent" },
      mutation("POST", keyPath(angelId, "production"), "c1", { name: "agent" }),
    );
    const rotateBody = { keyId: created.key.id };
    const rotated = await harness.control.rotateKey(
      angelId,
      "production",
      rotateBody,
      mutation("POST", keyPath(angelId, "production", `/${created.key.id}/rotations`), "rot1", rotateBody),
    );
    expect(rotated.revokedKeyId).toBe(created.key.id);
    expect(rotated.plaintext).toMatch(/^ak_production_/);
    expect(rotated.plaintext).not.toBe(created.plaintext);

    const keys = harness.control.listKeys(angelId, "production");
    expect(keys.find((key) => key.id === created.key.id)).toMatchObject({
      status: "revoked",
      revokedAt: MANAGEMENT_NOW,
    });
    expect(keys.find((key) => key.id === rotated.key.id)).toMatchObject({ status: "active" });

    const pushed = harness.fleets.forAngel(angelId).keyHashes.get("gateway:production")!;
    expect(pushed).toContain(await sha256Hex(rotated.plaintext));
    expect(pushed).not.toContain(await sha256Hex(created.plaintext));
  });

  test("revoke_key marks the key revoked and removes it from the gateway active set", async () => {
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const angelId = ensured.angel.id;
    const created = await harness.control.createKey(
      angelId,
      "staging",
      { name: "temp" },
      mutation("POST", keyPath(angelId, "staging"), "c1", { name: "temp" }),
    );
    const revokeBody = { keyId: created.key.id };
    const revoked = await harness.control.revokeKey(
      angelId,
      "staging",
      revokeBody,
      mutation("POST", keyPath(angelId, "staging", `/${created.key.id}/revocations`), "rev1", revokeBody),
    );
    expect(revoked.key).toMatchObject({
      id: created.key.id,
      status: "revoked",
      revokedAt: MANAGEMENT_NOW,
    });

    const pushed = harness.fleets.forAngel(angelId).keyHashes.get("gateway:staging")!;
    expect(pushed).not.toContain(await sha256Hex(created.plaintext));
    expect(pushed).toHaveLength(1); // only the Default key remains active
  });

  test("refuses to revoke the last active key or rotate a revoked key", async () => {
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const angelId = ensured.angel.id;
    const defaultKeyId = harness.control.listKeys(angelId, "staging")[0]!.id;
    await expect(harness.control.revokeKey(
      angelId,
      "staging",
      { keyId: defaultKeyId },
      mutation("POST", keyPath(angelId, "staging", `/${defaultKeyId}/revocations`), "rev-last", { keyId: defaultKeyId }),
    )).rejects.toThrow(/last active key/);

    const created = await harness.control.createKey(
      angelId,
      "staging",
      { name: "t" },
      mutation("POST", keyPath(angelId, "staging"), "c1", { name: "t" }),
    );
    await harness.control.revokeKey(
      angelId,
      "staging",
      { keyId: created.key.id },
      mutation("POST", keyPath(angelId, "staging", `/${created.key.id}/revocations`), "rev1", { keyId: created.key.id }),
    );
    await expect(harness.control.rotateKey(
      angelId,
      "staging",
      { keyId: created.key.id },
      mutation("POST", keyPath(angelId, "staging", `/${created.key.id}/rotations`), "rot1", { keyId: created.key.id }),
    )).rejects.toThrow(/revoked key cannot be rotated/);
  });

  test("migrates a legacy single-key environment into a Default key on restore", async () => {
    const seed = managementHarness();
    const ensured = await ensure(seed.control);
    const legacy = seed.control.exportState();
    const environment = legacy.angels[0]!.environments.staging;
    const legacyFingerprint = environment.keyFingerprint;
    // Emulate a state persisted before named keys existed.
    for (const env of ["staging", "production"] as const) {
      delete legacy.angels[0]!.environments[env].keys;
    }

    const control = ManagementControl.restore(legacy, freshDependencies(seed));
    const keys = control.listKeys(ensured.angel.id, "staging");
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      name: "Default key",
      status: "active",
      fingerprint: legacyFingerprint,
      // No createdAt is fabricated for a key whose real mint time was never recorded.
      createdAt: null,
      revokedAt: null,
    });
  });

  test("a fresh revoke of an already-revoked key fails loud; an idempotent replay returns the original success", async () => {
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const angelId = ensured.angel.id;
    const created = await harness.control.createKey(
      angelId,
      "staging",
      { name: "temp" },
      mutation("POST", keyPath(angelId, "staging"), "c1", { name: "temp" }),
    );
    const revokePath = keyPath(angelId, "staging", `/${created.key.id}/revocations`);
    const revokeMutation = mutation("POST", revokePath, "rev1", { keyId: created.key.id });

    const first = await harness.control.revokeKey(angelId, "staging", { keyId: created.key.id }, revokeMutation);
    expect(first.key).toMatchObject({ id: created.key.id, status: "revoked" });

    // Idempotent replay of the ORIGINAL revoke (same Idempotency-Key) returns the
    // identical original success — never a fresh error.
    const replay = await harness.control.revokeKey(angelId, "staging", { keyId: created.key.id }, revokeMutation);
    expect(replay).toEqual(first);

    // A FRESH revoke (new Idempotency-Key) of the already-revoked key is a hard error.
    await expect(harness.control.revokeKey(
      angelId,
      "staging",
      { keyId: created.key.id },
      mutation("POST", revokePath, "rev2", { keyId: created.key.id }),
    )).rejects.toThrow(/already revoked/);
  });
});

function freshDependencies(harness: ReturnType<typeof managementHarness>): ManagementDependencies {
  let sequence = 0;
  return {
    replayVault: new MemoryReplayVault(),
    fleetFor: (angelId) => harness.fleets.forAngel(angelId),
    randomId: (prefix) => `${prefix}_restored_${String(++sequence).padStart(4, "0")}`,
    checkpoint: { persist: async () => {} },
    now: () => MANAGEMENT_NOW,
  };
}
