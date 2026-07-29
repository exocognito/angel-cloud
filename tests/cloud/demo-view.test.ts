import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GENERATED_ADAPTERS } from "@smcllns/angel-core";
import vm from "node:vm";
import { MemoryGateFleet } from "../../src/control";
import { sha256Hex } from "@smcllns/angel-core";
import { canonicalJson } from "@smcllns/angel-core";
import {
  AesGcmResponseReplayVault,
  ManagementControl,
  createManagementState,
} from "../../src/management";
import type {
  ManagementBindingMap,
  ManagementVersionArtifact,
  MutationIdentity,
} from "../../src/management-contract";
import { angelEndpoint, assertDemoView, bindingsFitVersion, buildDemoView, type DemoView } from "../../src/demo-view";

const GATEWAY_BASE_URL = "https://gw.test";

describe("angelmcp.demo.v3 projection", () => {
  test("projects two management-published Angels without leaking runtime refs or key hashes", async () => {
    const harness = demoHarness();
    await deployAngel(harness, "gmail-inbox-zero", {
      gmail: ["con_personal_google"],
    });
    const golden = await deployAngel(harness, "golden-assistant", {
      "gdocs-read": ["con_personal_google"],
      "gmail-read-and-draft": ["con_personal_google", "con_work_google"],
    });

    await harness.control.changeAvailability(
      golden.angelId,
      "production",
      {
        kind: "tool_connection",
        tool: "gmail.users.messages.list",
        connectionId: "con_personal_google",
        enabled: false,
      },
      mutation("pause-personal", {}),
    );

    const view = await buildDemoView(
      harness.control.exportState(),
      (_angelId, slug) => harness.fleets.get(slug)!,
      { gatewayBaseUrl: GATEWAY_BASE_URL },
    );

    expect(view.schema).toBe("angelmcp.demo.v3");
    // The producer validates its own output against the exact v3 validator.
    expect(() => assertDemoView(view)).not.toThrow();
    expect(view.angels.map((angel) => angel.id)).toEqual([
      "gmail-inbox-zero",
      "golden-assistant",
    ]);
    const goldenView = view.angels[1]!;

    // Endpoints are first-class per-environment schema, deterministically derived
    // from the real gateway base URL + account/angel/environment (not fabricated).
    expect(goldenView.endpoints).toEqual({
      staging: `${GATEWAY_BASE_URL}/v1/a/acct_demo/golden-assistant/staging/mcp`,
      production: `${GATEWAY_BASE_URL}/v1/a/acct_demo/golden-assistant/production/mcp`,
    });

    // Lifecycle events keep strict per-environment separation: production carries a
    // production_promotion, never a staging_deploy, and vice versa.
    const productionLifecycle = goldenView.environments.production.lifecycle;
    expect(productionLifecycle.map((event) => event.kind)).toEqual([
      "version_published",
      "production_promotion",
    ]);
    expect(productionLifecycle.every((event) => event.environment === "production")).toBe(true);
    expect(productionLifecycle.some((event) => event.kind === "staging_deploy")).toBe(false);
    const stagingLifecycle = goldenView.environments.staging.lifecycle;
    expect(stagingLifecycle.map((event) => event.kind)).toEqual([
      "version_published",
      "staging_deploy",
    ]);
    expect(stagingLifecycle.some((event) => event.kind === "production_promotion")).toBe(false);

    // Real-vs-derived is distinguishable via `source`. These events were performed
    // by the backend under an injected clock, so each carries a recorded ISO `at`;
    // the genuine `order` sequence is still authoritative.
    const promotion = productionLifecycle.find((event) => event.kind === "production_promotion")!;
    expect(promotion).toEqual({
      kind: "production_promotion",
      environment: "production",
      version: goldenView.environments.production.version!,
      deploymentId: goldenView.environments.production.deploymentId,
      order: 1,
      source: "recorded",
      at: DEMO_NOW,
    });
    const published = productionLifecycle.find((event) => event.kind === "version_published")!;
    expect(published.source).toBe("recorded");
    expect(published.at).toBe(DEMO_NOW);
    expect(published.deploymentId).toBeNull();
    expect(published.order).toBe(0);
    for (const event of [...productionLifecycle, ...stagingLifecycle]) {
      expect(["recorded", "derived"]).toContain(event.source);
      expect(event.source === "derived" ? event.at === null : typeof event.at === "string").toBe(true);
    }

    expect(goldenView.environments.production.gateAlignment).toEqual({
      installation: "aligned",
      availability: "aligned",
    });
    expect(goldenView.environments.production.bindings).toEqual([
      {
        id: "gdocs-read",
        provider: "docs",
        connectionIds: ["con_personal_google"],
      },
      {
        id: "gmail-read-and-draft",
        provider: "gmail",
        connectionIds: ["con_personal_google", "con_work_google"],
      },
    ]);
    const gmail = goldenView.environments.production.tools.find(
      (tool) => tool.name === "gmail.users.messages.list",
    )!;
    expect(gmail.connections).toEqual([
      {
        connectionId: "con_personal_google",
        identity: "Personal Google",
        available: false,
      },
      {
        connectionId: "con_work_google",
        identity: "Work Google",
        available: true,
      },
    ]);
    expect(JSON.stringify(view)).not.toContain("arc_");
    expect(JSON.stringify(view)).not.toContain("keyHash");
  });

  test("promotion readiness applies the per-operation scope floor, not the provider label", () => {
    const readonlyConnection = {
      id: "con_readonly",
      accountId: "acct_demo",
      nickname: "readonly-google",
      identityLabel: "Readonly Google",
      credential: "google_oauth" as const,
      providers: ["gmail"],
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      health: "healthy" as const,
    };
    const state = { account: { id: "acct_demo" }, connections: [readonlyConnection] } as never;
    const versionWith = (tools: string[]) => ({
      artifact: {
        bindingRequirements: [{
          id: "gmail",
          source: "gmail",
          provider: "gmail",
          credential: "google_oauth",
          requiredScopes: [],
          tools,
        }],
      },
    }) as never;
    const bindings = { gmail: ["con_readonly"] };

    expect(bindingsFitVersion(state, versionWith(["gmail.users.messages.list"]), bindings)).toBe(true);
    // The provider label alone said "fits"; deploying would 409 on the
    // per-operation floor — the promotion action must not be offered.
    expect(bindingsFitVersion(state, versionWith(["gmail.users.drafts.create"]), bindings)).toBe(false);
    // Registry skew cannot fit either.
    expect(bindingsFitVersion(state, versionWith(["gmail.users.vanished"]), bindings)).toBe(false);
    // Nor can an unhealthy Connection — the deploy floor 409s those too.
    const unhealthy = {
      account: { id: "acct_demo" },
      connections: [{ ...readonlyConnection, health: "error" as const }],
    } as never;
    expect(bindingsFitVersion(unhealthy, versionWith(["gmail.users.messages.list"]), bindings)).toBe(false);
  });

  test("offers only active production bindings for an exact staged promotion", async () => {
    const harness = demoHarness();
    const golden = await deployAngel(harness, "golden-assistant", {
      "gdocs-read": ["con_personal_google"],
      "gmail-read-and-draft": ["con_personal_google", "con_work_google"],
    });
    const artifact = await changedArtifact("golden-assistant");
    const publishBody = { artifact, expectedDigest: artifact.digest };
    const version = await harness.control.publishVersion(
      golden.angelId,
      publishBody,
      mutation("publish-golden-v2", publishBody),
    );
    const stagingBindings = {
      "gdocs-read": ["con_personal_google"],
      "gmail-read-and-draft": ["con_work_google"],
    };
    const stagingBody = {
      versionId: version.id,
      expectedDigest: version.digest,
      bindings: stagingBindings,
    };
    const staging = await harness.control.deployStaging(
      golden.angelId,
      stagingBody,
      mutation("stage-golden-v2", stagingBody),
    );

    const view = await buildDemoView(
      harness.control.exportState(),
      (_angelId, slug) => harness.fleets.get(slug)!,
      { gatewayBaseUrl: GATEWAY_BASE_URL },
    );
    const angel = view.angels[0]!;

    expect(angel.environments.staging.bindings[1]!.connectionIds).toEqual(["con_work_google"]);
    expect(angel.readyForProduction).toMatchObject({
      stagedDeploymentId: staging.id,
      expectedDigest: version.digest,
      bindings: {
        "gdocs-read": ["con_personal_google"],
        "gmail-read-and-draft": ["con_personal_google", "con_work_google"],
      },
    });
  });
});

