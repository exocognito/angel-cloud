import { describe, expect, test } from "bun:test";
import { canonicalJson, compileHostedAngel, sha256Hex } from "@smcllns/angel-core";
import { MemoryGateFleet } from "../../src/control";
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
    const plaintext = JSON.stringify({ preview: "ak_preview_secret" });

    const ciphertext = await vault.seal(plaintext);

    expect(ciphertext).not.toContain("ak_preview_secret");
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
    expect(first.keys!.preview).toMatch(/^ak_preview_/);
    expect(first.keys!.production).toMatch(/^ak_production_/);
    expect(first.keys!.preview).not.toBe(first.keys!.production);
    expect(serialized).not.toContain(first.keys!.preview);
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

  test("deploys explicit preview bindings Broker first and persists opaque agent-plane refs", async () => {
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

    const deployment = await harness.control.deployPreview(
      ensured.angel.id,
      body,
      mutation("POST", `/v1/angels/${ensured.angel.id}/environments/preview/deployments`, "stage-1", body),
    );

    expect(harness.fleets.events).toEqual(["install:broker:preview", "install:gateway:preview"]);
    expect(deployment.bindings).toEqual(body.bindings);
    expect("runtimeBindings" in deployment).toBe(false);
    const installed = harness.control.exportState().deployments.find((entry) => entry.id === deployment.id)!;
    expect(installed.runtimeBindings).toHaveLength(3);
    expect(installed.runtimeBindings.every((binding) => binding.connectionRef.startsWith("arc_"))).toBe(true);
    expect(JSON.stringify(installed.runtimeBindings)).not.toContain("personal-google");
    expect(harness.control.getEnvironment(ensured.angel.id, "preview")).toEqual({
      environment: "preview",
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

    await expect(harness.control.deployPreview(
      ensured.angel.id,
      body,
      mutation("POST", `/v1/angels/${ensured.angel.id}/environments/preview/deployments`, "stage-unhealthy", body),
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
      `/v1/angels/${ensured.angel.id}/environments/preview/deployments`,
      "stage-repair",
      body,
    );

    await expect(harness.control.deployPreview(ensured.angel.id, body, call))
      .rejects.toThrow("injected Gateway failure");
    const pending = harness.control.getEnvironment(ensured.angel.id, "preview");
    expect(pending).toMatchObject({ activeDeployment: null, repair: "gateway" });
    expect(pending.pendingDeployment?.id).toMatch(/^dep_/);

    const repaired = await harness.control.deployPreview(ensured.angel.id, body, call);
    expect(repaired.id).toBe(pending.pendingDeployment!.id);
    expect(harness.fleets.events).toEqual([
      "install:broker:preview",
      "install:gateway:preview",
      "install:gateway:preview",
    ]);
    expect(harness.control.getEnvironment(ensured.angel.id, "preview")).toMatchObject({
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
      `/v1/angels/${ensured.angel.id}/environments/preview/availability`,
      "pause-personal",
      body,
    );

    await expect(harness.control.changeAvailability(ensured.angel.id, "preview", body, call))
      .rejects.toThrow("injected Gateway availability failure");
    expect(harness.control.getEnvironment(ensured.angel.id, "preview")).toMatchObject({
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
    await expect(harness.control.deployPreview(
      ensured.angel.id,
      redeploy,
      mutation(
        "POST",
        `/v1/angels/${ensured.angel.id}/environments/preview/deployments`,
        "stage-while-availability-pending",
        redeploy,
      ),
    )).rejects.toMatchObject({ status: 409 });

    const repaired = await harness.control.changeAvailability(ensured.angel.id, "preview", body, call);
    expect(harness.fleets.events.slice(-3)).toEqual([
      "availability:broker:preview",
      "availability:gateway:preview",
      "availability:gateway:preview",
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
    expect(harness.control.getEnvironment(ensured.angel.id, "preview")).toMatchObject({
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
    const staged2 = await harness.control.deployPreview(
      angelId,
      body,
      mutation("POST", `/v1/angels/${angelId}/environments/preview/deployments`, "stage-narrow", body),
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

  test("restores a state left dangling by a pre-fix promote to readable, gate-matching availability", async () => {
    // Build a healthy promoted environment with an override, then re-key the
    // stored override to the ref of a non-active deployment — the exact state
    // a pre-fix promote persisted (issue #1). The gates pruned their copy of
    // the override at that install, so restore must drop it, not resurrect it.
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const angelId = ensured.angel.id;
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version = await publish(harness.control, angelId, artifact);
    const staged = await stage(harness.control, angelId, version, artifact.digest, {
      gmail: ["con_personal_google"],
    });
    const promote = {
      stagedDeploymentId: staged.id,
      expectedDigest: staged.digest,
      bindings: { gmail: ["con_personal_google"] },
    };
    await harness.control.promoteProduction(
      angelId,
      promote,
      mutation("POST", `/v1/angels/${angelId}/environments/production/promotions`, "prod-1", promote),
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

    const damaged = harness.control.exportState();
    const production = damaged.angels[0]!.environments.production;
    const stagingRef = damaged.deployments.find((candidate) => candidate.id === staged.id)!
      .runtimeBindings[0]!.connectionRef;
    // The preview deployment's ref is never active in production — like the old
    // production deployment's ref after a pre-fix promote.
    production.availability.connectionOverrides = {
      "gmail.users.messages.list": { [stagingRef]: false },
    };

    const restored = ManagementControl.restore(damaged, freshDependencies(harness));
    const environment = restored.getEnvironment(angelId, "production");
    expect(environment.availability).toEqual({
      defaultEnabled: true,
      toolOverrides: {},
      connectionOverrides: {},
      revision: 1,
    });
  });

  test("management and real gates hold byte-identical availability after a promote with overrides", async () => {
    // The forward fix rests on management and the gates running the SAME
    // migration: if their availability ever diverges, the next
    // changeAvailability fails to reconcile. Run the incident flow against
    // real PolicyGates and pin the invariant.
    const fleet = new MemoryGateFleet();
    const vault = new MemoryReplayVault();
    let sequence = 0;
    const control = ManagementControl.restore(
      createManagementState({ account, connections }),
      {
        replayVault: vault,
        fleetFor: () => fleet,
        randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
        checkpoint: { persist: async () => {} },
        now: () => MANAGEMENT_NOW,
      },
    );
    const ensured = await ensure(control);
    const angelId = ensured.angel.id;
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version = await publish(control, angelId, artifact);
    const staged = await stage(control, angelId, version, artifact.digest, {
      gmail: ["con_personal_google", "con_work_google"],
    });
    const promote1 = {
      stagedDeploymentId: staged.id,
      expectedDigest: staged.digest,
      bindings: { gmail: ["con_personal_google", "con_work_google"] },
    };
    await control.promoteProduction(
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
    await control.changeAvailability(
      angelId,
      "production",
      change,
      mutation("POST", `/v1/angels/${angelId}/environments/production/availability`, "pause-personal", change),
    );

    const body = {
      versionId: version.id,
      expectedDigest: artifact.digest,
      bindings: { gmail: ["con_personal_google", "con_work_google"] },
    };
    const restaged = await control.deployPreview(
      angelId,
      body,
      mutation("POST", `/v1/angels/${angelId}/environments/preview/deployments`, "restage", body),
    );
    const promote2 = {
      stagedDeploymentId: restaged.id,
      expectedDigest: restaged.digest,
      bindings: { gmail: ["con_personal_google", "con_work_google"] },
    };
    await control.promoteProduction(
      angelId,
      promote2,
      mutation("POST", `/v1/angels/${angelId}/environments/production/promotions`, "prod-2", promote2),
    );

    const stored = control.exportState().angels[0]!.environments.production.availability;
    expect(Object.keys(stored.connectionOverrides)).toEqual(["gmail.users.messages.list"]);
    for (const gate of ["broker", "gateway"] as const) {
      expect(canonicalJson((await fleet.snapshot(gate, "production")).availability))
        .toBe(canonicalJson(stored));
    }

    // A follow-up availability change must still reconcile end to end.
    const followUp = {
      kind: "tool_connection" as const,
      tool: "gmail.users.messages.list",
      connectionId: "con_work_google",
      enabled: false,
    };
    const view = await control.changeAvailability(
      angelId,
      "production",
      followUp,
      mutation("POST", `/v1/angels/${angelId}/environments/production/availability`, "pause-work", followUp),
    );
    expect(view.connectionOverrides).toEqual({
      "gmail.users.messages.list": { con_personal_google: false, con_work_google: false },
    });
  });

  test("restore also repairs a pending availability change whose target carries dangling refs", async () => {
    // A pause attempted DURING the issue-#1 outage recorded a pendingAvailability
    // whose target embeds the dangling refs, wedging every retry and deploy.
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const angelId = ensured.angel.id;
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version = await publish(harness.control, angelId, artifact);
    const staged = await stage(harness.control, angelId, version, artifact.digest, {
      gmail: ["con_personal_google", "con_work_google"],
    });
    const promote = {
      stagedDeploymentId: staged.id,
      expectedDigest: staged.digest,
      bindings: { gmail: ["con_personal_google", "con_work_google"] },
    };
    await harness.control.promoteProduction(
      angelId,
      promote,
      mutation("POST", `/v1/angels/${angelId}/environments/production/promotions`, "prod-1", promote),
    );

    const damaged = harness.control.exportState();
    const production = damaged.angels[0]!.environments.production;
    const activeBindings = damaged.deployments.find(
      (candidate) => candidate.id === production.activeDeploymentId,
    )!.runtimeBindings;
    const activeRef = activeBindings.find(
      (binding) => binding.connectionId === "con_work_google",
    )!.connectionRef;
    const staleRef = damaged.deployments.find((candidate) => candidate.id === staged.id)!
      .runtimeBindings[0]!.connectionRef;
    production.availability = {
      defaultEnabled: true,
      overrides: {},
      connectionOverrides: { "gmail.users.messages.list": { [staleRef]: false } },
      revision: 1,
    };
    production.pendingAvailability = {
      change: {
        kind: "tool_connection",
        tool: "gmail.users.messages.list",
        connectionId: "con_work_google",
        enabled: false,
      },
      command: {
        kind: "tool_connection",
        tool: "gmail.users.messages.list",
        connectionRef: activeRef,
        enabled: false,
        expectedRevision: 1,
      },
      target: {
        defaultEnabled: true,
        overrides: {},
        connectionOverrides: {
          "gmail.users.messages.list": { [staleRef]: false, [activeRef]: false },
        },
        revision: 2,
      },
    };
    production.repair = "broker";

    const restored = ManagementControl.restore(damaged, freshDependencies(harness));
    const state = restored.exportState().angels[0]!.environments.production;
    // The dangling ref is gone from both the availability and the pending
    // target; the operator's in-flight change on the live ref survives.
    expect(state.availability.connectionOverrides).toEqual({});
    expect(state.pendingAvailability!.target.connectionOverrides).toEqual({
      "gmail.users.messages.list": { [activeRef]: false },
    });
  });

  test("restore drops a tool override for a tool the active deployment no longer ships", async () => {
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

    const damaged = harness.control.exportState();
    const stagingState = damaged.angels[0]!.environments.preview;
    // A pre-fix deploy of a Version that dropped this tool pruned the override
    // at the gates but left it in Management.
    stagingState.availability = {
      defaultEnabled: true,
      overrides: { "gmail.users.labels.list": false },
      connectionOverrides: {},
      revision: 1,
    };

    const restored = ManagementControl.restore(damaged, freshDependencies(harness));
    expect(
      restored.getEnvironment(angelId, "preview").availability.toolOverrides,
    ).toEqual({});
  });

  test("restore leaves a healthy environment's availability untouched", async () => {
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const angelId = ensured.angel.id;
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version = await publish(harness.control, angelId, artifact);
    await stage(harness.control, angelId, version, artifact.digest, {
      gmail: ["con_personal_google", "con_work_google"],
    });
    const pauseTool = { kind: "tool" as const, tool: "gmail.users.messages.list", enabled: false };
    await harness.control.changeAvailability(
      angelId,
      "preview",
      pauseTool,
      mutation("POST", `/v1/angels/${angelId}/environments/preview/availability`, "pause-tool", pauseTool),
    );
    const enablePersonal = {
      kind: "tool_connection" as const,
      tool: "gmail.users.messages.list",
      connectionId: "con_personal_google",
      enabled: true,
    };
    await harness.control.changeAvailability(
      angelId,
      "preview",
      enablePersonal,
      mutation("POST", `/v1/angels/${angelId}/environments/preview/availability`, "enable-personal", enablePersonal),
    );

    const before = harness.control.exportState();
    const restored = ManagementControl.restore(before, freshDependencies(harness));
    const after = restored.exportState();
    expect(canonicalJson(after.angels[0]!.environments.preview.availability))
      .toBe(canonicalJson(before.angels[0]!.environments.preview.availability));
    expect(after.angels[0]!.environments.preview.availability.overrides)
      .toEqual({ "gmail.users.messages.list": false });
  });

  test("returns tenant-safe not found for Angel resources outside the Account", async () => {
    const { control } = managementHarness();
    await ensure(control);

    expect(() => control.getAngel("ang_missing")).toThrow(ManagementError);
    expect(() => control.getAngel("ang_missing")).toThrow("not found");
    expect(() => control.getEnvironment("ang_missing", "preview")).toThrow("not found");
  });
});

const MANAGEMENT_NOW = "2026-07-22T12:00:00.000Z";

function managementHarness(options: {
  failGatewayOnce?: boolean;
  failGatewayAvailabilityOnce?: boolean;
  failGatewayResetOnce?: boolean;
  connections?: ManagementConnection[];
  now?: () => string;
} = {}) {
  const vault = new MemoryReplayVault();
  const fleets = new FakeFleetFactory(
    options.failGatewayOnce ?? false,
    options.failGatewayAvailabilityOnce ?? false,
    options.failGatewayResetOnce ?? false,
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
    private failGatewayResetOnce = false,
  ) {}

  forAngel(angelId: string): FakeFleet {
    let fleet = this.fleets.get(angelId);
    if (!fleet) {
      fleet = new FakeFleet(
        this.events,
        this.failGatewayOnce,
        this.failGatewayAvailabilityOnce,
        this.failGatewayResetOnce,
      );
      this.failGatewayOnce = false;
      this.failGatewayAvailabilityOnce = false;
      this.failGatewayResetOnce = false;
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
    private failGatewayResetOnce = false,
  ) {}

  async reset(gate: GateKind, environment: "preview" | "production"): Promise<void> {
    if (gate === "gateway" && this.failGatewayResetOnce) {
      this.failGatewayResetOnce = false;
      throw new Error("injected Gateway reset failure");
    }
    this.events.push(`reset:${gate}:${environment}`);
  }

  async reconcileKeys(
    gate: GateKind,
    environment: "preview" | "production",
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

  async snapshot(gate: GateKind, environment: "preview" | "production"): Promise<PolicyGateState> {
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
    environment: "preview" | "production",
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
  return control.deployPreview(
    angelId,
    body,
    mutation("POST", `/v1/angels/${angelId}/environments/preview/deployments`, `stage-${version.id}`, body),
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
      "preview",
      { kind: "all", enabled: false },
      mutation("POST", `/v1/angels/${angelId}/environments/preview/availability`, "avail-1", {
        kind: "all",
        enabled: false,
      }),
    );
    expect(
      harness.control.exportState().angels[0]!.environments.preview.availabilityChangedAt,
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
      `/v1/angels/${angelId}/environments/preview/deployments`,
      "stage-1",
      body,
    );

    // The first attempt fails at the Gateway, BEFORE the deployment converges.
    await expect(harness.control.deployPreview(angelId, body, stageMutation))
      .rejects.toThrow(/injected Gateway failure/);
    // The pending, never-effective deployment carries no recorded time yet.
    const afterFailure = harness.control.exportState();
    expect(afterFailure.timestamps![afterFailure.deployments[0]!.id]).toBeUndefined();

    // Advance the clock, then repair by retrying the SAME command.
    clock = "2026-07-22T05:00:00.000Z"; // T1 — convergence
    await harness.control.deployPreview(angelId, body, stageMutation);

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
    const deployEvent = view.angels[0]!.environments.preview.lifecycle.find(
      (event) => event.kind === "preview_deploy",
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
    const keys = harness.control.listKeys(ensured.angel.id, "preview");
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
      "preview",
      body,
      mutation("POST", keyPath(angelId, "preview"), "create-ci", body),
    );
    expect(created.plaintext).toMatch(/^ak_preview_/);
    expect(created.key).toMatchObject({ name: "CI deploy key", status: "active", revokedAt: null });

    // The state stores the hash of the plaintext; the returned view never does.
    const createdHash = await sha256Hex(created.plaintext);
    const stored = harness.control.exportState().angels[0]!.environments.preview.keys!;
    expect(stored.some((key) => key.hash === createdHash)).toBe(true);
    expect(JSON.stringify(created.key)).not.toContain(createdHash);

    // Idempotent replay: identical response including the SAME plaintext (from the
    // encrypted replay vault) — never a freshly minted secret.
    const replay = await harness.control.createKey(
      angelId,
      "preview",
      body,
      mutation("POST", keyPath(angelId, "preview"), "create-ci", body),
    );
    expect(replay).toEqual(created);

    // The gateway received the full active set (Default key + the new key).
    const pushed = harness.fleets.forAngel(angelId).keyHashes.get("gateway:preview")!;
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
      "preview",
      { name: "temp" },
      mutation("POST", keyPath(angelId, "preview"), "c1", { name: "temp" }),
    );
    const revokeBody = { keyId: created.key.id };
    const revoked = await harness.control.revokeKey(
      angelId,
      "preview",
      revokeBody,
      mutation("POST", keyPath(angelId, "preview", `/${created.key.id}/revocations`), "rev1", revokeBody),
    );
    expect(revoked.key).toMatchObject({
      id: created.key.id,
      status: "revoked",
      revokedAt: MANAGEMENT_NOW,
    });

    const pushed = harness.fleets.forAngel(angelId).keyHashes.get("gateway:preview")!;
    expect(pushed).not.toContain(await sha256Hex(created.plaintext));
    expect(pushed).toHaveLength(1); // only the Default key remains active
  });

  test("refuses to revoke the last active key or rotate a revoked key", async () => {
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    const angelId = ensured.angel.id;
    const defaultKeyId = harness.control.listKeys(angelId, "preview")[0]!.id;
    await expect(harness.control.revokeKey(
      angelId,
      "preview",
      { keyId: defaultKeyId },
      mutation("POST", keyPath(angelId, "preview", `/${defaultKeyId}/revocations`), "rev-last", { keyId: defaultKeyId }),
    )).rejects.toThrow(/last active key/);

    const created = await harness.control.createKey(
      angelId,
      "preview",
      { name: "t" },
      mutation("POST", keyPath(angelId, "preview"), "c1", { name: "t" }),
    );
    await harness.control.revokeKey(
      angelId,
      "preview",
      { keyId: created.key.id },
      mutation("POST", keyPath(angelId, "preview", `/${created.key.id}/revocations`), "rev1", { keyId: created.key.id }),
    );
    await expect(harness.control.rotateKey(
      angelId,
      "preview",
      { keyId: created.key.id },
      mutation("POST", keyPath(angelId, "preview", `/${created.key.id}/rotations`), "rot1", { keyId: created.key.id }),
    )).rejects.toThrow(/revoked key cannot be rotated/);
  });

  test("migrates a legacy single-key environment into a Default key on restore", async () => {
    const seed = managementHarness();
    const ensured = await ensure(seed.control);
    const legacy = seed.control.exportState();
    const environment = legacy.angels[0]!.environments.preview;
    const legacyFingerprint = environment.keyFingerprint;
    // Emulate a state persisted before named keys existed.
    for (const env of ["preview", "production"] as const) {
      delete legacy.angels[0]!.environments[env].keys;
    }

    const control = ManagementControl.restore(legacy, freshDependencies(seed));
    const keys = control.listKeys(ensured.angel.id, "preview");
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
      "preview",
      { name: "temp" },
      mutation("POST", keyPath(angelId, "preview"), "c1", { name: "temp" }),
    );
    const revokePath = keyPath(angelId, "preview", `/${created.key.id}/revocations`);
    const revokeMutation = mutation("POST", revokePath, "rev1", { keyId: created.key.id });

    const first = await harness.control.revokeKey(angelId, "preview", { keyId: created.key.id }, revokeMutation);
    expect(first.key).toMatchObject({ id: created.key.id, status: "revoked" });

    // Idempotent replay of the ORIGINAL revoke (same Idempotency-Key) returns the
    // identical original success — never a fresh error.
    const replay = await harness.control.revokeKey(angelId, "preview", { keyId: created.key.id }, revokeMutation);
    expect(replay).toEqual(first);

    // A FRESH revoke (new Idempotency-Key) of the already-revoked key is a hard error.
    await expect(harness.control.revokeKey(
      angelId,
      "preview",
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

describe("ManagementControl delete", () => {
  const deletePath = "/v1/accounts/acct_personal/angels/golden-assistant";

  async function stagedGolden(harness: ReturnType<typeof managementHarness>) {
    const ensured = await ensure(harness.control);
    const artifact = await versionArtifact("golden-assistant", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const version = await publish(harness.control, ensured.angel.id, artifact);
    const staged = await stage(harness.control, ensured.angel.id, version, artifact.digest, {
      gmail: ["con_personal_google"],
    });
    return { ensured, artifact, version, staged };
  }

  async function promoteGolden(
    harness: ReturnType<typeof managementHarness>,
    deployed: Awaited<ReturnType<typeof stagedGolden>>,
  ) {
    const body = {
      stagedDeploymentId: deployed.staged.id,
      expectedDigest: deployed.staged.digest,
      bindings: { gmail: ["con_personal_google"] },
    };
    return harness.control.promoteProduction(
      deployed.ensured.angel.id,
      body,
      mutation("POST", `/v1/angels/${deployed.ensured.angel.id}/environments/production/promotions`, "promote", body),
    );
  }

  test("revokes keys, then resets Broker before Gateway in both environments, and drops all Angel state", async () => {
    const harness = managementHarness();
    const deployed = await stagedGolden(harness);
    harness.fleets.events.length = 0;

    const response = await harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-1", {}),
    );

    expect(response).toEqual({ id: deployed.ensured.angel.id, slug: "golden-assistant", deleted: true });
    expect(harness.fleets.events).toEqual([
      "reconcile_keys:gateway:preview",
      "reconcile_keys:gateway:production",
      "reset:broker:preview",
      "reset:broker:production",
      "reset:gateway:preview",
      "reset:gateway:production",
    ]);
    const fleet = harness.fleets.forAngel(deployed.ensured.angel.id);
    expect(fleet.keyHashes.get("gateway:preview")).toEqual([]);
    expect(fleet.keyHashes.get("gateway:production")).toEqual([]);
    expect(() => harness.control.getAngelBySlug(account.id, "golden-assistant"))
      .toThrow(ManagementError);
    const state = harness.control.exportState();
    expect(state.angels).toEqual([]);
    expect(state.versions).toEqual([]);
    expect(state.deployments).toEqual([]);
    expect(Object.keys(state.timestamps ?? {})).toEqual([]);
  });

  test("frees the slug for immediate reuse, even under the CLI's deterministic ensure key", async () => {
    const harness = managementHarness();
    const first = await ensure(harness.control);

    await harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-1", {}),
    );
    // The pinned CLI derives the Idempotency-Key from method+path+body, so the
    // ensure after a delete arrives under the SAME key as the original ensure.
    // It must create a fresh Angel, not replay the dead one's sealed response.
    const second = await ensure(harness.control);

    expect(second.angel.id).not.toBe(first.angel.id);
    expect(second.keys).toBeDefined();
    expect(second.keys!.preview).not.toBe(first.keys!.preview);
  });

  test("purges the Angel's idempotency records on delete but keeps the delete replay", async () => {
    const harness = managementHarness();
    await stagedGolden(harness);

    await harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-1", {}),
    );

    // The ensure/publish/stage records addressed the dead Angel; only the
    // delete's own record survives so its replay stays available.
    expect(Object.keys(harness.control.exportState().idempotency)).toEqual(["delete-1"]);
  });

  test("purges pre-upgrade records that reference the dead Angel and keeps other Angels' records", async () => {
    const seed = managementHarness();
    const ensured = await ensure(seed.control);
    const state = seed.control.exportState();
    // Records persisted before deletion existed carry no `path`. Purge the ones
    // whose stored response references the dead Angel (plain or sealed), but
    // leave a different Angel's replay protection alone.
    state.idempotency["legacy-dead"] = {
      fingerprint: "f".repeat(64),
      responseJson: JSON.stringify({ angel: { id: ensured.angel.id, slug: "golden-assistant" } }),
    };
    state.idempotency["legacy-dead-sealed"] = {
      fingerprint: "d".repeat(64),
      ciphertext: await seed.vault.seal(JSON.stringify({ angel: { id: ensured.angel.id } })),
    };
    // Another Angel's record whose response merely MENTIONS the slug (a key
    // named after it) must survive: the purge matches the opaque Angel id, not
    // prose.
    state.idempotency["legacy-other"] = {
      fingerprint: "e".repeat(64),
      responseJson: JSON.stringify({ key: { id: "key_other", name: "golden-assistant" }, plaintext: "ak_other" }),
    };
    // A sealed record the vault cannot open is unattributable and is purged.
    state.idempotency["legacy-unopenable"] = {
      fingerprint: "c".repeat(64),
      ciphertext: "not-a-sealed-payload",
    };
    const control = ManagementControl.restore(state, freshDependencies(seed));

    await control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-1", {}),
    );

    expect(Object.keys(control.exportState().idempotency).sort()).toEqual(["delete-1", "legacy-other"]);
  });

  test("purges dashboard-path records owned by the dead Angel", async () => {
    const harness = managementHarness();
    const ensured = await ensure(harness.control);
    // Dashboard mutations run under /api/demo/action, so the coordinate and
    // /v1/angels/<id>/ path rules never match them — the owning Angel id on
    // the record has to carry the purge, or a sealed shown-once key response
    // outlives its Angel.
    await harness.control.createKey(
      ensured.angel.id,
      "production",
      { name: "Dashboard key" },
      mutation("POST", "/api/demo/action", "demo-key-1", { name: "Dashboard key" }),
    );

    await harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-1", {}),
    );

    expect(Object.keys(harness.control.exportState().idempotency)).toEqual(["delete-1"]);
  });

  test("keeps earlier delete receipts: a stale delete key replays instead of deleting the recreated Angel", async () => {
    const harness = managementHarness();
    const first = await ensure(harness.control);
    const staleDelete = mutation("DELETE", deletePath, "delete-k1", {});

    const original = await harness.control.deleteAngel(account.id, "golden-assistant", {}, staleDelete);
    await ensure(harness.control);
    await harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-k2", {}),
    );
    const third = await ensure(harness.control);

    // A very delayed retry of the FIRST delete must replay its committed
    // response — never run a fresh destructive delete against whichever Angel
    // now holds the slug.
    const replayed = await harness.control.deleteAngel(account.id, "golden-assistant", {}, staleDelete);

    expect(replayed).toEqual(original);
    expect(replayed.id).toBe(first.angel.id);
    expect(harness.control.getAngelBySlug(account.id, "golden-assistant").id).toBe(third.angel.id);
  });

  test("purges records stored under a percent-encoded coordinate path", async () => {
    const harness = managementHarness();
    // A client may percent-encode the coordinate; routing decodes it, so the
    // record must canonicalize to the decoded path or it escapes the purge and
    // replays the dead Angel.
    await harness.control.ensureAngel(
      account.id,
      "golden-assistant",
      mutation("PUT", "/v1/accounts/acct_personal/angels/%67olden-assistant", "ensure-encoded", {}),
    );

    await harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-1", {}),
    );

    expect(Object.keys(harness.control.exportState().idempotency)).toEqual(["delete-1"]);
  });

  test("requires confirmation when a production deployment is pending repair", async () => {
    const seed = managementHarness();
    const deployed = await stagedGolden(seed);
    await promoteGolden(seed, deployed);
    // A production deploy that converged at both gates but lost its final
    // persist leaves pendingDeploymentId set and activeDeploymentId null while
    // the Angel is genuinely serving — deletion must still demand the slug.
    const state = seed.control.exportState();
    const production = state.angels[0]!.environments.production;
    production.pendingDeploymentId = production.activeDeploymentId;
    production.activeDeploymentId = null;
    production.repair = "gateway";
    const control = ManagementControl.restore(state, freshDependencies(seed));

    await expect(control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-pending", {}),
    )).rejects.toMatchObject({ status: 409 });

    const response = await control.deleteAngel(
      account.id,
      "golden-assistant",
      { confirm: "golden-assistant" },
      mutation("DELETE", deletePath, "delete-pending-confirmed", { confirm: "golden-assistant" }),
    );
    expect(response.deleted).toBe(true);
  });

  test("a failed gate teardown leaves the Angel visible and a retried delete completes", async () => {
    const harness = managementHarness({ failGatewayResetOnce: true });
    const deployed = await stagedGolden(harness);

    await expect(harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-fails", {}),
    )).rejects.toThrow("injected Gateway reset failure");

    // Partial state is visible: the Angel is still listed, with its keys
    // already revoked in recorded state.
    const angel = harness.control.getAngelBySlug(account.id, "golden-assistant");
    expect(angel.id).toBe(deployed.ensured.angel.id);
    const partial = harness.control.exportState();
    for (const environment of ["preview", "production"] as const) {
      expect(partial.angels[0]!.environments[environment].keys!.every((key) => key.status === "revoked"))
        .toBe(true);
    }

    // No idempotency record was stored for the failed attempt, so a retry
    // (fresh key — the client saw an error, not a lost response) repairs.
    const retried = await harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-retry", {}),
    );
    expect(retried.deleted).toBe(true);
    expect(harness.control.listAngels()).toEqual([]);
  });

  test("replays a delete on the same Idempotency-Key and rejects different input under it", async () => {
    const harness = managementHarness();
    await ensure(harness.control);

    const first = await harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-same", {}),
    );
    const eventsAfterFirst = [...harness.fleets.events];
    const replay = await harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-same", {}),
    );

    // The replay returns the committed response without a second teardown.
    expect(replay).toEqual(first);
    expect(harness.fleets.events).toEqual(eventsAfterFirst);

    // The same key with different input is a hard conflict.
    await expect(harness.control.deleteAngel(
      account.id,
      "other",
      {},
      mutation("DELETE", "/v1/accounts/acct_personal/angels/other", "delete-same", {}),
    )).rejects.toMatchObject({ status: 409 });

    // A fresh delete of the gone coordinate 404s: hard delete, no tombstone.
    await expect(harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-again", {}),
    )).rejects.toMatchObject({ status: 404 });
  });

  test("refuses a live production Angel without the slug confirmation and proceeds with it", async () => {
    const harness = managementHarness();
    const deployed = await stagedGolden(harness);
    await promoteGolden(harness, deployed);
    harness.fleets.events.length = 0;

    await expect(harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-unconfirmed", {}),
    )).rejects.toMatchObject({ status: 409 });
    expect(harness.fleets.events).toEqual([]);
    expect(harness.control.getAngelBySlug(account.id, "golden-assistant").id)
      .toBe(deployed.ensured.angel.id);

    await expect(harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      { confirm: "wrong-slug" },
      mutation("DELETE", deletePath, "delete-mismatch", { confirm: "wrong-slug" }),
    )).rejects.toMatchObject({ status: 400 });

    const response = await harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      { confirm: "golden-assistant" },
      mutation("DELETE", deletePath, "delete-confirmed", { confirm: "golden-assistant" }),
    );
    expect(response.deleted).toBe(true);
    expect(harness.control.listAngels()).toEqual([]);
  });

  test("deletes a preview-only Angel without confirmation", async () => {
    const harness = managementHarness();
    await stagedGolden(harness);

    const response = await harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-preview-only", {}),
    );

    expect(response.deleted).toBe(true);
  });

  test("leaves other Angels and shared Connections untouched", async () => {
    const harness = managementHarness();
    const doomed = await stagedGolden(harness);
    const keeperEnsure = await harness.control.ensureAngel(
      account.id,
      "keeper",
      mutation("PUT", "/v1/accounts/acct_personal/angels/keeper", "ensure-keeper", {}),
    );
    const keeperArtifact = await versionArtifact("keeper", [
      requirement("gmail", "gmail", ["gmail.users.messages.list"]),
    ]);
    const keeperVersion = await publish(harness.control, keeperEnsure.angel.id, keeperArtifact);
    await stage(harness.control, keeperEnsure.angel.id, keeperVersion, keeperArtifact.digest, {
      gmail: ["con_personal_google"],
    });
    const keeperBefore = harness.control.getAngel(keeperEnsure.angel.id);
    const connectionsBefore = harness.control.listConnections(account.id);

    await harness.control.deleteAngel(
      account.id,
      "golden-assistant",
      {},
      mutation("DELETE", deletePath, "delete-doomed", {}),
    );

    expect(harness.control.getAngel(keeperEnsure.angel.id)).toEqual(keeperBefore);
    expect(harness.control.listConnections(account.id)).toEqual(connectionsBefore);
    const state = harness.control.exportState();
    expect(state.angels.map((angel) => angel.slug)).toEqual(["keeper"]);
    expect(state.versions.map((version) => version.angelId)).toEqual([keeperEnsure.angel.id]);
    expect(state.deployments.map((deployment) => deployment.angelId)).toEqual([keeperEnsure.angel.id]);
    expect(state.versions.find((version) => version.angelId === doomed.ensured.angel.id)).toBeUndefined();
  });
});
