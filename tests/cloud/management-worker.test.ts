import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compileHostedAngel, sha256Hex } from "@smcllns/angel-core";
import { fixtureConnectionSummaries } from "./fake-vault";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected readonly ctx: unknown;
    protected readonly env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { handleControlRequest: handleControlRequestReal } = await import("../../src/workers/control");
const handleControlRequest = (request: Request, env: Record<string, unknown>) =>
  handleControlRequestReal(request, env as never, async () => ({
    accountId: (env.ACCOUNT_ID ?? env.DEMO_ACCOUNT_ID) as string,
    subject: "test-access-subject",
  }));
const { AccountRegistry } = await import("../../src/workers/account-registry");

describe("management resource routes", () => {
  test("routes all Control surfaces through the Worker with Access JWT verification", () => {
    const wrangler = readFileSync(
      new URL("../../wrangler.control.jsonc", import.meta.url),
      "utf8",
    );
    expect(wrangler).toContain('"run_worker_first": true');
  });

  test("authenticates mutations before parsing JSON", async () => {
    const env = managementEnv();
    const response = await handleControlRequest(new Request(
      "https://cloud.test/v1/accounts/acct_personal/angels/golden-assistant",
      { method: "PUT", headers: { "content-type": "application/json" }, body: "{" },
    ), env as never);

    expect(response.status).toBe(401);
    expect(env.calls).toEqual([]);
  });

  test("requires a non-empty Idempotency-Key on every mutation", async () => {
    for (const idempotencyKey of [undefined, ""]) {
      const env = managementEnv();
      const response = await handleControlRequest(new Request(
        "https://cloud.test/v1/accounts/acct_personal/angels/golden-assistant",
        {
          method: "PUT",
          headers: managementHeaders(idempotencyKey),
          body: JSON.stringify({}),
        },
      ), env as never);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Idempotency-Key must be non-empty" });
      expect(env.calls).toEqual([]);
    }
  });

  test("rejects unknown mutation keys before dispatch", async () => {
    const env = managementEnv();
    const response = await handleControlRequest(new Request(
      "https://cloud.test/v1/accounts/acct_personal/angels/golden-assistant",
      {
        method: "PUT",
        headers: managementHeaders("ensure-1"),
        body: JSON.stringify({ name: "not accepted" }),
      },
    ), env as never);

    expect(response.status).toBe(400);
    expect(env.calls).toEqual([]);
  });

  test("rejects each malformed sealed-request field at the HTTP boundary", async () => {
    const env = managementEnv();
    type MutableArtifact = Record<string, unknown> & {
      tools: Array<{ request: Record<string, unknown> }>;
      providers: Record<string, Record<string, unknown>>;
    };
    const publish = async (mutate: (artifact: MutableArtifact) => void) => {
      const artifact = JSON.parse(JSON.stringify(await versionArtifact())) as MutableArtifact;
      mutate(artifact);
      return handleControlRequest(new Request("https://cloud.test/v1/angels/ang_1/versions", {
        method: "POST",
        headers: managementHeaders(`publish-bad-${crypto.randomUUID()}`),
        body: JSON.stringify({ artifact, expectedDigest: artifact.digest }),
      }), env as never);
    };

    const cases: Array<(artifact: MutableArtifact) => void> = [
      (artifact) => { artifact.tools[0]!.request.kind = "mcp"; },
      (artifact) => { artifact.tools[0]!.request.method = 5; },
      (artifact) => { artifact.tools[0]!.request.pathTemplate = ""; },
      (artifact) => { artifact.tools[0]!.request.pathParams = "userId"; },
      (artifact) => { artifact.tools[0]!.request.queryParams = [5]; },
      (artifact) => { artifact.tools[0]!.request.pathDefaults = { userId: 7 }; },
      (artifact) => { artifact.tools[0]!.request.hasBody = "no"; },
      (artifact) => { artifact.tools[0]!.request.extra = true; },
      (artifact) => { artifact.providers.gmail!.extra = true; },
      (artifact) => { delete artifact.providers.gmail!.origin; },
    ];
    for (const mutate of cases) {
      const response = await publish(mutate);
      expect(response.status).toBe(400);
    }

    // A genuine v1 artifact gets the named format error, not a key-list dump.
    const v1 = await publish((artifact) => {
      artifact.format = "angel.version.v1";
      delete (artifact as Record<string, unknown>).providers;
    });
    expect(v1.status).toBe(400);
    expect(((await v1.json()) as { error: string }).error).toBe("invalid artifact format");
  });

  test("routes the canonical ensure, publish, deploy, and promotion commands", async () => {
    const artifact = await versionArtifact();
    const requests = [
      new Request("https://cloud.test/v1/accounts/acct_personal/angels/golden-assistant", {
        method: "PUT",
        headers: managementHeaders("ensure-1"),
        body: "{}",
      }),
      new Request("https://cloud.test/v1/angels/ang_1/versions", {
        method: "POST",
        headers: managementHeaders("publish-1"),
        body: JSON.stringify({ artifact, expectedDigest: artifact.digest }),
      }),
      new Request("https://cloud.test/v1/angels/ang_1/environments/staging/deployments", {
        method: "POST",
        headers: managementHeaders("stage-1"),
        body: JSON.stringify({
          versionId: "ver_1",
          expectedDigest: artifact.digest,
          bindings: { gmail: ["con_personal_google", "con_work_google"] },
        }),
      }),
      new Request("https://cloud.test/v1/angels/ang_1/environments/production/promotions", {
        method: "POST",
        headers: managementHeaders("prod-1"),
        body: JSON.stringify({
          stagedDeploymentId: "dep_stage_1",
          expectedDigest: artifact.digest,
          bindings: { gmail: ["con_prod_google"] },
        }),
      }),
    ];
    const env = managementEnv();

    for (const request of requests) {
      const response = await handleControlRequest(request, env as never);
      expect(response.status).toBe(200);
    }

    expect(env.registryNames).toEqual(["acct_personal", "acct_personal", "acct_personal", "acct_personal"]);
    expect(env.calls.map((entry) => (entry as { operation: string }).operation)).toEqual([
      "ensure_angel",
      "publish_version",
      "deploy_staging",
      "promote_production",
    ]);
    expect(env.calls[0]).toMatchObject({
      accountId: "acct_personal",
      slug: "golden-assistant",
      mutation: { idempotencyKey: "ensure-1", method: "PUT" },
    });
  });

  test("routes named-key create, rotate, and revoke commands", async () => {
    const requests = [
      new Request("https://cloud.test/v1/angels/ang_1/environments/production/keys", {
        method: "POST",
        headers: managementHeaders("key-create-1"),
        body: JSON.stringify({ name: "CI deploy key" }),
      }),
      new Request("https://cloud.test/v1/angels/ang_1/environments/production/keys/key_abc/rotations", {
        method: "POST",
        headers: managementHeaders("key-rotate-1"),
        body: JSON.stringify({}),
      }),
      new Request("https://cloud.test/v1/angels/ang_1/environments/production/keys/key_abc/revocations", {
        method: "POST",
        headers: managementHeaders("key-revoke-1"),
        body: JSON.stringify({}),
      }),
    ];
    const env = managementEnv();

    for (const request of requests) {
      const response = await handleControlRequest(request, env as never);
      expect(response.status).toBe(200);
    }

    expect(env.calls.map((entry) => (entry as { operation: string }).operation)).toEqual([
      "create_key",
      "rotate_key",
      "revoke_key",
    ]);
    expect(env.calls[0]).toMatchObject({
      angelId: "ang_1",
      environment: "production",
      input: { name: "CI deploy key" },
      mutation: { idempotencyKey: "key-create-1", method: "POST" },
    });
    expect(env.calls[1]).toMatchObject({
      angelId: "ang_1",
      environment: "production",
      input: { keyId: "key_abc" },
      mutation: { idempotencyKey: "key-rotate-1" },
    });
    expect(env.calls[2]).toMatchObject({
      operation: "revoke_key",
      input: { keyId: "key_abc" },
      mutation: { idempotencyKey: "key-revoke-1" },
    });
  });

  test("routes the delete command with an optional slug confirmation", async () => {
    const env = managementEnv();
    const url = "https://cloud.test/v1/accounts/acct_personal/angels/golden-assistant";

    // Bare delete: no body required when production is empty.
    const bare = await handleControlRequest(new Request(url, {
      method: "DELETE",
      headers: managementHeaders("delete-1"),
    }), env as never);
    expect(bare.status).toBe(200);

    // Confirmed delete: the slug typed into the body.
    const confirmed = await handleControlRequest(new Request(url, {
      method: "DELETE",
      headers: managementHeaders("delete-2"),
      body: JSON.stringify({ confirm: "golden-assistant" }),
    }), env as never);
    expect(confirmed.status).toBe(200);

    expect(env.calls).toEqual([
      {
        operation: "delete_angel",
        accountId: "acct_personal",
        slug: "golden-assistant",
        input: {},
        mutation: {
          method: "DELETE",
          path: "/v1/accounts/acct_personal/angels/golden-assistant",
          idempotencyKey: "delete-1",
          body: {},
        },
      },
      {
        operation: "delete_angel",
        accountId: "acct_personal",
        slug: "golden-assistant",
        input: { confirm: "golden-assistant" },
        mutation: {
          method: "DELETE",
          path: "/v1/accounts/acct_personal/angels/golden-assistant",
          idempotencyKey: "delete-2",
          body: { confirm: "golden-assistant" },
        },
      },
    ]);
  });

  test("rejects malformed delete requests before dispatch", async () => {
    const url = "https://cloud.test/v1/accounts/acct_personal/angels/golden-assistant";

    // Unknown body keys are rejected (there is no ?force=true equivalent).
    const unknownKey = managementEnv();
    const forced = await handleControlRequest(new Request(url, {
      method: "DELETE",
      headers: managementHeaders("delete-forced"),
      body: JSON.stringify({ force: true }),
    }), unknownKey as never);
    expect(forced.status).toBe(400);
    expect(await forced.json()).toEqual({ error: "delete accepts only an optional confirm field" });
    expect(unknownKey.calls).toEqual([]);

    // Every mutation requires an Idempotency-Key.
    const missingKey = managementEnv();
    const unkeyed = await handleControlRequest(new Request(url, {
      method: "DELETE",
      headers: managementHeaders(),
    }), missingKey as never);
    expect(unkeyed.status).toBe(400);
    expect(missingKey.calls).toEqual([]);

    // The management credential stays bound to its configured Account.
    const crossAccount = managementEnv();
    const crossed = await handleControlRequest(new Request(
      "https://cloud.test/v1/accounts/acct_other/angels/golden-assistant",
      { method: "DELETE", headers: managementHeaders("delete-crossed") },
    ), crossAccount as never);
    expect(crossed.status).toBe(404);
    expect(crossAccount.calls).toEqual([]);
  });

  test("rejects a create-key request that is missing its name", async () => {
    const env = managementEnv();
    const response = await handleControlRequest(new Request(
      "https://cloud.test/v1/angels/ang_1/environments/production/keys",
      { method: "POST", headers: managementHeaders("key-bad-1"), body: JSON.stringify({}) },
    ), env as never);
    expect(response.status).toBe(400);
    expect(env.calls).toEqual([]);
  });

  test("routes authenticated Connection, Angel, and environment reads without idempotency", async () => {
    const env = managementEnv();
    const requests = [
      "https://cloud.test/v1/accounts/acct_personal/connections",
      "https://cloud.test/v1/accounts/acct_personal/angels/golden-assistant",
      "https://cloud.test/v1/angels/ang_1/environments/staging",
    ];

    for (const url of requests) {
      const response = await handleControlRequest(new Request(url, {
        headers: { authorization: "Bearer management-secret" },
      }), env as never);
      expect(response.status).toBe(200);
    }

    expect(env.calls.map((entry) => (entry as { operation: string }).operation)).toEqual([
      "list_connections",
      "get_angel_by_slug",
      "get_environment",
    ]);
  });

  test("binds the demo management credential to its configured Account", async () => {
    const env = managementEnv();
    const requests = [
      new Request("https://cloud.test/v1/accounts/acct_other/connections", {
        headers: { authorization: "Bearer management-secret" },
      }),
      new Request("https://cloud.test/v1/accounts/acct_other/angels/golden-assistant", {
        method: "PUT",
        headers: managementHeaders("cross-account-ensure"),
        body: "{}",
      }),
    ];

    for (const request of requests) {
      const response = await handleControlRequest(request, env as never);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    }
    expect(env.registryNames).toEqual([]);
    expect(env.calls).toEqual([]);
  });

  test("rejects ergonomic scalar bindings at the API boundary", async () => {
    const env = managementEnv();
    const response = await handleControlRequest(new Request(
      "https://cloud.test/v1/angels/ang_1/environments/staging/deployments",
      {
        method: "POST",
        headers: managementHeaders("stage-scalar"),
        body: JSON.stringify({
          versionId: "ver_1",
          expectedDigest: "f".repeat(64),
          bindings: { gmail: "con_google" },
        }),
      },
    ), env as never);

    expect(response.status).toBe(400);
    expect(env.calls).toEqual([]);
  });

  test("rejects unknown keys nested inside an uploaded artifact", async () => {
    const env = managementEnv();
    const artifact = await versionArtifact();
    const body = {
      artifact: {
        ...artifact,
        tools: artifact.tools.map((tool) => ({ ...tool, deploymentHint: "private" })),
      },
      expectedDigest: artifact.digest,
    };
    const response = await handleControlRequest(new Request(
      "https://cloud.test/v1/angels/ang_1/versions",
      {
        method: "POST",
        headers: managementHeaders("publish-unknown"),
        body: JSON.stringify(body),
      },
    ), env as never);

    expect(response.status).toBe(400);
    expect(env.calls).toEqual([]);
  });

  test("accepts each guard union variant and rejects mixed or unknown guard shapes", async () => {
    const validGuards = [
      { field: "maxResults", pin: "5" },
      { field: "labelIds", forbid: true },
      { field: "addLabelIds", forbiddenValues: ["TRASH", "SPAM"] },
    ];
    for (const [index, guard] of validGuards.entries()) {
      const env = managementEnv();
      const artifact = await versionArtifact();
      artifact.tools[0]!.argGuards = [guard as never];
      const response = await handleControlRequest(new Request(
        "https://cloud.test/v1/angels/ang_1/versions",
        {
          method: "POST",
          headers: managementHeaders(`publish-guard-${index}`),
          body: JSON.stringify({ artifact, expectedDigest: artifact.digest }),
        },
      ), env as never);
      expect(response.status).toBe(200);
      expect(env.calls).toHaveLength(1);
    }

    for (const [index, guard] of [
      { field: "maxResults", pin: "5", forbid: true },
      { field: "maxResults", pin: "5", note: "unknown" },
      { field: "labelIds", forbid: false },
    ].entries()) {
      const env = managementEnv();
      const artifact = await versionArtifact();
      artifact.tools[0]!.argGuards = [guard as never];
      const response = await handleControlRequest(new Request(
        "https://cloud.test/v1/angels/ang_1/versions",
        {
          method: "POST",
          headers: managementHeaders(`publish-invalid-guard-${index}`),
          body: JSON.stringify({ artifact, expectedDigest: artifact.digest }),
        },
      ), env as never);
      expect(response.status).toBe(400);
      expect(env.calls).toEqual([]);
    }
  });

  test("routes strict all, tool, and tool-Connection availability changes", async () => {
    const cases = [
      { kind: "all", enabled: false },
      { kind: "tool", tool: "gmail.users.messages.list", enabled: false },
      {
        kind: "tool_connection",
        tool: "gmail.users.messages.list",
        connectionId: "con_personal_google",
        enabled: false,
      },
    ];
    const env = managementEnv();
    for (const [index, body] of cases.entries()) {
      const response = await handleControlRequest(new Request(
        "https://cloud.test/v1/angels/ang_1/environments/staging/availability",
        {
          method: "POST",
          headers: managementHeaders(`availability-${index}`),
          body: JSON.stringify(body),
        },
      ), env as never);
      expect(response.status).toBe(200);
    }
    expect(env.calls.slice(-3).map((command) => command as { operation: string; input: unknown }))
      .toEqual(cases.map((input) => ({
        operation: "change_availability",
        angelId: "ang_1",
        environment: "staging",
        input,
        mutation: expect.any(Object),
      })));
  });
});

