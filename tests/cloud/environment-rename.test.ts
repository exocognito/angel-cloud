import { describe, expect, test } from "bun:test";
import { compileHostedAngel } from "@smcllns/angel-core";
import type { HostedVersionArtifact } from "../../src/domain";
import {
  HOSTED_ENVIRONMENTS,
  LEGACY_PREVIEW_SPELLING,
  canonicalEnvironment,
} from "../../src/environments";
import {
  ManagementControl,
  createManagementState,
  type ManagementDependencies,
  type ManagementState,
  type ResponseReplayVault,
} from "../../src/management";
import type {
  GateAvailability,
  GateAvailabilityCommand,
  GateInstallCommand,
  GateInstallation,
  GateKind,
  PolicyGateState,
} from "../../src/gate";

const account = { id: "acct_personal", name: "Personal" };
const connections = [
  {
    id: "con_personal_google",
    accountId: account.id,
    nickname: "personal-google",
    identityLabel: "sam@example.com",
    credential: "google_oauth" as const,
    providers: ["gmail", "docs"],
    grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    health: "healthy" as const,
  },
];

describe("hosted environment vocabulary", () => {
  test("preview is the canonical name for the second environment", () => {
    expect(HOSTED_ENVIRONMENTS).toEqual(["preview", "production"]);
    expect(LEGACY_PREVIEW_SPELLING).toBe("staging");
    expect(canonicalEnvironment("preview")).toBe("preview");
    expect(canonicalEnvironment("production")).toBe("production");
    expect(canonicalEnvironment("staging")).toBe("preview");
    expect(canonicalEnvironment("latest")).toBeNull();
    expect(canonicalEnvironment("")).toBeNull();
  });
});

describe("management state renames staging to preview", () => {
  test("a fresh Angel has preview and production environments and preview-prefixed keys", async () => {
    const { control } = harness();
    const ensured = await control.ensureAngel(account.id, "golden-assistant", mutation("ensure"));

    expect(Object.keys(ensured.angel.environments).sort()).toEqual(["preview", "production"]);
    expect(ensured.keys!.preview).toMatch(/^ak_preview_/);
    expect(ensured.keys!.production).toMatch(/^ak_production_/);
    expect(ensured.angel.environments.preview.environment).toBe("preview");
  });

  test("restore migrates a persisted staging-keyed state to preview", async () => {
    const first = harness();
    const ensured = await first.control.ensureAngel(account.id, "golden-assistant", mutation("ensure"));
    const artifact = await versionArtifact("golden-assistant");
    const version = await first.control.publishVersion(
      ensured.angel.id,
      { artifact, expectedDigest: artifact.digest },
      mutation("publish"),
    );
    await first.control.deployPreview(
      ensured.angel.id,
      { versionId: version.id, expectedDigest: artifact.digest, bindings: { gmail: ["con_personal_google"] } },
      mutation("deploy"),
    );

    // Simulate the pre-rename persisted shape: environments keyed `staging`,
    // deployments recorded with environment "staging".
    const legacy = structuredClone(first.control.exportState()) as unknown as {
      angels: Array<{ environments: Record<string, unknown> }>;
      deployments: Array<{ environment: string }>;
    };
    for (const angel of legacy.angels) {
      angel.environments.staging = angel.environments.preview;
      delete angel.environments.preview;
    }
    for (const deployment of legacy.deployments) {
      if (deployment.environment === "preview") deployment.environment = "staging";
    }

    const restored = ManagementControl.restore(
      legacy as unknown as ManagementState,
      harness().dependencies,
    );
    const state = restored.exportState();
    expect(Object.keys(state.angels[0]!.environments).sort()).toEqual(["preview", "production"]);
    expect(state.deployments.every((deployment) => (deployment.environment as string) !== "staging")).toBe(true);
    expect(restored.getEnvironment(ensured.angel.id, "preview").activeDeployment).not.toBeNull();
  });

  test("preview deploys install gates under the preview environment", async () => {
    const h = harness();
    const ensured = await h.control.ensureAngel(account.id, "golden-assistant", mutation("ensure"));
    const artifact = await versionArtifact("golden-assistant");
    const version = await h.control.publishVersion(
      ensured.angel.id,
      { artifact, expectedDigest: artifact.digest },
      mutation("publish"),
    );

    const deployed = await h.control.deployPreview(
      ensured.angel.id,
      { versionId: version.id, expectedDigest: artifact.digest, bindings: { gmail: ["con_personal_google"] } },
      mutation("deploy"),
    );

    expect(deployed.environment).toBe("preview");
    expect(h.events).toEqual(["install:broker:preview", "install:gateway:preview"]);
  });

  test("a preview deploy without preview bindings fails naming both ways forward", async () => {
    const h = harness();
    const ensured = await h.control.ensureAngel(account.id, "golden-assistant", mutation("ensure"));
    const artifact = await versionArtifact("golden-assistant");
    const version = await h.control.publishVersion(
      ensured.angel.id,
      { artifact, expectedDigest: artifact.digest },
      mutation("publish"),
    );

    await expect(h.control.deployPreview(
      ensured.angel.id,
      { versionId: version.id, expectedDigest: artifact.digest, bindings: {} },
      mutation("deploy-unbound"),
    )).rejects.toMatchObject({
      status: 400,
      message: "preview has no Connection bindings: bind a Connection to preview, or pass production's bindings explicitly to share its credentials",
    });
  });
});

