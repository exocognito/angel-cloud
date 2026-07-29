import { describe, expect, test } from "bun:test";
import { compileHostedAngel } from "../../src/domain";
import {
  PolicyGate,
  availableTools,
  createPolicyGateState,
  migrateInstalledAvailability,
  type GateToolBinding,
} from "../../src/gate";
import { sha256Hex } from "@smcllns/angel-core";

const v1Source = `
name: golden-research-assistant
tools:
  - tool: gmail.users.messages.list
    argGuards:
      - field: maxResults
        pin: "5"
  - tool: docs.documents.get
    argGuards:
      - field: documentId
        pin: doc_golden_1
`;
const v2Source = `${v1Source}
  - gmail.users.labels.list
`;

const bindings: GateToolBinding[] = [
  {
    tool: "gmail.users.messages.list",
    connectionRef: "arc_google",
    connectionId: "con_google",
    provider: "gmail",
    identityLabel: "Golden Google",
  },
  {
    tool: "docs.documents.get",
    connectionRef: "arc_google",
    connectionId: "con_google",
    provider: "docs",
    identityLabel: "Golden Google",
  },
];
const v2Bindings: GateToolBinding[] = [
  ...bindings,
  {
    tool: "gmail.users.labels.list",
    connectionRef: "arc_google",
    connectionId: "con_google",
    provider: "gmail",
    identityLabel: "Golden Google",
  },
];

async function installedGateway() {
  const key = "ak_stable_gateway_key";
  const gate = new PolicyGate(createPolicyGateState("gateway"));
  const artifact = await compileHostedAngel(v1Source);
  const installation = await gate.install({
    accountId: "acct_personal",
    angelId: "golden-research-assistant",
    environment: "production",
    deploymentId: "dep_v1",
    version: 1,
    artifact,
    bindings,
    gatewayKeyHash: await sha256Hex(key),
  });
  return { gate, key, artifact, installation };
}