describe("AccountRegistry management persistence", () => {
  test("persists encrypted ensure replay state and dispatches resource reads", async () => {
    const storage = new Map<string, unknown>();
    const registry = new AccountRegistry({
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => storage.set(key, structuredClone(value)),
      },
    } as never, registryEnv() as never);
    const mutation = {
      method: "PUT",
      path: "/v1/accounts/acct_demo/angels/golden-assistant",
      idempotencyKey: "ensure-1",
      body: {},
    };

    const ensured = valueOf(await registry.dispatchJson({
      operation: "ensure_angel",
      accountId: "acct_demo",
      slug: "golden-assistant",
      mutation,
    }));
    const replay = valueOf(await registry.dispatchJson({
      operation: "ensure_angel",
      accountId: "acct_demo",
      slug: "golden-assistant",
      mutation,
    }));
    const bySlug = valueOf(await registry.dispatchJson({
      operation: "get_angel_by_slug",
      accountId: "acct_demo",
      slug: "golden-assistant",
    }));
    const listed = valueOf(await registry.dispatchJson({
      operation: "list_connections",
      accountId: "acct_demo",
    }));

    expect(replay).toEqual(ensured);
    expect(bySlug.id).toBe(ensured.angel.id);
    expect(listed).toHaveLength(2);
    expect(listed.map((connection: { nickname: string }) => connection.nickname)).toEqual([
      "personal-google",
      "work-google",
    ]);
    expect(JSON.stringify(storage.get("management"))).not.toContain(ensured.keys.staging);
    expect(JSON.stringify(storage.get("management"))).not.toContain(ensured.keys.production);
  });

  test("uses the public Angel slug for both gate runtime identities", async () => {
    const storage = new Map<string, unknown>();
    const runtimeIds: string[] = [];
    const gateway = recordingGateService("gateway", runtimeIds);
    const broker = recordingGateService("broker", runtimeIds);
    const registry = new AccountRegistry({
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => storage.set(key, structuredClone(value)),
      },
    } as never, { ...registryEnv(), GATEWAY: gateway, BROKER: broker } as never);
    const ensureMutation = {
      method: "PUT",
      path: "/v1/accounts/acct_demo/angels/golden-assistant",
      idempotencyKey: "ensure-runtime",
      body: {},
    };
    const ensured = valueOf(await registry.dispatchJson({
      operation: "ensure_angel",
      accountId: "acct_demo",
      slug: "golden-assistant",
      mutation: ensureMutation,
    }));
    const artifact = await versionArtifact();
    const publishInput = { artifact, expectedDigest: artifact.digest };
    const version = valueOf(await registry.dispatchJson({
      operation: "publish_version",
      angelId: ensured.angel.id,
      input: publishInput,
      mutation: {
        method: "POST",
        path: `/v1/angels/${ensured.angel.id}/versions`,
        idempotencyKey: "publish-runtime",
        body: publishInput,
      },
    }));
    const stageInput = {
      versionId: version.id,
      expectedDigest: version.digest,
      bindings: { gmail: ["con_personal_google"] },
    };

    valueOf(await registry.dispatchJson({
      operation: "deploy_staging",
      angelId: ensured.angel.id,
      input: stageInput,
      mutation: {
        method: "POST",
        path: `/v1/angels/${ensured.angel.id}/environments/staging/deployments`,
        idempotencyKey: "stage-runtime",
        body: stageInput,
      },
    }));

    expect(new Set(runtimeIds)).toEqual(new Set(["acct_demo:golden-assistant:staging"]));
  });

  // Integration: drive the REAL registry (real ManagementControl behind DO storage)
  // the way the demo surface does. A mocked-registry test cannot catch that the
  // demo Angel SLUG is not the generated Management id — this one does.
  function keyRegistry() {
    const storage = new Map<string, unknown>();
    const runtimeIds: string[] = [];
    const registry = new AccountRegistry({
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => storage.set(key, structuredClone(value)),
      },
    } as never, {
      ...registryEnv(),
      GATEWAY_BASE_URL: "https://gw.test",
      GATEWAY: keyGateService("gateway", runtimeIds),
      BROKER: keyGateService("broker", runtimeIds),
    } as never);
    return registry;
  }

  async function ensureGolden(registry: InstanceType<typeof AccountRegistry>) {
    const ensured = valueOf(await registry.dispatchJson({
      operation: "ensure_angel",
      accountId: "acct_demo",
      slug: "golden-assistant",
      mutation: { method: "PUT", path: "/v1/accounts/acct_demo/angels/golden-assistant", idempotencyKey: "ensure-key-it", body: {} },
    }));
    return ensured as { angel: { id: string } };
  }

  test("demo key_action resolves the SLUG to the generated Angel id and the key appears in the next demo state (finding #1)", async () => {
    const registry = keyRegistry();
    const ensured = await ensureGolden(registry);
    // The crux: the Management id is generated and is NOT the demo slug. Passing the
    // slug straight through as the id (the original bug) 404s in Management.
    expect(ensured.angel.id).not.toBe("golden-assistant");
    expect(ensured.angel.id.startsWith("ang_") || ensured.angel.id.length > "golden-assistant".length).toBe(true);

    const created = valueOf(await registry.dispatchJson({
      operation: "key_action",
      action: "create_key",
      angelId: "golden-assistant",
      environment: "production",
      idempotencyToken: "tok-create-it",
      name: "CI deploy",
    })) as { key: { name: string }; plaintext: string };
    expect(created.key.name).toBe("CI deploy");
    expect(typeof created.plaintext).toBe("string");
    expect(created.plaintext.length).toBeGreaterThan(0);

    const view = valueOf(await registry.dispatchJson({ operation: "state" }));
    const golden = view.angels.find((angel: { id: string }) => angel.id === "golden-assistant");
    expect(golden.environments.production.keys.map((key: { name: string }) => key.name)).toContain("CI deploy");
    // The one-time plaintext is never persisted into the projected state.
    expect(JSON.stringify(view)).not.toContain(created.plaintext);
  });

  test("demo key_action replays on the same client token: identical response incl. plaintext, exactly one key minted (finding #2)", async () => {
    const registry = keyRegistry();
    await ensureGolden(registry);

    const first = valueOf(await registry.dispatchJson({
      operation: "key_action", action: "create_key", angelId: "golden-assistant",
      environment: "production", idempotencyToken: "tok-same", name: "Replayed key",
    })) as { key: { id: string }; plaintext: string };
    const second = valueOf(await registry.dispatchJson({
      operation: "key_action", action: "create_key", angelId: "golden-assistant",
      environment: "production", idempotencyToken: "tok-same", name: "Replayed key",
    })) as { key: { id: string }; plaintext: string };

    // Same token + body → deterministic idempotency key → the committed response
    // (plaintext included) is replayed, not a fresh mint.
    expect(second).toEqual(first);
    const view = valueOf(await registry.dispatchJson({ operation: "state" }));
    const golden = view.angels.find((angel: { id: string }) => angel.id === "golden-assistant");
    const minted = golden.environments.production.keys.filter((key: { name: string }) => key.name === "Replayed key");
    expect(minted).toHaveLength(1);
  });

  test("the SAME client token replayed against a DIFFERENT environment is not a replay — the angel + env bind the identity (round-2 finding #2)", async () => {
    const registry = keyRegistry();
    await ensureGolden(registry);

    const create = (environment: "staging" | "production") => registry.dispatchJson({
      operation: "key_action", action: "create_key", angelId: "golden-assistant",
      environment, idempotencyToken: "shared-token", name: "Same name",
    });

    const prod = valueOf(await create("production")) as { plaintext: string };
    const staging = valueOf(await create("staging")) as { plaintext: string };
    // Same token + same name across two environments must NOT collide onto the
    // first context's sealed plaintext.
    expect(staging.plaintext).not.toBe(prod.plaintext);

    // ...while a genuine same-context replay stays identical.
    const prodReplay = valueOf(await create("production")) as { plaintext: string };
    expect(prodReplay.plaintext).toBe(prod.plaintext);

    const view = valueOf(await registry.dispatchJson({ operation: "state" }));
    const golden = view.angels.find((angel: { id: string }) => angel.id === "golden-assistant");
    // Exactly one "Same name" key per environment — no duplicate from the replay,
    // no cross-context bleed.
    expect(golden.environments.production.keys.filter((key: { name: string }) => key.name === "Same name")).toHaveLength(1);
    expect(golden.environments.staging.keys.filter((key: { name: string }) => key.name === "Same name")).toHaveLength(1);
  });
});