// Both the producer validator (assertDemoView) and the shipped browser validator
// (www/app.js) must enforce the exact same v3 contract. We EXECUTE the browser
// validator here (not grep its source) by evaluating app.js in a sandboxed VM with
// stubbed DOM/network globals, then run BOTH validators over one shared valid/invalid
// fixture matrix so each invariant is proven rejected on both sides.
type DemoValidator = (value: unknown) => unknown;

function loadBrowserValidator(): DemoValidator {
  const source = readFileSync(new URL("../../www/app.js", import.meta.url), "utf8");
  // A callable proxy that answers every property access and call with itself, so
  // app.js's top-level `document.querySelector(...).addEventListener(...)` wiring
  // and the async bootstrap IIFE run without a real DOM.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anything: any = new Proxy(function () {}, {
    get: () => anything,
    apply: () => anything,
    construct: () => anything,
  });
  const context: Record<string, unknown> = {
    document: anything,
    window: anything,
    localStorage: anything,
    addEventListener: () => {},
    fetch: () => Promise.reject(new Error("no network in unit test")),
    console,
    URL,
    Promise,
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  vm.createContext(context);
  vm.runInContext(`${source}\n;globalThis.__validateDemoState = validateDemoState;`, context, { filename: "app.js" });
  const validate = context.__validateDemoState;
  if (typeof validate !== "function") throw new Error("app.js did not expose validateDemoState");
  return validate as DemoValidator;
}

