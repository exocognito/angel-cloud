import { describe, expect, mock, test } from "bun:test";
import { compileHostedAngel } from "@smcllns/angel-core";
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
    accountId: (env as { ACCOUNT_ID: string }).ACCOUNT_ID,
    subject: "test-access-subject",
  }));
const { AccountRegistry } = await import("../../src/workers/account-registry");

const ACCOUNT_ID = "acct_demo";

describe("management routes speak preview; staging stays a served legacy dialect", () => {
  test("GET environments/preview answers canonically and GET environments/staging answers in the legacy spelling", async () => {
    const h = await deployedHarness();

    const preview = await h.request("GET", `/v1/angels/${h.angelId}/environments/preview`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ environment: "preview" });

    const legacy = await h.request("GET", `/v1/angels/${h.angelId}/environments/staging`);
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toMatchObject({ environment: "staging" });
  });

  test("POST environments/preview/deployments deploys the second environment canonically", async () => {
    const h = await harness();
    const deployed = await h.request(
      "POST",
      `/v1/angels/${h.angelId}/environments/preview/deployments`,
      { versionId: h.versionId, expectedDigest: h.digest, bindings: { "gmail": ["con_personal_google"] } },
      "deploy-preview-1",
    );
    expect(deployed.status).toBe(200);
    expect(await deployed.json()).toMatchObject({ environment: "preview", digest: h.digest });
  });

  test("legacy staging deployments route still answers with staging-spelled responses", async () => {
    const h = await harness();
    const deployed = await h.request(
      "POST",
      `/v1/angels/${h.angelId}/environments/staging/deployments`,
      { versionId: h.versionId, expectedDigest: h.digest, bindings: { "gmail": ["con_personal_google"] } },
      "deploy-legacy-1",
    );
    expect(deployed.status).toBe(200);
    expect(await deployed.json()).toMatchObject({ environment: "staging", digest: h.digest });
  });

  test("the ensure response keeps the pinned CLI's exact staging-spelled shape", async () => {
    const h = await harness();
    // The angel was ensured in the harness; a replayed ensure returns the same view.
    const ensured = await h.request(
      "PUT",
      `/v1/accounts/${ACCOUNT_ID}/angels/golden-assistant`,
      {},
      "ensure-again",
    );
    expect(ensured.status).toBe(200);
    const body = await ensured.json() as { angel: { environments: Record<string, unknown> } };
    expect(Object.keys(body.angel.environments).sort()).toEqual(["production", "staging"]);
  });

  test("POST environments/production/deployments takes a Version live in one step", async () => {
    const h = await harness();
    const deployed = await h.request(
      "POST",
      `/v1/angels/${h.angelId}/environments/production/deployments`,
      { versionId: h.versionId, expectedDigest: h.digest, bindings: { "gmail": ["con_personal_google"] } },
      "deploy-production-1",
    );
    expect(deployed.status).toBe(200);
    expect(await deployed.json()).toMatchObject({ environment: "production", digest: h.digest });

    const view = await h.request("GET", `/v1/angels/${h.angelId}/environments/production`);
    expect(await view.json()).toMatchObject({
      environment: "production",
      activeDeployment: { digest: h.digest },
    });
  });

  test("a preview deploy with no bindings fails naming both ways forward", async () => {
    const h = await harness();
    const deployed = await h.request(
      "POST",
      `/v1/angels/${h.angelId}/environments/preview/deployments`,
      { versionId: h.versionId, expectedDigest: h.digest, bindings: {} },
      "deploy-preview-unbound",
    );
    expect(deployed.status).toBe(400);
    expect(await deployed.json()).toEqual({
      error: "preview has no Connection bindings: bind a Connection to preview, or pass production's bindings explicitly to share its credentials",
    });
  });

  test("latest is not an environment: the route 404s", async () => {
    const h = await harness();
    const response = await h.request("GET", `/v1/angels/${h.angelId}/environments/latest`);
    expect(response.status).toBe(404);
  });
});