// A gate service stub that accepts the reconcile_keys operation named keys emit on
// mint/rotate/revoke (echoing the hashes) in addition to snapshot/install.
function keyGateService(expectedGate: "gateway" | "broker", runtimeIds: string[]) {
  const installations = new Map<string, unknown>();
  return {
    async fetch(url: string | URL | Request, init?: RequestInit) {
      const target = typeof url === "string" || url instanceof URL ? url.toString() : url.url;
      if (new URL(target).pathname === "/internal/connections") {
        return Response.json(fixtureConnectionSummaries("acct_demo"));
      }
      const request = new Request("https://gate.internal/internal/gate", init);
      const input = await request.json() as {
        operation: "snapshot" | "install" | "reconcile_keys";
        gate: "gateway" | "broker";
        runtimeId: string;
        hashes?: string[];
        command?: import("../../src/gate").GateInstallCommand;
      };
      expect(input.gate).toBe(expectedGate);
      runtimeIds.push(input.runtimeId);
      if (input.operation === "reconcile_keys") {
        return Response.json(input.hashes ?? []);
      }
      if (input.operation === "snapshot") {
        return Response.json({
          schemaVersion: 1,
          gate: expectedGate,
          identity: null,
          installation: installations.get(input.runtimeId) ?? null,
          gatewayKeyHash: null,
          availability: { defaultEnabled: true, overrides: {}, connectionOverrides: {}, revision: 0 },
          deploymentFingerprints: {},
          receipts: [],
          checkpoint: "0".repeat(64),
        });
      }
      const command = input.command!;
      const installation = { ...command, gate: expectedGate, policyDigest: command.artifact.digest, bindingsDigest: "b".repeat(64) };
      installations.set(input.runtimeId, installation);
      return Response.json(installation);
    },
  };
}