describe("endpoint construction fails closed on unusable gateway config", () => {
  test("angelEndpoint encodes path segments against an absolute origin", () => {
    expect(angelEndpoint("https://gw.test/", "acct demo", "golden/assistant", "staging")).toBe(
      "https://gw.test/v1/a/acct%20demo/golden%2Fassistant/staging/mcp",
    );
  });

  const badBases = ["", "   ", "/v1/a/x/y/staging/mcp", "gateway.example", "ftp://gw.test", "http://:", "http://x:abc", "http://%", "http://"];
  for (const bad of badBases) {
    test(`angelEndpoint throws on a non-absolute-http(s) base: ${JSON.stringify(bad)}`, () => {
      expect(() => angelEndpoint(bad, "acct_demo", "golden-assistant", "staging")).toThrow(/gateway base URL/);
    });
  }

  test("buildDemoView propagates the fail-closed error rather than emitting a relative endpoint", async () => {
    const harness = demoHarness();
    await deployAngel(harness, "golden-assistant", {
      "gdocs-read": ["con_personal_google"],
      "gmail-read-and-draft": ["con_personal_google", "con_work_google"],
    });
    await expect(
      buildDemoView(
        harness.control.exportState(),
        (_angelId, slug) => harness.fleets.get(slug)!,
        { gatewayBaseUrl: "not-a-url" },
      ),
    ).rejects.toThrow(/gateway base URL/);
  });

  test("EMPTY-account buildDemoView still validates gateway config eagerly (no fail-open)", async () => {
    const harness = demoHarness();
    const emptyState = harness.control.exportState();
    expect(emptyState.angels).toEqual([]);
    const badBases = [
      "", "/relative/path", "gateway.example", "http://:", "http://x:abc",
      // `new URL()` accepts these degenerate hosts; normalizeGatewayOrigin must
      // still reject them via the strict pattern even when no endpoint is built.
      "http://.", "http://-", "http://foo..bar", "http://foo.",
    ];
    for (const bad of badBases) {
      await expect(
        buildDemoView(emptyState, (_angelId, slug) => harness.fleets.get(slug)!, { gatewayBaseUrl: bad }),
      ).rejects.toThrow(/gateway base URL/);
    }
  });

  test("EMPTY-account buildDemoView accepts every legitimate gateway host", async () => {
    const harness = demoHarness();
    const emptyState = harness.control.exportState();
    for (const good of ["http://localhost:8787", "https://gw.example.com", "http://gateway-worker", "http://127.0.0.1:8787"]) {
      const view = await buildDemoView(
        emptyState,
        (_angelId, slug) => harness.fleets.get(slug)!,
        { gatewayBaseUrl: good },
      );
      expect(view.angels).toEqual([]);
    }
  });

  test("EMPTY-account buildDemoView with valid config projects zero Angels", async () => {
    const harness = demoHarness();
    const view = await buildDemoView(
      harness.control.exportState(),
      (_angelId, slug) => harness.fleets.get(slug)!,
      { gatewayBaseUrl: GATEWAY_BASE_URL },
    );
    expect(view.schema).toBe("angelmcp.demo.v3");
    expect(view.angels).toEqual([]);
    expect(() => assertDemoView(view)).not.toThrow();
  });
});