describe("pre-rename persisted state served by the worker", () => {
  test("a staging-keyed persisted state still renders the demo view and replays ensure safely", async () => {
    const h = await deployedHarness();

    // Rewrite the persisted management state into its pre-rename shape:
    // environments keyed `staging`, deployments recorded as "staging", and
    // idempotency records whose stored responses carry the old spellings.
    const persisted = structuredClone(h.storage.get("management")) as {
      angels: Array<{ environments: Record<string, unknown> }>;
      deployments: Array<{ environment: string }>;
      idempotency: Record<string, unknown>;
    };
    for (const angel of persisted.angels) {
      angel.environments.staging = angel.environments.preview;
      delete angel.environments.preview;
    }
    for (const deployment of persisted.deployments) {
      if (deployment.environment === "preview") deployment.environment = "staging";
    }
    expect(Object.keys(persisted.idempotency).length).toBeGreaterThan(0);
    h.storage.set("management", persisted);

    // The dashboard read must migrate on read, not crash.
    const state = await h.request("GET", "/api/demo/state");
    expect(state.status).toBe(200);
    const view = await state.json() as { schema: string; angels: Array<{ environments: Record<string, unknown> }> };
    expect(view.schema).toBe("angelmcp.demo.v4");
    expect(Object.keys(view.angels[0]!.environments).sort()).toEqual(["preview", "production"]);

    // A pre-rename idempotency key never surfaces a stale spelling: the
    // record survives migration and its replay is canonicalized
    // (canonicalizeLegacyReplay) before the legacy-dialect translation.
    const ensured = await h.request(
      "PUT",
      `/v1/accounts/${ACCOUNT_ID}/angels/golden-assistant`,
      {},
      "ensure-1",
    );
    expect(ensured.status).toBe(200);
    const body = await ensured.json() as { angel: { environments: Record<string, unknown> } };
    expect(Object.keys(body.angel.environments).sort()).toEqual(["production", "staging"]);
  });
});

describe("account handle read-back", () => {
  test("GET /v1/accounts/{account}/handle returns the current claim and 404 before any claim", async () => {
    const h = await harness();

    const unclaimed = await h.request("GET", `/v1/accounts/${ACCOUNT_ID}/handle`);
    expect(unclaimed.status).toBe(404);

    const claimed = await h.request("PUT", `/v1/accounts/${ACCOUNT_ID}/handle`, { handle: "golden-demo" });
    expect(claimed.status).toBe(200);

    const read = await h.request("GET", `/v1/accounts/${ACCOUNT_ID}/handle`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      accountId: ACCOUNT_ID,
      handle: "golden-demo",
      retiredHandle: null,
    });
  });

  test("reading the handle backfills the display copy for claims made before the push existed", async () => {
    const h = await harness();
    await h.request("PUT", `/v1/accounts/${ACCOUNT_ID}/handle`, { handle: "golden-demo" });

    // Simulate a claim from before the display push: the directory has the
    // claim but the Account's management state does not.
    const persisted = structuredClone(h.storage.get("management")) as { account: { handle?: string } };
    delete persisted.account.handle;
    h.storage.set("management", persisted);

    const read = await h.request("GET", `/v1/accounts/${ACCOUNT_ID}/handle`);
    expect(read.status).toBe(200);
    const restored = h.storage.get("management") as { account: { handle?: string } };
    expect(restored.account.handle).toBe("golden-demo");
  });
});

async function versionArtifact() {
  return await compileHostedAngel([
    "name: golden-assistant",
    "charter: deterministic preview-route fixture",
    "tools:",
    "  - tool: gmail.users.messages.list",
  ].join("\n"));
}