function managementHeaders(idempotencyKey?: string) {
  return {
    authorization: "Bearer management-secret",
    "content-type": "application/json",
    ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
  };
}

function managementEnv() {
  const calls: unknown[] = [];
  const registryNames: string[] = [];
  return {
    ACCOUNT_ID: "acct_personal",
    MANAGEMENT_API_TOKEN: "management-secret",
    CONTROL_RESPONSE_KEK: "response-replay-kek",
    DEMO_ADMIN_TOKEN: "admin-secret",
    CONTROL_GATEWAY_TOKEN: "control-gateway-secret",
    CONTROL_BROKER_TOKEN: "control-broker-secret",
    GATEWAY_BASE_URL: "https://gateway.example",
    ACCOUNTS: {
      getByName(name: string) {
        registryNames.push(name);
        return {
          async dispatchJson(command: unknown) {
            calls.push(command);
            return JSON.stringify({ ok: true, value: { accepted: true } });
          },
        };
      },
    },
    ASSETS: { fetch: async () => new Response("asset") },
    calls,
    registryNames,
  };
}

async function versionArtifact() {
  return await compileHostedAngel([
    "name: golden-assistant",
    "charter: deterministic worker fixture",
    "tools:",
    "  - tool: gmail.users.messages.list",
  ].join("\n"));
}