describe("PolicyGate installation", () => {
  test("rejects a v1 artifact at install with a named format error", async () => {
    const gate = new PolicyGate(createPolicyGateState("gateway"));
    const compiled = await compileHostedAngel(v1Source);
    const content = JSON.parse(compiled.canonicalSource) as Record<string, unknown>;
    content.format = "angel.version.v1";
    delete content.providers;
    const canonicalSource = JSON.stringify(content);
    const v1Artifact = {
      ...content,
      canonicalSource,
      digest: await sha256Hex(canonicalSource),
    } as unknown as typeof compiled;
    await expect(gate.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_v1",
      version: 1,
      artifact: v1Artifact,
      bindings,
      gatewayKeyHash: await sha256Hex("ak_key"),
    })).rejects.toThrow(/unsupported artifact format/);
  });

  test("fails a persisted v1 installation cleanly before chaining any receipt", async () => {
    const { gate, key } = await installedGateway();
    const state = gate.snapshot();
    delete (state.installation!.artifact as unknown as Record<string, unknown>).providers;
    (state.installation!.artifact as unknown as Record<string, unknown>).format = "angel.version.v1";
    const stale = new PolicyGate(state);
    const before = stale.snapshot().receipts.length;
    // An unauthenticated probe still gets its ordinary 401 receipt — the
    // format failure is reserved for authenticated calls.
    const unauthorized = await stale.evaluate({
      requestId: "req_probe",
      presentedKey: "wrong-key",
      tool: "gmail.users.messages.list",
      arguments: {},
    });
    expect(unauthorized).toMatchObject({ allowed: false, reason: "unauthorized" });
    await expect(stale.evaluate({
      requestId: "req_stale",
      presentedKey: key,
      tool: "gmail.users.messages.list",
      arguments: {},
    })).rejects.toThrow(/unsupported artifact format/);
    expect(stale.snapshot().receipts.length).toBe(before + 1);
  });

  test("installs one exact deployment and serializes its complete state", async () => {
    const { gate, artifact, installation } = await installedGateway();

    expect(installation).toMatchObject({
      gate: "gateway",
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_v1",
      version: 1,
      policyDigest: artifact.digest,
    });
    expect(installation.bindingsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(JSON.stringify(gate.snapshot()))).toEqual(gate.snapshot());
  });

  test("rejects a changed identity, artifact digest, incomplete bindings, and gateway key rotation", async () => {
    const { gate, artifact } = await installedGateway();
    const v2 = await compileHostedAngel(v2Source);

    await expect(gate.install({
      accountId: "acct_other",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_v2",
      version: 2,
      artifact: v2,
      bindings,
    })).rejects.toThrow(/gate identity mismatch/);

    await expect(new PolicyGate(createPolicyGateState("broker")).install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "staging",
      deploymentId: "dep_bad_digest",
      version: 1,
      artifact: { ...artifact, digest: "0".repeat(64) },
      bindings,
    })).rejects.toThrow(/artifact digest mismatch/);

    await expect(new PolicyGate(createPolicyGateState("broker")).install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "staging",
      deploymentId: "dep_missing_binding",
      version: 1,
      artifact,
      bindings: [],
    })).rejects.toThrow(/tool bindings must cover every deployed tool/);

    await expect(gate.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_v2",
      version: 2,
      artifact: v2,
      bindings: v2Bindings,
      gatewayKeyHash: await sha256Hex("replacement_key"),
    })).rejects.toThrow(/gateway key hash is stable/);
  });

  test("does not capture a gateway key when the installation is rejected", async () => {
    const artifact = await compileHostedAngel(v1Source);
    const gate = new PolicyGate(createPolicyGateState("gateway"));

    await expect(gate.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_invalid",
      version: 0,
      artifact,
      bindings,
      gatewayKeyHash: await sha256Hex("rejected_key"),
    })).rejects.toThrow(/version must be a positive integer/);

    await expect(gate.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_valid",
      version: 1,
      artifact,
      bindings,
      gatewayKeyHash: await sha256Hex("accepted_key"),
    })).resolves.toMatchObject({ deploymentId: "dep_valid" });
  });

  test("rejects structured artifact fields that differ from the hashed canonical source", async () => {
    const artifact = await compileHostedAngel(v1Source);
    const gate = new PolicyGate(createPolicyGateState("broker"));
    const altered = structuredClone(artifact);
    altered.tools[0]!.operation = "gmail.users.labels.list";

    await expect(gate.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "staging",
      deploymentId: "dep_altered",
      version: 1,
      artifact: altered,
      bindings,
    })).rejects.toThrow(/artifact content does not match canonical source/);
  });

  test("does not reuse one deployment ID for different installed content", async () => {
    const { gate } = await installedGateway();
    const v2 = await compileHostedAngel(v2Source);

    await expect(gate.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_v1",
      version: 2,
      artifact: v2,
      bindings: v2Bindings,
    })).rejects.toThrow(/deployment ID is already installed with different content/);
  });
});