async function harness() {
  const storage = new Map<string, unknown>();
  const registries = new Map<string, InstanceType<typeof AccountRegistry>>();
  const gatewayRequests: string[] = [];
  const gatewayGates = gateFleetStub();
  const brokerGates = gateFleetStub();
  const registryEnv = {
    ACCOUNT_ID,
    CONTROL_RESPONSE_KEK: "response-replay-kek",
    CONTROL_GATEWAY_TOKEN: "control-gateway-secret",
    CONTROL_BROKER_TOKEN: "control-broker-secret",
    GATEWAY_BASE_URL: "https://gateway.example",
    GATEWAY: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        const url = new URL(request.url);
        gatewayRequests.push(url.pathname);
        if (url.pathname === "/internal/handles") return Response.json({ ok: true });
        return gatewayGates.fetch(request);
      },
    },
    BROKER: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        const url = new URL(request.url);
        if (url.pathname === "/internal/connections") {
          return Response.json(fixtureConnectionSummaries(ACCOUNT_ID));
        }
        return brokerGates.fetch(request);
      },
    },
  };
  const controlEnv = {
    ...registryEnv,
    MANAGEMENT_API_TOKEN: "management-secret",
    DEMO_ADMIN_TOKEN: "admin-secret",
    ACCOUNTS: {
      getByName(name: string) {
        let registry = registries.get(name);
        if (registry === undefined) {
          registry = new AccountRegistry(
            storageContext(name === ACCOUNT_ID ? storage : new Map(), name) as never,
            registryEnv as never,
          );
          registries.set(name, registry);
        }
        return registry;
      },
    },
    ASSETS: { fetch: async () => new Response("asset") },
  };

  const request = async (method: string, path: string, body?: unknown, idempotencyKey?: string) =>
    handleControlRequest(new Request(`https://cloud.test${path}`, {
      method,
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), controlEnv as never);

  const ensured = await request("PUT", `/v1/accounts/${ACCOUNT_ID}/angels/golden-assistant`, {}, "ensure-1");
  if (ensured.status !== 200) throw new Error(`ensure failed: ${await ensured.text()}`);
  const angel = (await ensured.json() as { angel: { id: string } }).angel;
  const artifact = await versionArtifact();
  const published = await request(
    "POST",
    `/v1/angels/${angel.id}/versions`,
    { artifact, expectedDigest: artifact.digest },
    "publish-1",
  );
  if (published.status !== 200) throw new Error(`publish failed: ${await published.text()}`);
  const version = await published.json() as { id: string; digest: string };

  return { request, angelId: angel.id, versionId: version.id, digest: version.digest, gatewayRequests, storage };
}

/** A harness with a preview deployment already installed. */
async function deployedHarness() {
  const h = await harness();
  const deployed = await h.request(
    "POST",
    `/v1/angels/${h.angelId}/environments/preview/deployments`,
    { versionId: h.versionId, expectedDigest: h.digest, bindings: { "gmail": ["con_personal_google"] } },
    "deploy-setup",
  );
  if (deployed.status !== 200) throw new Error(`deploy failed: ${await deployed.text()}`);
  return h;
}

function gateFleetStub() {
  const gates = new Map<string, unknown>();
  return {
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const body = await request.json() as {
        operation: string;
        runtimeId: string;
        command?: Record<string, unknown> & { artifact?: { digest?: string } };
        hashes?: string[];
      };
      const key = body.runtimeId;
      if (body.operation === "install") {
        const installation = {
          ...body.command,
          gate: "gateway",
          policyDigest: body.command!.artifact!.digest,
          bindingsDigest: "f".repeat(64),
        };
        gates.set(key, installation);
        return Response.json(installation);
      }
      if (body.operation === "snapshot") {
        return Response.json({
          schemaVersion: 1,
          gate: "gateway",
          identity: null,
          installation: gates.get(key) ?? null,
          gatewayKeyHash: null,
          availability: { defaultEnabled: true, overrides: {}, connectionOverrides: {}, revision: 0 },
          deploymentFingerprints: {},
          receipts: [],
          checkpoint: "0".repeat(64),
        });
      }
      if (body.operation === "reconcile_keys") return Response.json(body.hashes ?? []);
      if (body.operation === "reset") return Response.json({ ok: true });
      if (body.operation === "availability") {
        return Response.json({ defaultEnabled: true, overrides: {}, connectionOverrides: {}, revision: 1 });
      }
      return Response.json({ error: `unhandled gate operation ${body.operation}` }, { status: 500 });
    },
  };
}

function storageContext(storage: Map<string, unknown>, name = "acct_demo") {
  return {
    id: { name },
    storage: {
      get: async (key: string) => structuredClone(storage.get(key)),
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "string") {
          storage.set(key, structuredClone(value));
        } else {
          for (const [entryKey, entryValue] of Object.entries(key)) {
            storage.set(entryKey, structuredClone(entryValue));
          }
        }
      },
      delete: async (key: string) => storage.delete(key),
      deleteAll: async () => storage.clear(),
    },
  };
}