function registryEnv() {
  return {
    ACCOUNT_ID: "acct_demo",
    CONTROL_RESPONSE_KEK: "response-replay-kek",
    CONTROL_GATEWAY_TOKEN: "control-gateway-secret",
    CONTROL_BROKER_TOKEN: "control-broker-secret",
    GATEWAY: { fetch: async () => Response.json({ error: "not used" }, { status: 500 }) },
    BROKER: { fetch: async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      return url.pathname === "/internal/connections"
        ? Response.json(fixtureConnectionSummaries("acct_demo"))
        : Response.json({ error: "not used" }, { status: 500 });
    } },
  };
}

function valueOf(serialized: string) {
  const result = JSON.parse(serialized);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function recordingGateService(expectedGate: "gateway" | "broker", runtimeIds: string[]) {
  const installations = new Map<string, unknown>();
  return {
    async fetch(url: string | URL | Request, init?: RequestInit) {
      const target = typeof url === "string" || url instanceof URL ? url.toString() : url.url;
      if (new URL(target).pathname === "/internal/connections") {
        return Response.json(fixtureConnectionSummaries("acct_demo"));
      }
      const request = new Request("https://gate.internal/internal/gate", init);
      const input = await request.json() as {
        operation: "snapshot" | "install";
        gate: "gateway" | "broker";
        runtimeId: string;
        command?: import("../../src/gate").GateInstallCommand;
      };
      expect(input.gate).toBe(expectedGate);
      runtimeIds.push(input.runtimeId);
      if (input.operation === "snapshot") {
        return Response.json({
          schemaVersion: 1,
          gate: expectedGate,
          identity: null,
          installation: installations.get(input.runtimeId) ?? null,
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
        });
      }
      const command = input.command!;
      const installation = {
        ...command,
        gate: expectedGate,
        policyDigest: command.artifact.digest,
        bindingsDigest: "b".repeat(64),
      };
      installations.set(input.runtimeId, installation);
      return Response.json(installation);
    },
  };
}