describe("PolicyGate policy and availability", () => {
  test("discovery exposes only tools currently available in the environment", async () => {
    const { gate, artifact } = await installedGateway();
    expect(availableTools(gate.snapshot()).map((tool) => tool.name)).toEqual(
      artifact.tools.map((tool) => tool.name),
    );

    gate.changeAvailability({ kind: "all", enabled: false, expectedRevision: 0 });
    expect(availableTools(gate.snapshot())).toEqual([]);

    gate.changeAvailability({
      kind: "tool",
      tool: artifact.tools[0]!.name,
      enabled: true,
      expectedRevision: 1,
    });
    expect(availableTools(gate.snapshot()).map((tool) => tool.name)).toEqual([
      artifact.tools[0]!.name,
    ]);
  });

  test("authenticates the gateway key and applies compiled pin defaults before guards", async () => {
    const { gate, key } = await installedGateway();

    const unauthorized = await gate.evaluate({
      requestId: "req_bad_key",
      presentedKey: "wrong",
      tool: "gmail.users.messages.list",
      arguments: {},
    });
    expect(unauthorized).toMatchObject({ allowed: false, reason: "unauthorized" });

    const allowed = await gate.evaluate({
      requestId: "req_allowed",
      presentedKey: key,
      tool: "gmail.users.messages.list",
      arguments: {},
    });
    expect(allowed).toMatchObject({
      allowed: true,
      reason: "allowed",
      // Path defaults are materialized BEFORE guards (the core decision
      // contract), so the guarded, ledgered, and forwarded object is one and
      // the same — userId: "me" is part of effective arguments and the digest.
      effectiveArguments: { maxResults: "5", userId: "me" },
      // The Broker executes exactly what the artifact seals — the gate hands
      // back the matched tool's request template and its provider's pinned
      // origin, never re-deriving either.
      execution: {
        origin: "https://gmail.googleapis.com",
        request: {
          kind: "http",
          method: "GET",
          pathTemplate: "/gmail/v1/users/{userId}/messages",
          pathParams: ["userId"],
          pathDefaults: { userId: "me" },
          queryParams: ["includeSpamTrash", "labelIds", "maxResults", "pageToken", "q"],
          hasBody: false,
        },
      },
    });
    expect(allowed.receipt).toMatchObject({
      accountId: "acct_personal",
      environment: "production",
      deploymentId: "dep_v1",
      version: 1,
      provider: "gmail",
      operation: "gmail.users.messages.list",
      connectionId: "con_google",
      connectionIdentityLabel: "Golden Google",
      requestId: "req_allowed",
      decision: "allow",
    });

    const denied = await gate.evaluate({
      requestId: "req_guard",
      presentedKey: key,
      tool: "gmail.users.messages.list",
      arguments: { maxResults: "6" },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("guard_denied");
    expect(denied.receipt.detail).toContain("pinned to 5");
  });

  test("denies an invalid gateway key before inspecting malformed arguments", async () => {
    const { gate } = await installedGateway();

    expect(await gate.evaluate({
      requestId: "req_auth_first",
      presentedKey: "wrong",
      tool: "gmail.users.messages.list",
      arguments: { notJson: undefined },
    })).toMatchObject({ allowed: false, reason: "unauthorized" });
  });

  test("preserves an environment frozen default and surviving overrides across installs", async () => {
    const { gate, key } = await installedGateway();
    const paused = gate.changeAvailability({ kind: "all", enabled: false, expectedRevision: 0 });
    expect(paused).toEqual({
      defaultEnabled: false,
      overrides: {},
      connectionOverrides: {},
      revision: 1,
    });
    gate.changeAvailability({
      kind: "tool",
      tool: "gmail.users.messages.list",
      enabled: true,
      expectedRevision: 1,
    });

    const v2 = await compileHostedAngel(v2Source);
    await gate.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_v2",
      version: 2,
      artifact: v2,
      bindings: v2Bindings,
    });

    expect(gate.availability()).toEqual({
      defaultEnabled: false,
      overrides: { "gmail.users.messages.list": true },
      connectionOverrides: {},
      revision: 2,
    });
    expect((await gate.evaluate({
      requestId: "req_existing",
      presentedKey: key,
      tool: "gmail.users.messages.list",
      arguments: {},
    })).allowed).toBe(true);
    expect(await gate.evaluate({
      requestId: "req_new_tool",
      presentedKey: key,
      tool: "gmail.users.labels.list",
      arguments: {},
    })).toMatchObject({ allowed: false, reason: "tool_paused" });

    gate.changeAvailability({
      kind: "tool",
      tool: "gmail.users.labels.list",
      enabled: true,
      expectedRevision: 2,
    });
    expect((await gate.evaluate({
      requestId: "req_resumed",
      presentedKey: key,
      tool: "gmail.users.labels.list",
      arguments: {},
    })).allowed).toBe(true);
    expect(gate.changeAvailability({ kind: "all", enabled: true, expectedRevision: 3 }))
      .toEqual({
        defaultEnabled: true,
        overrides: {},
        connectionOverrides: {},
        revision: 4,
      });
  });

  test("remaps connection-scoped overrides onto the new deployment's refs at install", async () => {
    const { gate, key } = await installedGateway();
    // Pause the tool, then re-enable it for the one bound Connection: the
    // enabling override is the only thing keeping the tool served.
    gate.changeAvailability({
      kind: "tool",
      tool: "gmail.users.messages.list",
      enabled: false,
      expectedRevision: 0,
    });
    gate.changeAvailability({
      kind: "tool_connection",
      tool: "gmail.users.messages.list",
      connectionRef: "arc_google",
      enabled: true,
      expectedRevision: 1,
    });

    // A promote installs the same Connection under a freshly minted ref.
    const promoted = bindings.map((binding) => ({ ...binding, connectionRef: "arc_promoted" }));
    await gate.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_v2",
      version: 2,
      artifact: await compileHostedAngel(v1Source),
      bindings: promoted,
      gatewayKeyHash: await sha256Hex(key),
    });

    expect(gate.availability()).toEqual({
      defaultEnabled: true,
      overrides: { "gmail.users.messages.list": false },
      connectionOverrides: {
        "gmail.users.messages.list": { arc_promoted: true },
      },
      revision: 2,
    });
    // The incident symptom: without the remap the enabling override vanished
    // and the tool disappeared from discovery.
    expect(availableTools(gate.snapshot()).map((tool) => tool.name))
      .toContain("gmail.users.messages.list");
  });

  test("drops a connection override whose Connection is no longer bound at install", async () => {
    const { gate, key } = await installedGateway();
    gate.changeAvailability({
      kind: "tool_connection",
      tool: "gmail.users.messages.list",
      connectionRef: "arc_google",
      enabled: false,
      expectedRevision: 0,
    });

    const rebound = bindings.map((binding) => ({
      ...binding,
      connectionRef: "arc_other",
      connectionId: "con_other",
    }));
    await gate.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_v2",
      version: 2,
      artifact: await compileHostedAngel(v1Source),
      bindings: rebound,
      gatewayKeyHash: await sha256Hex(key),
    });

    expect(gate.availability()).toEqual({
      defaultEnabled: true,
      overrides: {},
      connectionOverrides: {},
      revision: 1,
    });
  });

  test("keeps an override on its own ref when a Connection serves one tool under several refs", async () => {
    const key = "ak_stable_gateway_key";
    const gate = new PolicyGate(createPolicyGateState("gateway"));
    const artifact = await compileHostedAngel(v1Source);
    // One Connection bound to the same tool under two refs — permitted by
    // assertBindings, never emitted by the in-repo control planes.
    const doubled: GateToolBinding[] = [
      ...bindings,
      {
        tool: "gmail.users.messages.list",
        connectionRef: "arc_google_alt",
        connectionId: "con_google",
        provider: "gmail",
        identityLabel: "Golden Google",
      },
    ];
    await gate.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_v1",
      version: 1,
      artifact,
      bindings: doubled,
      gatewayKeyHash: await sha256Hex(key),
    });
    gate.changeAvailability({
      kind: "tool_connection",
      tool: "gmail.users.messages.list",
      connectionRef: "arc_google",
      enabled: false,
      expectedRevision: 0,
    });

    // Reinstalling the same deployment must leave the override on arc_google,
    // not migrate it onto the Connection's other ref.
    await gate.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_v1",
      version: 1,
      artifact,
      bindings: doubled,
      gatewayKeyHash: await sha256Hex(key),
    });

    expect(gate.availability()).toEqual({
      defaultEnabled: true,
      overrides: {},
      connectionOverrides: {
        "gmail.users.messages.list": { arc_google: false },
      },
      revision: 1,
    });
  });

  test("refuses to migrate conflicting overrides from two old refs of one Connection", () => {
    // No writer can produce two different values for one (tool, Connection) —
    // both values would have to differ from the same base. If persisted state
    // ever carries that shape, collapsing it silently would let ref order pick
    // which override wins; fail loudly instead.
    expect(() => migrateInstalledAvailability(
      {
        defaultEnabled: false,
        overrides: {},
        connectionOverrides: {
          "gmail.users.messages.list": { arc_old_a: true, arc_old_b: false },
        },
        revision: 2,
      },
      [{ name: "gmail.users.messages.list" }],
      [
        {
          tool: "gmail.users.messages.list",
          connectionRef: "arc_old_a",
          connectionId: "con_google",
          provider: "gmail",
          identityLabel: "Golden Google",
        },
        {
          tool: "gmail.users.messages.list",
          connectionRef: "arc_old_b",
          connectionId: "con_google",
          provider: "gmail",
          identityLabel: "Golden Google",
        },
      ],
      [
        {
          tool: "gmail.users.messages.list",
          connectionRef: "arc_new",
          connectionId: "con_google",
          provider: "gmail",
          identityLabel: "Golden Google",
        },
      ],
    )).toThrow(/conflicting availability overrides/);
  });

  test("the broker independently applies the same policy without an agent key", async () => {
    const artifact = await compileHostedAngel(v1Source);
    const broker = new PolicyGate(createPolicyGateState("broker"));
    await broker.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_v1",
      version: 1,
      artifact,
      bindings,
    });

    expect(await broker.evaluate({
      requestId: "req_broker_allow",
      tool: "docs.documents.get",
      arguments: {},
    })).toMatchObject({
      allowed: true,
      effectiveArguments: { documentId: "doc_golden_1" },
      receipt: { gate: "broker", decision: "allow" },
    });
    expect(await broker.evaluate({
      requestId: "req_broker_deny",
      tool: "docs.documents.get",
      arguments: { documentId: "another" },
    })).toMatchObject({ allowed: false, reason: "guard_denied" });
  });
});