describe("both validators enforce the exact v3 contract over one fixture matrix", () => {
  const browserValidate = loadBrowserValidator();
  let base: DemoView;

  beforeAll(async () => {
    const harness = demoHarness();
    await deployAngel(harness, "golden-assistant", {
      "gdocs-read": ["con_personal_google"],
      "gmail-read-and-draft": ["con_personal_google", "con_work_google"],
    });
    base = await buildDemoView(
      harness.control.exportState(),
      (_angelId, slug) => harness.fleets.get(slug)!,
      { gatewayBaseUrl: GATEWAY_BASE_URL },
    );
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clone = (): any => structuredClone(base);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const productionLifecycle = (v: any) => v.angels[0].environments.production.lifecycle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stagingLifecycle = (v: any) => v.angels[0].environments.staging.lifecycle;

  test("both validators accept the exact v3 view", () => {
    expect(() => assertDemoView(clone())).not.toThrow();
    expect(() => browserValidate(clone())).not.toThrow();
  });

  test("both validators accept a genuine recorded lifecycle event (non-empty ISO `at`)", () => {
    const withRecorded = () => {
      const v = clone();
      const event = productionLifecycle(v).find((e: { kind: string }) => e.kind === "version_published");
      event.source = "recorded";
      event.at = "2026-07-22T00:00:00.000Z";
      return v;
    };
    expect(() => assertDemoView(withRecorded())).not.toThrow();
    expect(() => browserValidate(withRecorded())).not.toThrow();
  });

  test("both validators accept a genuine leap day (2028-02-29)", () => {
    const withLeapDay = () => {
      const v = clone();
      const event = productionLifecycle(v).find((e: { kind: string }) => e.kind === "version_published");
      event.source = "recorded";
      event.at = "2028-02-29T00:00:00Z";
      return v;
    };
    expect(() => assertDemoView(withLeapDay())).not.toThrow();
    expect(() => browserValidate(withLeapDay())).not.toThrow();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invalidCases: Array<{ name: string; mutate: (v: any) => void }> = [
    { name: "old v2 schema id (no soft fallback)", mutate: (v) => { v.schema = "angelmcp.demo.v2"; } },
    { name: "missing first-class endpoints", mutate: (v) => { delete v.angels[0].endpoints; } },
    { name: "endpoint that is a relative path (not absolute)", mutate: (v) => { v.angels[0].endpoints.production = "/v1/a/acct_demo/golden-assistant/production/mcp"; } },
    { name: "endpoint without a scheme", mutate: (v) => { v.angels[0].endpoints.production = "gateway.example/v1/a/x/y/production/mcp"; } },
    { name: "endpoint with a non-http(s) scheme", mutate: (v) => { v.angels[0].endpoints.staging = "ftp://gw.test/x"; } },
    { name: "endpoint with an empty authority (http://:)", mutate: (v) => { v.angels[0].endpoints.production = "http://:/mcp"; } },
    { name: "endpoint with no host (http://)", mutate: (v) => { v.angels[0].endpoints.production = "http://"; } },
    { name: "endpoint with a non-numeric port (http://x:abc)", mutate: (v) => { v.angels[0].endpoints.production = "http://x:abc/mcp"; } },
    { name: "endpoint with a malformed host (http://%)", mutate: (v) => { v.angels[0].endpoints.staging = "http://%"; } },
    { name: "endpoint host that is a bare dot (http://.)", mutate: (v) => { v.angels[0].endpoints.production = "http://./mcp"; } },
    { name: "endpoint host that is a bare hyphen (http://-)", mutate: (v) => { v.angels[0].endpoints.production = "http://-/mcp"; } },
    { name: "endpoint host with an empty interior label (http://foo..bar)", mutate: (v) => { v.angels[0].endpoints.production = "http://foo..bar/mcp"; } },
    { name: "endpoint host with a trailing dot (http://foo.)", mutate: (v) => { v.angels[0].endpoints.staging = "http://foo./mcp"; } },
    { name: "environment missing its lifecycle field", mutate: (v) => { delete v.angels[0].environments.production.lifecycle; } },
    // (a) Environment interleaved across the boundary, KIND left valid-for-both so
    //     ONLY the environment-vs-container rule can reject it.
    { name: "lifecycle event environment != its container (kind left valid)", mutate: (v) => {
        const event = productionLifecycle(v).find((e: { kind: string }) => e.kind === "version_published");
        event.environment = "staging";
      } },
    // (b) Kind wrong-for-environment, ENVIRONMENT left matching the container so
    //     ONLY the kind-vs-environment rule can reject it.
    { name: "lifecycle kind wrong for its environment (environment left matching)", mutate: (v) => {
        const event = stagingLifecycle(v).find((e: { kind: string }) => e.kind === "staging_deploy");
        event.kind = "production_promotion";
      } },
    { name: "recorded event with a null timestamp", mutate: (v) => {
        const event = productionLifecycle(v)[0];
        event.source = "recorded";
        event.at = null;
      } },
    { name: "recorded event with an empty timestamp", mutate: (v) => {
        const event = productionLifecycle(v)[0];
        event.source = "recorded";
        event.at = "";
      } },
    { name: "derived event carrying a fabricated timestamp", mutate: (v) => {
        const event = productionLifecycle(v)[0];
        event.source = "derived";
        event.at = "2026-07-22T00:00:00.000Z";
      } },
    { name: "environment missing its keys field", mutate: (v) => { delete v.angels[0].environments.production.keys; } },
    { name: "agent key exposing a secret hash", mutate: (v) => { v.angels[0].environments.production.keys[0].hash = "x"; } },
    { name: "agent key with an unknown status", mutate: (v) => { v.angels[0].environments.production.keys[0].status = "paused"; } },
    // Strict ISO-8601 UTC enforcement — a bare non-empty string is NOT a timestamp.
    { name: "recorded lifecycle event with a non-ISO `at`", mutate: (v) => {
        const event = productionLifecycle(v).find((e: { source: string }) => e.source === "recorded");
        event.at = "not-an-iso-time";
      } },
    { name: "recorded lifecycle event with an impossible ISO date", mutate: (v) => {
        const event = productionLifecycle(v).find((e: { source: string }) => e.source === "recorded");
        event.at = "2026-13-45T99:99:99Z";
      } },
    // Nonexistent calendar dates that pass the regex but Date.parse silently rolls
    // over — each must be rejected by the round-trip check.
    { name: "recorded `at` on a nonexistent day (2026-02-30)", mutate: (v) => {
        productionLifecycle(v).find((e: { source: string }) => e.source === "recorded").at = "2026-02-30T00:00:00Z";
      } },
    { name: "recorded `at` on a non-leap Feb 29 (2025-02-29)", mutate: (v) => {
        productionLifecycle(v).find((e: { source: string }) => e.source === "recorded").at = "2025-02-29T00:00:00Z";
      } },
    { name: "recorded `at` on an impossible April 31 (2026-04-31)", mutate: (v) => {
        productionLifecycle(v).find((e: { source: string }) => e.source === "recorded").at = "2026-04-31T12:00:00Z";
      } },
    { name: "key createdAt on a nonexistent day (2026-02-30)", mutate: (v) => {
        v.angels[0].environments.production.keys[0].createdAt = "2026-02-30T00:00:00Z";
      } },
    { name: "agent key createdAt that is not ISO-8601 UTC", mutate: (v) => {
        v.angels[0].environments.production.keys[0].createdAt = "yesterday";
      } },
    { name: "agent key revokedAt that omits the trailing Z", mutate: (v) => {
        v.angels[0].environments.production.keys[0].revokedAt = "2026-07-22T00:00:00";
      } },
    { name: "environment availability missing its changedAt field", mutate: (v) => { delete v.angels[0].environments.production.availability.changedAt; } },
    { name: "availability changedAt recorded with a non-ISO `at`", mutate: (v) => {
        v.angels[0].environments.production.availability.changedAt = { source: "recorded", at: "not-an-iso-time" };
      } },
    { name: "availability changedAt derived but carrying a timestamp", mutate: (v) => {
        v.angels[0].environments.production.availability.changedAt = { source: "derived", at: "2026-07-22T00:00:00.000Z" };
      } },
    { name: "availability changedAt with an unknown source", mutate: (v) => {
        v.angels[0].environments.production.availability.changedAt = { source: "guessed", at: null };
      } },
    { name: "unknown extra field on an angel", mutate: (v) => { v.angels[0].surprise = true; } },
  ];

  for (const { name, mutate } of invalidCases) {
    test(`both validators reject: ${name}`, () => {
      const producerInput = clone();
      mutate(producerInput);
      expect(() => assertDemoView(producerInput)).toThrow();
      const browserInput = clone();
      mutate(browserInput);
      expect(() => browserValidate(browserInput)).toThrow();
    });
  }

  // GUARDRAIL: legitimate gateway hosts must keep validating on BOTH sides — the
  // tightened DNS-label pattern must never regress these.
  const legitimateEndpoints = [
    "http://localhost:8787/v1/mcp",
    "https://gw.example.com/v1/a/x/y/staging/mcp",
    "http://gateway-worker/v1/mcp",
    "http://127.0.0.1:8787/v1/mcp",
  ];
  for (const endpoint of legitimateEndpoints) {
    test(`both validators accept the legitimate host: ${endpoint}`, () => {
      const producerInput = clone();
      producerInput.angels[0].endpoints.production = endpoint;
      expect(() => assertDemoView(producerInput)).not.toThrow();
      const browserInput = clone();
      browserInput.angels[0].endpoints.production = endpoint;
      expect(() => browserValidate(browserInput)).not.toThrow();
    });
  }
});

function demoHarness() {
  const fleets = new Map<string, MemoryGateFleet>();
  let id = 0;
  const control = ManagementControl.restore(createManagementState({
    account: { id: "acct_demo", name: "Personal" },
    connections: [
      {
        id: "con_personal_google",
        accountId: "acct_demo",
        nickname: "personal-google",
        identityLabel: "Personal Google",
        credential: "google_oauth",
        providers: ["gmail", "docs"],
        grantedScopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/gmail.labels",
          "https://www.googleapis.com/auth/documents.readonly",
        ],
        health: "healthy",
      },
      {
        id: "con_work_google",
        accountId: "acct_demo",
        nickname: "work-google",
        identityLabel: "Work Google",
        credential: "google_oauth",
        providers: ["gmail"],
        grantedScopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
        ],
        health: "healthy",
      },
    ],
  }), {
    replayVault: new AesGcmResponseReplayVault("demo-view-test-kek"),
    fleetFor: (_angelId, slug) => {
      const fleet = fleets.get(slug) ?? new MemoryGateFleet();
      fleets.set(slug, fleet);
      return fleet;
    },
    randomId: (prefix) => `${prefix}_${++id}`,
    checkpoint: { async persist() {} },
    now: () => DEMO_NOW,
  });
  return { control, fleets };
}

const DEMO_NOW = "2026-07-22T09:30:00.000Z";

async function deployAngel(
  harness: ReturnType<typeof demoHarness>,
  slug: string,
  bindings: ManagementBindingMap,
) {
  const ensured = await harness.control.ensureAngel(
    "acct_demo",
    slug,
    mutation(`ensure-${slug}`, {}),
  );
  const artifact = checkedArtifact(slug);
  const publishBody = { artifact, expectedDigest: artifact.digest };
  const version = await harness.control.publishVersion(
    ensured.angel.id,
    publishBody,
    mutation(`publish-${slug}`, publishBody),
  );
  const stagingBody = { versionId: version.id, expectedDigest: version.digest, bindings };
  const staging = await harness.control.deployStaging(
    ensured.angel.id,
    stagingBody,
    mutation(`stage-${slug}`, stagingBody),
  );
  const productionBody = {
    stagedDeploymentId: staging.id,
    expectedDigest: staging.digest,
    bindings,
  };
  await harness.control.promoteProduction(
    ensured.angel.id,
    productionBody,
    mutation(`promote-${slug}`, productionBody),
  );
  return { angelId: ensured.angel.id, version, staging };
}

function checkedArtifact(slug: string): ManagementVersionArtifact {
  const canonicalSource = readFileSync(
    new URL(`../../angels/${slug}/build/angel.version.json`, import.meta.url),
    "utf8",
  ).trim();
  const digest = readFileSync(
    new URL(`../../angels/${slug}/build/angel.version.sha256`, import.meta.url),
    "utf8",
  ).trim();
  return { ...JSON.parse(canonicalSource), canonicalSource, digest };
}

async function changedArtifact(slug: string): Promise<ManagementVersionArtifact> {
  const current = checkedArtifact(slug);
  const content = {
    format: current.format,
    name: current.name,
    charter: current.charter,
    children: current.children,
    providers: current.providers,
    bindingRequirements: current.bindingRequirements.map((requirement) => requirement.provider === "gmail"
      ? { ...requirement, tools: [...requirement.tools, "gmail.users.labels.list"].sort() }
      : requirement),
    tools: [...current.tools, {
      name: "gmail.users.labels.list",
      provider: "gmail",
      operation: "gmail.users.labels.list",
      argGuards: [],
      request: GENERATED_ADAPTERS.gmail!.operations["gmail.users.labels.list"]!.request,
    }].sort((left, right) => left.name.localeCompare(right.name)),
  };
  const canonicalSource = canonicalJson(content);
  return { ...content, canonicalSource, digest: await sha256Hex(canonicalSource) };
}

function mutation(idempotencyKey: string, body: unknown): MutationIdentity {
  return { method: "POST", path: `/demo/${idempotencyKey}`, idempotencyKey, body };
}

describe("angelmcp.demo.v3 recorded/derived timestamps and named keys", () => {
  const goldenBindings: ManagementBindingMap = {
    "gdocs-read": ["con_personal_google"],
    "gmail-read-and-draft": ["con_personal_google", "con_work_google"],
  };

  test("a state persisted without recorded timestamps keeps every lifecycle event derived", async () => {
    const harness = demoHarness();
    await deployAngel(harness, "golden-assistant", goldenBindings);
    const state = harness.control.exportState();
    delete state.timestamps; // emulate a pre-timestamp persisted state; nothing is back-filled

    const view = await buildDemoView(
      state,
      (_angelId, slug) => harness.fleets.get(slug)!,
      { gatewayBaseUrl: GATEWAY_BASE_URL },
    );
    const events = [
      ...view.angels[0]!.environments.production.lifecycle,
      ...view.angels[0]!.environments.staging.lifecycle,
    ];
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event).toMatchObject({ source: "derived", at: null });
    expect(() => assertDemoView(view)).not.toThrow();
  });

  test("surfaces named keys per environment (id, status, recorded times) and never a hash", async () => {
    const harness = demoHarness();
    const golden = await deployAngel(harness, "golden-assistant", goldenBindings);
    const created = await harness.control.createKey(
      golden.angelId,
      "production",
      { name: "agent" },
      mutation("create-agent", { name: "agent" }),
    );
    await harness.control.revokeKey(
      golden.angelId,
      "production",
      { keyId: created.key.id },
      mutation("revoke-agent", { keyId: created.key.id }),
    );

    const view = await buildDemoView(
      harness.control.exportState(),
      (_angelId, slug) => harness.fleets.get(slug)!,
      { gatewayBaseUrl: GATEWAY_BASE_URL },
    );
    const keys = view.angels[0]!.environments.production.keys;
    // The migrated Default key stays active; the created key is now revoked.
    expect(keys.map((key) => key.status).sort()).toEqual(["active", "revoked"]);
    expect(keys.find((key) => key.id === created.key.id)).toMatchObject({
      status: "revoked",
      revokedAt: DEMO_NOW,
      createdAt: DEMO_NOW,
    });
    expect(JSON.stringify(view)).not.toContain("hash");
    expect(() => assertDemoView(view)).not.toThrow();
  });

  test("surfaces availability changedAt: derived before any change, recorded after", async () => {
    const harness = demoHarness();
    const golden = await deployAngel(harness, "golden-assistant", goldenBindings);

    const before = await buildDemoView(
      harness.control.exportState(),
      (_angelId, slug) => harness.fleets.get(slug)!,
      { gatewayBaseUrl: GATEWAY_BASE_URL },
    );
    // No availability change has been recorded yet — derived, never fabricated.
    expect(before.angels[0]!.environments.production.availability.changedAt)
      .toEqual({ source: "derived", at: null });

    await harness.control.changeAvailability(
      golden.angelId,
      "production",
      { kind: "all", enabled: false },
      mutation("pause-all", { kind: "all", enabled: false }),
    );

    const after = await buildDemoView(
      harness.control.exportState(),
      (_angelId, slug) => harness.fleets.get(slug)!,
      { gatewayBaseUrl: GATEWAY_BASE_URL },
    );
    expect(after.angels[0]!.environments.production.availability.changedAt)
      .toEqual({ source: "recorded", at: DEMO_NOW });
    expect(() => assertDemoView(after)).not.toThrow();
  });
});