describe("one-step production publish", () => {
  test("deployProduction takes a published Version live without a preview step", async () => {
    const h = harness();
    const ensured = await h.control.ensureAngel(account.id, "golden-assistant", mutation("ensure"));
    const artifact = await versionArtifact("golden-assistant");
    const version = await h.control.publishVersion(
      ensured.angel.id,
      { artifact, expectedDigest: artifact.digest },
      mutation("publish"),
    );

    const deployed = await h.control.deployProduction(
      ensured.angel.id,
      { versionId: version.id, expectedDigest: artifact.digest, bindings: { gmail: ["con_personal_google"] } },
      mutation("deploy-production"),
    );

    expect(deployed.environment).toBe("production");
    expect(deployed.versionId).toBe(version.id);
    expect(deployed.digest).toBe(artifact.digest);
    expect(h.events).toEqual(["install:broker:production", "install:gateway:production"]);
    const view = h.control.getEnvironment(ensured.angel.id, "production");
    expect(view.activeDeployment).toMatchObject({ id: deployed.id, digest: artifact.digest });
    expect(h.control.getEnvironment(ensured.angel.id, "preview").activeDeployment).toBeNull();
  });

  test("deployProduction rejects a digest that does not match the Version", async () => {
    const h = harness();
    const ensured = await h.control.ensureAngel(account.id, "golden-assistant", mutation("ensure"));
    const artifact = await versionArtifact("golden-assistant");
    const version = await h.control.publishVersion(
      ensured.angel.id,
      { artifact, expectedDigest: artifact.digest },
      mutation("publish"),
    );

    await expect(h.control.deployProduction(
      ensured.angel.id,
      { versionId: version.id, expectedDigest: "0".repeat(64), bindings: { gmail: ["con_personal_google"] } },
      mutation("deploy-bad-digest"),
    )).rejects.toMatchObject({ status: 409 });
  });
});

let mutationSequence = 0;

function mutation(key: string) {
  return { method: "POST", path: "/v1/test", idempotencyKey: `${key}-${++mutationSequence}`, body: {} };
}

async function versionArtifact(name: string): Promise<HostedVersionArtifact> {
  return compileHostedAngel([
    `name: ${name}`,
    "charter: deterministic environment-rename fixture",
    "tools:",
    "  - tool: gmail.users.messages.list",
  ].join("\n"));
}

function harness() {
  const events: string[] = [];
  let sequence = 0;
  const fleet = new RecordingFleet(events);
  const dependencies: ManagementDependencies = {
    replayVault: new PlainVault(),
    fleetFor: () => fleet,
    randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
    checkpoint: { persist: async () => {} },
    now: () => "2026-07-28T12:00:00.000Z",
  };
  const control = ManagementControl.restore(
    createManagementState({ account, connections }),
    dependencies,
  );
  return { control, events, dependencies };
}

class PlainVault implements ResponseReplayVault {
  async seal(plaintext: string): Promise<string> {
    return `sealed:${btoa(plaintext)}`;
  }

  async open(ciphertext: string): Promise<string> {
    return atob(ciphertext.slice("sealed:".length));
  }
}

class RecordingFleet {
  private readonly installations = new Map<string, GateInstallation>();

  constructor(private readonly events: string[]) {}

  async reset(): Promise<void> {}

  async reconcileKeys(gate: GateKind, environment: string, hashes: string[]): Promise<string[]> {
    this.events.push(`reconcile_keys:${gate}:${environment}`);
    return [...hashes];
  }

  async install(gate: GateKind, command: GateInstallCommand): Promise<GateInstallation> {
    this.events.push(`install:${gate}:${command.environment}`);
    const installation = {
      ...command,
      gate,
      policyDigest: command.artifact.digest,
      bindingsDigest: "f".repeat(64),
    } as GateInstallation;
    this.installations.set(`${gate}:${command.environment}`, installation);
    return structuredClone(installation);
  }

  async snapshot(gate: GateKind, environment: string): Promise<PolicyGateState> {
    return {
      schemaVersion: 1,
      gate,
      identity: null,
      installation: structuredClone(this.installations.get(`${gate}:${environment}`) ?? null),
      gatewayKeyHash: null,
      availability: {
        defaultEnabled: true,
        overrides: {},
        connectionOverrides: {},
        revision: 0,
      },
      deploymentFingerprints: {},
      receipts: [],
      checkpoint: "0".repeat(64),
    } as PolicyGateState;
  }

  async change(
    gate: GateKind,
    environment: string,
    _command: GateAvailabilityCommand,
  ): Promise<GateAvailability> {
    this.events.push(`availability:${gate}:${environment}`);
    return { defaultEnabled: true, overrides: {}, connectionOverrides: {}, revision: 1 };
  }

  async activity(): Promise<never[]> {
    return [];
  }
}