describe("PolicyGate receipt chain", () => {
  test("hash-chains contextual receipts and detects serialized-state tampering", async () => {
    const { gate, key } = await installedGateway();
    const first = await gate.evaluate({
      requestId: "req_1",
      presentedKey: key,
      tool: "gmail.users.messages.list",
      arguments: {},
    });
    const second = await gate.evaluate({
      requestId: "req_2",
      presentedKey: key,
      tool: "docs.documents.get",
      arguments: {},
    });

    expect(first.receipt.previousHash).toBe("0".repeat(64));
    expect(second.receipt.previousHash).toBe(first.receipt.hash);
    expect(await gate.verifyChain()).toEqual({ ok: true, checked: 2 });

    const tampered = gate.snapshot();
    tampered.receipts[0]!.detail = "rewritten";
    expect(await new PolicyGate(tampered).verifyChain()).toMatchObject({
      ok: false,
      checked: 0,
      error: "receipt 0 hash mismatch",
    });
  });
});

describe("PolicyGate named runtime keys", () => {
  async function gatewayWithKeys(plaintextKeys: string[]) {
    const gate = new PolicyGate(createPolicyGateState("gateway"));
    const artifact = await compileHostedAngel(v1Source);
    await gate.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_v1",
      version: 1,
      artifact,
      bindings,
      gatewayKeyHashes: await Promise.all(plaintextKeys.map((key) => sha256Hex(key))),
    });
    return gate;
  }

  function evalInput(presentedKey: string) {
    return {
      requestId: `req_${presentedKey}`,
      presentedKey,
      tool: "gmail.users.messages.list",
      arguments: {},
    };
  }

  test("accepts any ACTIVE key and rejects one outside the set", async () => {
    const gate = await gatewayWithKeys(["ak_one", "ak_two"]);

    expect(await gate.evaluate(evalInput("ak_one"))).toMatchObject({ allowed: true });
    expect(await gate.evaluate(evalInput("ak_two"))).toMatchObject({ allowed: true });
    expect(await gate.evaluate(evalInput("ak_unknown")))
      .toMatchObject({ allowed: false, reason: "unauthorized" });
  });

  test("reconcileGatewayKeys revokes a key and admits a replacement immediately", async () => {
    const gate = await gatewayWithKeys(["ak_one", "ak_two"]);

    // The environment rotated ak_two out and ak_three in; the gate is reconciled
    // out-of-band from any deploy.
    gate.reconcileGatewayKeys(await Promise.all(["ak_one", "ak_three"].map((key) => sha256Hex(key))));

    expect(await gate.evaluate(evalInput("ak_one"))).toMatchObject({ allowed: true });
    expect(await gate.evaluate(evalInput("ak_three"))).toMatchObject({ allowed: true });
    // The revoked key is rejected immediately — not only after the next deploy.
    expect(await gate.evaluate(evalInput("ak_two")))
      .toMatchObject({ allowed: false, reason: "unauthorized" });
  });

  test("migrates a legacy single-key state and keeps it authenticating", async () => {
    const legacy = createPolicyGateState("gateway");
    legacy.gatewayKeyHash = await sha256Hex("ak_legacy");
    delete legacy.gatewayKeyHashes; // the pre-named-keys persisted shape
    const gate = new PolicyGate(legacy);
    const artifact = await compileHostedAngel(v1Source);
    // A reinstall that omits keys must keep the migrated legacy key active.
    await gate.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_v1",
      version: 1,
      artifact,
      bindings,
    });
    expect(await gate.evaluate(evalInput("ak_legacy"))).toMatchObject({ allowed: true });
    expect(gate.snapshot().gatewayKeyHashes).toEqual([await sha256Hex("ak_legacy")]);
  });

  test("reconcileGatewayKeys refuses a broker gate and a malformed hash", async () => {
    const broker = new PolicyGate(createPolicyGateState("broker"));
    expect(() => broker.reconcileGatewayKeys([("a".repeat(64))]))
      .toThrow(/broker gate has no runtime keys/);

    const gate = await gatewayWithKeys(["ak_one"]);
    expect(() => gate.reconcileGatewayKeys(["not-a-hash"])).toThrow(/SHA-256/);
  });

  test("install still requires at least one gateway key hash", async () => {
    // Only reconcile may go empty (deletion lockout); an install without keys
    // would create a gate nobody can ever authenticate to.
    await expect(gatewayWithKeys([])).rejects.toThrow(/at least one/);
  });

  test("reconcileGatewayKeys to an empty set locks the gate: no key authenticates", async () => {
    // Angel deletion revokes every key before tearing the gates down; an empty
    // reconcile is that revocation, and it must reject previously valid keys
    // immediately.
    const gate = await gatewayWithKeys(["ak_one"]);
    expect(await gate.evaluate(evalInput("ak_one"))).toMatchObject({ allowed: true });

    expect(gate.reconcileGatewayKeys([])).toEqual([]);

    expect(await gate.evaluate(evalInput("ak_one")))
      .toMatchObject({ allowed: false, reason: "unauthorized" });
    expect(gate.snapshot().gatewayKeyHashes).toEqual([]);
  });

  test("install rejects a broker gate that is handed gateway key hashes", async () => {
    const broker = new PolicyGate(createPolicyGateState("broker"));
    const artifact = await compileHostedAngel(v1Source);
    await expect(broker.install({
      accountId: "acct_personal",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_v1",
      version: 1,
      artifact,
      bindings,
      gatewayKeyHashes: [await sha256Hex("ak_one")],
    })).rejects.toThrow(/broker cannot install a gateway key hash/);
  });
});
