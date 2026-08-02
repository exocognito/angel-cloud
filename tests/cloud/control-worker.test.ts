import { GENERATED_ADAPTERS } from "@smcllns/angel-core";
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DemoView } from "../../src/demo-view";
import type { ManagementState } from "../../src/management-contract";
import {
  dispatchGate,
  HttpError,
  requireInternalRequest,
  type GateInternalRequest,
} from "../../src/workers/protocol";
import { AccessAuthenticationError } from "../../src/access";
import { fixtureConnectionSummaries, fakeCredentialVaults } from "./fake-vault";

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

const { ServiceGateFleet } = await import("../../src/workers/service-gate-fleet");
const { handleControlRequest: handleControlRequestReal } = await import("../../src/workers/control");
const handleControlRequest = (request: Request, env: Record<string, unknown>) =>
  env.ACCESS_REQUIRED === "true"
    ? handleControlRequestReal(request, env as never)
    : handleControlRequestReal(request, env as never, async () => ({
        accountId: (env.ACCOUNT_ID ?? env.DEMO_ACCOUNT_ID) as string,
        subject: "test-access-subject",
      }));
const { AccountRegistry } = await import("../../src/workers/account-registry");
const { handleGatewayRequest } = await import("../../src/workers/gateway");
const { handleBrokerRequest } = await import("../../src/workers/broker");

describe("ServiceGateFleet", () => {
  test("serializes a gate reset as JSON null instead of undefined", async () => {
    const namespace = {
      getByName() {
        return { reset: async () => undefined };
      },
    };
    const result = await dispatchGate(namespace as never, {
      operation: "reset",
      gate: "broker",
      runtimeId: "acct:angel:preview",
    });

    expect(result).toBeNull();
  });

  test("routes exact runtime identity and the gate-specific control token", async () => {
    const calls: Array<{ service: string; input: GateInternalRequest; authorization: string | null }> = [];
    const fetcher = (service: string, result: unknown) => ({
      async fetch(_url: string, init?: RequestInit) {
        const request = new Request("https://service.internal/internal/gate", init);
        calls.push({
          service,
          input: await request.json() as GateInternalRequest,
          authorization: request.headers.get("authorization"),
        });
        return Response.json(result);
      },
    });
    const fleet = new ServiceGateFleet({
      accountId: "acct_demo",
      angelId: "golden-research-assistant",
      gatewayControlToken: "control-gateway-secret",
      brokerControlToken: "control-broker-secret",
      gateway: fetcher("gateway", { schemaVersion: 1, gate: "gateway", receipts: [] }),
      broker: fetcher("broker", { schemaVersion: 1, gate: "broker", receipts: [] }),
    });

    await fleet.snapshot("gateway", "production");
    await fleet.reset("broker", "preview");

    expect(calls).toEqual([
      {
        service: "gateway",
        authorization: "Bearer control-gateway-secret",
        input: {
          operation: "snapshot",
          gate: "gateway",
          runtimeId: "acct_demo:golden-research-assistant:production",
        },
      },
      {
        service: "broker",
        authorization: "Bearer control-broker-secret",
        input: {
          operation: "reset",
          gate: "broker",
          runtimeId: "acct_demo:golden-research-assistant:preview",
        },
      },
    ]);
  });

  test("surfaces a failed gate response", async () => {
    const failing = { fetch: async () => Response.json({ error: "gate exploded" }, { status: 500 }) };
    const fleet = new ServiceGateFleet({
      accountId: "acct_demo",
      angelId: "angel_demo",
      gatewayControlToken: "gateway-secret",
      brokerControlToken: "broker-secret",
      gateway: failing,
      broker: failing,
    });

    await expect(fleet.snapshot("gateway", "preview")).rejects.toThrow("gate exploded");
  });
});

describe("Worker role credentials", () => {
  const gateCommand: GateInternalRequest = {
    operation: "snapshot",
    gate: "gateway",
    runtimeId: "acct:angel:production",
  };

  test("rejects a wrong internal bearer through the shared timing-safe verifier", async () => {
    const request = new Request("https://gate.internal/internal/gate", {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-broker-invoke",
        "content-type": "application/json",
      },
      body: JSON.stringify(gateCommand),
    });

    await expect(requireInternalRequest(request, "control-gateway")).rejects.toBeInstanceOf(HttpError);
  });

  test("shared bearer verification rejects unconfigured expectations and absent tokens before parsing", async () => {
    for (const expected of [undefined, ""]) {
      const request = new Request("https://gate.internal/internal/gate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      await expect(requireInternalRequest(request, expected as never)).rejects.toMatchObject({
        status: 500,
        message: "configured bearer credential must be non-empty",
      });
    }
    for (const authorization of [undefined, "Bearer "]) {
      const request = new Request("https://gate.internal/internal/gate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        body: "{",
      });
      await expect(requireInternalRequest(request, "control-gateway")).rejects.toMatchObject({
        status: 401,
        message: "unauthorized internal request",
      });
    }
  });

  test("control credentials cannot evaluate calls or verify gate internals", async () => {
    for (const operation of ["evaluate", "verify"]) {
      const request = new Request("https://gate.internal/internal/gate", {
        method: "POST",
        headers: {
          authorization: "Bearer control-gateway",
          "content-type": "application/json",
        },
        body: JSON.stringify({ operation, gate: "gateway", runtimeId: "acct:angel:production" }),
      });

      await expect(requireInternalRequest(request, "control-gateway")).rejects.toMatchObject({
        status: 400,
        message: "unknown internal operation",
      });
    }
  });

  test("Gateway accepts only the Control-to-Gateway credential on its control API", async () => {
    const env = {
      CONTROL_GATEWAY_TOKEN: "control-gateway",
      GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-invoke",
      GATES: {
        getByName() {
          return { snapshot: async () => ({ gate: "gateway" }) };
        },
      },
    } as never;
    const request = (token: string) => new Request("https://gateway.internal/internal/gate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(gateCommand),
    });
    const accepted = await handleGatewayRequest(request("control-gateway"), env);
    const rejected = await handleGatewayRequest(request("gateway-broker-invoke"), env);

    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(401);
  });

  test("Gateway fails every path closed before parsing when internal role credentials are equal", async () => {
    const env = {
      CONTROL_GATEWAY_TOKEN: "collapsed-gateway-role",
      GATEWAY_BROKER_INVOKE_TOKEN: "collapsed-gateway-role",
      GATES: {
        getByName() {
          throw new Error("gate state must not be reached");
        },
      },
      BROKER: { fetch: async () => { throw new Error("Broker must not be reached"); } },
    } as never;
    const requests = [
      new Request("https://gateway.internal/internal/gate", {
        method: "POST",
        headers: {
          authorization: "Bearer collapsed-gateway-role",
          "content-type": "application/json",
        },
        body: "{",
      }),
      new Request("https://gateway.internal/v1/a/acct/angel/production/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer angel-key",
          "content-type": "application/json",
        },
        body: "{",
      }),
    ];

    for (const request of requests) {
      const response = await handleGatewayRequest(request, env);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "gateway internal role credentials must be non-empty and distinct",
      });
    }
  });

  test("Gateway rejects missing or empty configured roles and absent bearers before parsing", async () => {
    const paths = [
      "https://gateway.internal/internal/gate",
      "https://gateway.internal/v1/a/acct/angel/production/mcp",
    ];
    for (const invalid of [undefined, ""]) {
      for (const field of ["CONTROL_GATEWAY_TOKEN", "GATEWAY_BROKER_INVOKE_TOKEN"] as const) {
        const env = {
          CONTROL_GATEWAY_TOKEN: "control-gateway",
          GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-invoke",
          [field]: invalid,
          GATES: { getByName: () => { throw new Error("gate state must not be reached"); } },
          BROKER: { fetch: async () => { throw new Error("Broker must not be reached"); } },
        } as never;
        for (const url of paths) {
          const response = await handleGatewayRequest(new Request(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{",
          }), env);
          expect(response.status).toBe(500);
          expect(await response.json()).toEqual({
            error: "gateway internal role credentials must be non-empty and distinct",
          });
        }
      }
    }

    const validEnv = {
      CONTROL_GATEWAY_TOKEN: "control-gateway",
      GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-invoke",
      GATES: {
        getByName() {
          return { snapshot: async () => ({ gatewayKeyHash: "configured-key-hash" }) };
        },
      },
    } as never;
    for (const url of paths) {
      const response = await handleGatewayRequest(new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }), validEnv);
      expect(response.status).toBe(401);
    }
  });

  test("Broker keeps control and invoke credentials disjoint in both directions", async () => {
    const receiptIdentity = {
      accountId: "acct_demo",
      deploymentId: "dep_1",
      version: 1,
      policyDigest: "sha256:policy",
      bindingsDigest: "sha256:bindings",
      availabilityDigest: "sha256:availability",
      tool: "gmail.users.labels.list",
      connectionRef: "arc_google",
    };
    const env = {
      CONTROL_BROKER_TOKEN: "control-broker",
      GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-invoke",
      CREDENTIAL_VAULTS: fakeCredentialVaults(),
      GATES: {
        getByName() {
          return {
            snapshot: async () => ({ gate: "broker" }),
            evaluateJson: async () => JSON.stringify({
              allowed: true,
              effectiveArguments: {},
              execution: {
                origin: GENERATED_ADAPTERS.gmail!.origin,
                request: GENERATED_ADAPTERS.gmail!.operations["gmail.users.labels.list"]!.request,
              },
              receipt: {
                ...receiptIdentity,
                operation: "gmail.users.labels.list",
                connectionId: "con_google",
              },
            }),
          };
        },
      },
    } as never;
    const controlRequest = (token: string) => new Request("https://broker.internal/internal/gate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...gateCommand, gate: "broker" }),
    });
    const invokeRequest = (token: string) => new Request("https://broker.internal/internal/invoke", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runtimeId: "acct:angel:production",
        input: { requestId: "req", tool: "gmail.users.labels.list", arguments: {} },
        expected: receiptIdentity,
      }),
    });
    const provider = () => ({ labels: [] });
    const controlAccepted = await handleBrokerRequest(controlRequest("control-broker"), env, provider);
    const controlWithInvokeToken = await handleBrokerRequest(
      controlRequest("gateway-broker-invoke"),
      env,
      provider,
    );
    const invokeAccepted = await handleBrokerRequest(invokeRequest("gateway-broker-invoke"), env, provider);
    const invokeWithControlToken = await handleBrokerRequest(invokeRequest("control-broker"), env, provider);

    expect(controlAccepted.status).toBe(200);
    expect(controlWithInvokeToken.status).toBe(401);
    expect(invokeAccepted.status).toBe(200);
    expect(invokeWithControlToken.status).toBe(401);
  });

  test("Broker rejects both internal roles before parsing when their credentials are equal", async () => {
    const providerCalls: unknown[] = [];
    const env = {
      CONTROL_BROKER_TOKEN: "collapsed-broker-role",
      GATEWAY_BROKER_INVOKE_TOKEN: "collapsed-broker-role",
      GATES: {
        getByName() {
          throw new Error("gate state must not be reached");
        },
      },
    } as never;
    const requests = ["/internal/gate", "/internal/invoke"].map((pathname) => new Request(
      `https://broker.internal${pathname}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer collapsed-broker-role",
          "content-type": "application/json",
        },
        body: "{",
      },
    ));

    for (const request of requests) {
      const response = await handleBrokerRequest(request, env, (...args) => {
        providerCalls.push(args);
        return {};
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "broker role credentials must be non-empty and distinct",
      });
    }
    expect(providerCalls).toEqual([]);
  });

  test("Broker rejects missing or empty configured roles and absent bearers before parsing", async () => {
    const paths = ["/internal/gate", "/internal/invoke"];
    for (const invalid of [undefined, ""]) {
      for (const field of ["CONTROL_BROKER_TOKEN", "GATEWAY_BROKER_INVOKE_TOKEN"] as const) {
        const env = {
          CONTROL_BROKER_TOKEN: "control-broker",
          GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-invoke",
          [field]: invalid,
          GATES: { getByName: () => { throw new Error("gate state must not be reached"); } },
        } as never;
        for (const pathname of paths) {
          const response = await handleBrokerRequest(new Request(`https://broker.internal${pathname}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{",
          }), env, () => { throw new Error("provider must not be reached"); });
          expect(response.status).toBe(500);
          expect(await response.json()).toEqual({
            error: "broker role credentials must be non-empty and distinct",
          });
        }
      }
    }

    const validEnv = {
      CONTROL_BROKER_TOKEN: "control-broker",
      GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-invoke",
      GATES: { getByName: () => { throw new Error("gate state must not be reached"); } },
    } as never;
    for (const pathname of paths) {
      const response = await handleBrokerRequest(new Request(`https://broker.internal${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }), validEnv, () => { throw new Error("provider must not be reached"); });
      expect(response.status).toBe(401);
    }
  });
});

describe("control Worker routing", () => {
  test("protects assets and private APIs with Access before routing", async () => {
    const env = controlEnv({ ok: true, value: { schema: "angelmcp.demo.v4" } });
    (env as Record<string, unknown>).ACCESS_REQUIRED = "true";
    const response = await handleControlRequest(new Request("https://demo.test/"), env);
    expect(response.status).toBe(401);
    expect(env.calls).toEqual([]);
  });

  test("returns 401 only for authentication rejection and 500 for verifier failure", async () => {
    const env = controlEnv({ ok: true, value: { schema: "angelmcp.demo.v4" } });
    const rejected = await handleControlRequestReal(new Request("https://demo.test/"), env as never, async () => {
      throw new AccessAuthenticationError("invalid assertion");
    });
    const failed = await handleControlRequestReal(new Request("https://demo.test/"), env as never, async () => {
      throw new Error("JWKS service unavailable");
    });

    expect(rejected.status).toBe(401);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "Access authentication verifier failed" });
    expect(env.calls).toEqual([]);
  });

  test("uses the verified Access identity for owner state and actions without a demo bearer", async () => {
    const env = controlEnv({ ok: true, value: { schema: "angelmcp.demo.v4" } });
    const state = await handleControlRequest(
      new Request("https://demo.test/api/demo/state"),
      env,
    );
    const action = await handleControlRequest(new Request("https://demo.test/api/demo/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ angelId: "golden-assistant", action: "pause_all", environment: "production" }),
    }), env);

    expect(state.status).toBe(200);
    expect(action.status).toBe(200);
    expect(env.calls).toEqual([
      { operation: "state" },
      { operation: "action", angelId: "golden-assistant", action: "pause_all", environment: "production" },
    ]);
  });

  test("routes named-key CRUD to key_action on the demo surface (Access identity, no bearer; slug + client token preserved)", async () => {
    const env = controlEnv({ ok: true, value: { key: { id: "key_1", name: "CI", fingerprint: "abcabcabcabc", status: "active", createdAt: null, revokedAt: null }, plaintext: "ak_production_once" } });

    const create = await handleControlRequest(new Request("https://demo.test/api/demo/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ angelId: "golden-assistant", action: "create_key", environment: "production", name: "CI", idempotencyToken: "tok-create" }),
    }), env);
    const rotate = await handleControlRequest(new Request("https://demo.test/api/demo/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ angelId: "golden-assistant", action: "rotate_key", environment: "production", keyId: "key_1", idempotencyToken: "tok-rotate" }),
    }), env);
    const revoke = await handleControlRequest(new Request("https://demo.test/api/demo/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ angelId: "golden-assistant", action: "revoke_key", environment: "preview", keyId: "key_1", idempotencyToken: "tok-revoke" }),
    }), env);

    expect([create.status, rotate.status, revoke.status]).toEqual([200, 200, 200]);
    // The demo surface forwards the SLUG + client token to the registry's keyAction,
    // which resolves slug -> generated id and derives the idempotency key there — the
    // worker never synthesizes a per-request UUID (finding #1/#2).
    expect(env.calls[0]).toEqual({ operation: "key_action", action: "create_key", angelId: "golden-assistant", environment: "production", idempotencyToken: "tok-create", name: "CI" });
    expect(env.calls[1]).toEqual({ operation: "key_action", action: "rotate_key", angelId: "golden-assistant", environment: "production", idempotencyToken: "tok-rotate", keyId: "key_1" });
    expect(env.calls[2]).toEqual({ operation: "key_action", action: "revoke_key", angelId: "golden-assistant", environment: "preview", idempotencyToken: "tok-revoke", keyId: "key_1" });
  });

  test("rejects a malformed or unbounded key action body before dispatch", async () => {
    const env = controlEnv({ ok: true, value: {} });
    const post = (body: unknown) => handleControlRequest(new Request("https://demo.test/api/demo/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), env);

    const cases = [
      // Missing the client idempotency token (required for replay-safe retry).
      { angelId: "golden-assistant", action: "create_key", environment: "production", name: "CI" },
      // Empty name after trim (lower bound).
      { angelId: "golden-assistant", action: "create_key", environment: "production", name: "   ", idempotencyToken: "t" },
      // Over-long name (upper bound, 64 code points).
      { angelId: "golden-assistant", action: "create_key", environment: "production", name: "k".repeat(65), idempotencyToken: "t" },
      // ASCII control character in the name.
      { angelId: "golden-assistant", action: "create_key", environment: "production", name: "bad\nname", idempotencyToken: "t" },
      // Zero-width joiner (\p{Cf} format char / an invisible), and a full ZWJ emoji
      // sequence — both rejected because they carry format joiners (round-2 #3).
      { angelId: "golden-assistant", action: "create_key", environment: "production", name: "a\u200db", idempotencyToken: "t" },
      { angelId: "golden-assistant", action: "create_key", environment: "production", name: "👨‍👩‍👧", idempotencyToken: "t" },
      // 65 astral code points → over the 64 CODE-POINT bound (130 UTF-16 units).
      { angelId: "golden-assistant", action: "create_key", environment: "production", name: "🚀".repeat(65), idempotencyToken: "t" },
      // Extra field (exact-keys enforcement).
      { angelId: "golden-assistant", action: "revoke_key", environment: "preview", keyId: "key_1", idempotencyToken: "t", extra: true },
    ];
    for (const body of cases) {
      const response = await post(body);
      expect(response.status).toBe(400);
    }

    // Accepted: a 64-char ASCII name at the boundary; a single visible emoji
    // (\p{So}, not \p{C}); and a 64-astral-code-point name (128 UTF-16 units) — the
    // latter proves the bound counts CODE POINTS, not UTF-16 units.
    const accepted = [
      "k".repeat(64),
      "🚀 deploy",
      "🚀".repeat(64),
    ];
    for (const name of accepted) {
      expect((await post({ angelId: "golden-assistant", action: "create_key", environment: "production", name, idempotencyToken: "t" })).status).toBe(200);
    }
    // Only the well-formed names reached the registry, trimmed and intact.
    expect(env.calls).toHaveLength(3);
    expect(env.calls.map((call) => (call as { name: string }).name)).toEqual(accepted);
  });

  test("rejects missing or invalid Access identity before private state and actions", async () => {
    const env = controlEnv({ ok: true, value: {} });
    const rejectAccess: Parameters<typeof handleControlRequestReal>[2] = async () => {
      throw new AccessAuthenticationError("invalid assertion");
    };
    for (const request of [
      new Request("https://demo.test/api/demo/state"),
      new Request("https://demo.test/api/demo/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ angelId: "golden-assistant", action: "pause_all", environment: "production" }),
      }),
    ]) {
      const response = await handleControlRequestReal(request, env as never, rejectAccess);
      expect(response.status).toBe(401);
    }
    expect(env.calls).toEqual([]);
  });

  test("keeps reset behind the automation admin bearer", async () => {
    const env = controlEnv({ ok: true, value: {} });
    const missing = await handleControlRequest(new Request("https://demo.test/api/demo/reset", { method: "POST" }), env);
    const invalid = await handleControlRequest(new Request("https://demo.test/api/demo/reset", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    }), env);
    const valid = await handleControlRequest(new Request("https://demo.test/api/demo/reset", {
      method: "POST",
      headers: { authorization: "Bearer admin-secret" },
    }), env);

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(valid.status).toBe(200);
    expect(env.calls).toEqual([{ operation: "reset" }]);
  });

  test("authenticates reset and actions before parsing bodies", async () => {
    const env = controlEnv({ ok: true, value: {} });
    const response = await handleControlRequest(new Request("https://demo.test/api/demo/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }), env);
    expect(response.status).toBe(401);
    expect(env.calls).toEqual([]);
  });

  test("fails closed when any Control credential or response KEK is reused", async () => {
    const fields = [
      "DEMO_ADMIN_TOKEN",
      "MANAGEMENT_API_TOKEN",
      "CONTROL_GATEWAY_TOKEN",
      "CONTROL_BROKER_TOKEN",
      "CONTROL_RESPONSE_KEK",
    ] as const;

    for (let first = 0; first < fields.length; first += 1) {
      for (let second = first + 1; second < fields.length; second += 1) {
        const env = controlEnv({ ok: true, value: {} });
        env[fields[second]!] = env[fields[first]!] as never;
        for (const request of malformedControlMutationRequests()) {
          const response = await handleControlRequest(request, env);
          expect(response.status).toBe(500);
          expect(await response.json()).toEqual({
            error: "Control role credentials must be non-empty and pairwise distinct",
          });
        }
        expect(env.calls).toEqual([]);
      }
    }
  });

  test("rejects missing or empty configured Control credentials before parsing every mutation", async () => {
    for (const invalid of [undefined, ""]) {
      for (const field of [
        "DEMO_ADMIN_TOKEN",
        "MANAGEMENT_API_TOKEN",
        "CONTROL_GATEWAY_TOKEN",
        "CONTROL_BROKER_TOKEN",
        "CONTROL_RESPONSE_KEK",
      ] as const) {
        const env = controlEnv({ ok: true, value: {} });
        env[field] = invalid as never;
        for (const request of malformedControlMutationRequests()) {
          const response = await handleControlRequest(request, env);
          expect(response.status).toBe(500);
        }
        expect(env.calls).toEqual([]);
      }
    }
  });

  test("forwards reset and exact v3 action commands to the Account registry", async () => {
    const view = { schema: "angelmcp.demo.v4" };
    const env = controlEnv({ ok: true, value: view });
    const reset = await handleControlRequest(new Request("https://demo.test/api/demo/reset", {
      method: "POST",
      headers: { authorization: "Bearer admin-secret" },
    }), env);
    const tuple = await handleControlRequest(new Request("https://demo.test/api/demo/action", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        angelId: "golden-assistant",
        action: "pause_tool",
        environment: "production",
        tool: "gmail.users.messages.list",
        connectionId: "con_personal_google",
      }),
    }), env);

    expect(reset.status).toBe(200);
    expect(tuple.status).toBe(200);
    expect(env.calls).toEqual([
      { operation: "reset" },
      {
        operation: "action",
        angelId: "golden-assistant",
        action: "pause_tool",
        environment: "production",
        tool: "gmail.users.messages.list",
        connectionId: "con_personal_google",
      },
    ]);
  });

  test("forwards an exact production promotion body", async () => {
    const env = controlEnv({ ok: true, value: {} });
    const response = await handleControlRequest(new Request("https://demo.test/api/demo/action", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        angelId: "golden-assistant",
        action: "promote",
        environment: "production",
        stagedDeploymentId: "dep_stage",
        expectedDigest: "a".repeat(64),
        bindings: {
          "gdocs-read": ["con_personal_google"],
          "gmail-read-and-draft": ["con_personal_google", "con_work_google"],
        },
      }),
    }), env);

    expect(response.status).toBe(200);
    expect(env.calls).toEqual([{
      operation: "action",
      angelId: "golden-assistant",
      action: "promote",
      environment: "production",
      stagedDeploymentId: "dep_stage",
      expectedDigest: "a".repeat(64),
      bindings: {
        "gdocs-read": ["con_personal_google"],
        "gmail-read-and-draft": ["con_personal_google", "con_work_google"],
      },
    }]);
  });

  test("validates strict action variants before dispatch", async () => {
    const env = controlEnv({ ok: true, value: {} });
    const bodies = [
      { action: "pause_all", environment: "production" },
      { angelId: "golden-assistant", action: "pause_tool", environment: "production" },
      { angelId: "golden-assistant", action: "promote", environment: "preview" },
      { angelId: "golden-assistant", action: "pause_all", environment: "production", extra: true },
    ];
    for (const body of bodies) {
      const response = await handleControlRequest(new Request("https://demo.test/api/demo/action", {
      method: "POST",
      headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }), env);
      expect(response.status).toBe(400);
    }
    expect(env.calls).toEqual([]);
  });

  test("removes the embedded publish route", async () => {
    const env = controlEnv({ ok: true, value: {} });
    const response = await handleControlRequest(new Request("https://demo.test/api/demo/publish", {
      method: "POST",
      headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
      body: JSON.stringify({ version: 2 }),
    }), env);
    expect(response.status).toBe(404);
    expect(env.calls).toEqual([]);
  });

  test("serves non-API paths from the static asset binding", async () => {
    const env = controlEnv({ ok: true, value: {} });
    env.DEMO_ADMIN_TOKEN = "";
    env.MANAGEMENT_API_TOKEN = "";
    env.CONTROL_GATEWAY_TOKEN = "";
    env.CONTROL_BROKER_TOKEN = "";
    env.CONTROL_RESPONSE_KEK = "";

    const response = await handleControlRequest(new Request("https://demo.test/angel/demo"), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset:/angel/demo");
  });
});

describe("AccountRegistry", () => {
  test("reset clears every existing Angel runtime and leaves an empty management Account", async () => {
    const resets: string[] = [];
    const harness = registryHarness((input) => {
      if (input.operation === "reset") resets.push(`${input.gate}:${input.runtimeId}`);
    });

    const view = valueOf(await harness.registry.dispatchJson({ operation: "reset" }));

    expect(view).toEqual({
      schema: "angelmcp.demo.v4",
      account: { id: "acct_demo", name: "Personal", handle: null },
      angels: [],
    });
    // No Angels exist yet, so there are no runtimes to clear — the old
    // hardcoded comparison-slug list is gone.
    expect(resets).toEqual([]);

    await deployGolden(harness.registry);
    valueOf(await harness.registry.dispatchJson({ operation: "reset" }));

    expect(resets).toHaveLength(4);
    expect(new Set(resets.map((entry) => entry.split(":").slice(0, -1).join(":")))).toEqual(new Set([
      "broker:acct_demo:golden-assistant",
      "gateway:acct_demo:golden-assistant",
    ]));
  });

  test("delete_angel tears down both gates Broker-first and reset still works afterwards", async () => {
    const operations: string[] = [];
    const harness = registryHarness((input) => {
      operations.push(`${input.operation}:${input.gate}:${input.runtimeId.split(":").pop()}`);
    });
    const deployed = await deployGolden(harness.registry);
    operations.length = 0;

    const deleted = valueOf(await harness.registry.dispatchJson({
      operation: "delete_angel",
      accountId: "acct_demo",
      slug: "golden-assistant",
      // deployGolden promoted production, so the slug confirmation is required.
      input: { confirm: "golden-assistant" },
      mutation: {
        method: "DELETE",
        path: "/v1/accounts/acct_demo/angels/golden-assistant",
        idempotencyKey: "delete-golden",
        body: { confirm: "golden-assistant" },
      },
    }));

    expect(deleted).toMatchObject({
      id: deployed.ensure.angel.id,
      slug: "golden-assistant",
      deleted: true,
    });
    expect(operations).toEqual([
      "reconcile_keys:gateway:preview",
      "reconcile_keys:gateway:production",
      "reset:broker:preview",
      "reset:broker:production",
      "reset:gateway:preview",
      "reset:gateway:production",
    ]);
    const view = valueOf(await harness.registry.dispatchJson({ operation: "state" }));
    expect(view.angels).toEqual([]);
    const reset = valueOf(await harness.registry.dispatchJson({ operation: "reset" }));
    expect(reset.angels).toEqual([]);
  });

  test("dashboard actions on a re-created slug do not replay the dead Angel's records", async () => {
    const harness = registryHarness();
    await deployGolden(harness.registry);
    const pause = {
      operation: "action" as const,
      angelId: "golden-assistant",
      action: "pause_all" as const,
      environment: "production" as const,
    };
    const paused = valueOf(await harness.registry.dispatchJson(pause));
    expect(paused.angels[0].enabled).toBe(false);

    valueOf(await harness.registry.dispatchJson({
      operation: "delete_angel",
      accountId: "acct_demo",
      slug: "golden-assistant",
      input: { confirm: "golden-assistant" },
      mutation: {
        method: "DELETE",
        path: "/v1/accounts/acct_demo/angels/golden-assistant",
        idempotencyKey: "delete-for-recreate",
        body: { confirm: "golden-assistant" },
      },
    }));
    await deployGolden(harness.registry, "-recreated");

    // The re-created Angel starts at availability revision 0 again, so a
    // slug+revision-derived key would collide with the dead Angel's record and
    // silently replay it, leaving every tool live. The action must pause the
    // NEW Angel's gates for real.
    const pausedAgain = valueOf(await harness.registry.dispatchJson(pause));
    expect(pausedAgain.angels[0].enabled).toBe(false);
  });

  test("delete_angel without confirmation refuses a live production Angel", async () => {
    const harness = registryHarness();
    await deployGolden(harness.registry);

    const result = JSON.parse(await harness.registry.dispatchJson({
      operation: "delete_angel",
      accountId: "acct_demo",
      slug: "golden-assistant",
      input: {},
      mutation: {
        method: "DELETE",
        path: "/v1/accounts/acct_demo/angels/golden-assistant",
        idempotencyKey: "delete-unconfirmed",
        body: {},
      },
    }));

    expect(result).toMatchObject({ ok: false, status: 409 });
    const view = valueOf(await harness.registry.dispatchJson({ operation: "state" }));
    expect(view.angels).toHaveLength(1);
  });

  test("the state view runs the restore repair so pre-fix dangling availability projects as aligned", async () => {
    const harness = registryHarness();
    valueOf(await harness.registry.dispatchJson({ operation: "reset" }));
    await deployGolden(harness.registry);

    // Emulate the issue-#1 damage: management holds an override keyed by a ref
    // no deployment serves, while the gates pruned their copy at install (they
    // hold no overrides, same revision).
    const state = harness.storage.get("management") as ManagementState;
    state.angels[0]!.environments.production.availability.connectionOverrides = {
      "gmail.users.messages.list": { arc_stale_pre_fix: false },
    };

    const view = valueOf(await harness.registry.dispatchJson({ operation: "state" }));
    expect(view.angels[0].environments.production.gateAlignment.availability).toBe("aligned");
  });

  test("bridges tuple, whole-tool, and all availability actions idempotently", async () => {
    const harness = registryHarness();
    valueOf(await harness.registry.dispatchJson({ operation: "reset" }));
    await deployGolden(harness.registry);

    const pauseTuple = {
      operation: "action" as const,
      angelId: "golden-assistant",
      action: "pause_tool" as const,
      environment: "production" as const,
      tool: "gmail.users.messages.list",
      connectionId: "con_personal_google",
    };
    const paused = valueOf(await harness.registry.dispatchJson(pauseTuple));
    const replayed = valueOf(await harness.registry.dispatchJson(pauseTuple));
    expect(toolConnections(paused, "gmail.users.messages.list")).toEqual([
      ["con_personal_google", false],
      ["con_work_google", true],
    ]);
    expect(replayed.angels[0].environments.production.availability.revision).toBe(1);

    const frozen = valueOf(await harness.registry.dispatchJson({
      operation: "action",
      angelId: "golden-assistant",
      action: "pause_all",
      environment: "production",
    }));
    expect(toolConnections(frozen, "gmail.users.messages.list").every(([, available]) => !available)).toBe(true);

    const gmailOnly = valueOf(await harness.registry.dispatchJson({
      operation: "action",
      angelId: "golden-assistant",
      action: "resume_tool",
      environment: "production",
      tool: "gmail.users.messages.list",
    }));
    expect(toolConnections(gmailOnly, "gmail.users.messages.list").every(([, available]) => available)).toBe(true);
    expect(toolConnections(gmailOnly, "docs.documents.get").every(([, available]) => !available)).toBe(true);

    const resumed = valueOf(await harness.registry.dispatchJson({
      operation: "action",
      angelId: "golden-assistant",
      action: "resume_all",
      environment: "production",
    }));
    expect(resumed.angels[0].enabled).toBe(true);
    expect(JSON.stringify(resumed)).not.toContain("arc_");
    expect(JSON.stringify(resumed)).not.toContain("keyHash");
  });

  test("keeps demo actions inside the Account Angel namespace", async () => {
    const harness = registryHarness();
    valueOf(await harness.registry.dispatchJson({ operation: "reset" }));
    await deployGolden(harness.registry);

    const result = JSON.parse(await harness.registry.dispatchJson({
      operation: "action",
      angelId: "another-account-angel",
      action: "pause_all",
      environment: "production",
    }));

    expect(result).toEqual({ ok: false, status: 404, error: "not found" });
  });

  test("rejects changed bindings when replaying an already-promoted staged Version", async () => {
    const harness = registryHarness();
    valueOf(await harness.registry.dispatchJson({ operation: "reset" }));
    const deployed = await deployGolden(harness.registry);

    const result = JSON.parse(await harness.registry.dispatchJson({
      operation: "action",
      angelId: "golden-assistant",
      action: "promote",
      environment: "production",
      stagedDeploymentId: deployed.staged.id,
      expectedDigest: deployed.staged.digest,
      bindings: {
        ...deployed.bindings,
        "gmail-read-and-draft": ["con_personal_google"],
      },
    }));

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "no previewed Version has compatible production bindings",
    });
  });

  test("repairs a pending production deployment instead of taking the promotion replay shortcut", async () => {
    const harness = registryHarness();
    valueOf(await harness.registry.dispatchJson({ operation: "reset" }));
    const deployed = await deployGolden(harness.registry);
    const state = structuredClone(harness.storage.get("management")) as ManagementState;
    const angel = state.angels.find((candidate) => candidate.id === deployed.ensure.angel.id)!;
    angel.environments.production.pendingDeploymentId = angel.environments.production.activeDeploymentId;
    angel.environments.production.repair = "broker";
    harness.storage.set("management", state);

    valueOf(await harness.registry.dispatchJson({
      operation: "action",
      angelId: "golden-assistant",
      action: "promote",
      environment: "production",
      stagedDeploymentId: deployed.staged.id,
      expectedDigest: deployed.staged.digest,
      bindings: deployed.bindings,
    }));

    const repaired = harness.storage.get("management") as ManagementState;
    const repairedAngel = repaired.angels.find(
      (candidate) => candidate.id === deployed.ensure.angel.id,
    )!;
    expect(repairedAngel.environments.production).toMatchObject({
      pendingDeploymentId: null,
      repair: null,
    });
  });
});

function controlEnv(result: unknown) {
  const calls: unknown[] = [];
  return {
    ACCOUNT_ID: "acct_demo",
    MANAGEMENT_API_TOKEN: "management-secret",
    CONTROL_RESPONSE_KEK: "response-replay-kek",
    DEMO_ADMIN_TOKEN: "admin-secret",
    CONTROL_GATEWAY_TOKEN: "control-gateway-secret",
    CONTROL_BROKER_TOKEN: "control-broker-secret",
    GATEWAY_BASE_URL: "https://gateway.example",
    ACCOUNTS: {
      getByName(name: string) {
        expect(name).toBe("acct_demo");
        return {
          async dispatchJson(input: unknown) {
            calls.push(input);
            return JSON.stringify(result);
          },
        };
      },
    },
    ASSETS: {
      async fetch(request: Request) {
        return new Response(`asset:${new URL(request.url).pathname}`);
      },
    },
    calls,
  };
}

function malformedControlMutationRequests(withBearer = true): Request[] {
  return [
    ["reset", "admin-secret"],
    ["publish", "admin-secret"],
    ["action", undefined],
  ].map(([route, token]) => new Request(`https://demo.test/api/demo/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withBearer && token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: "{",
  }));
}

function valueOf(result: string) {
  const parsed = JSON.parse(result);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function registryHarness(observe: (input: GateInternalRequest) => void = () => {}) {
  const storage = new Map<string, unknown>();
  const gateway = gateService("gateway", observe);
  const broker = gateService("broker", observe);
  const registry = new AccountRegistry({
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => storage.set(key, structuredClone(value)),
    },
  } as never, {
    ACCOUNT_ID: "acct_demo",
    CONTROL_RESPONSE_KEK: "response-replay-kek",
    CONTROL_GATEWAY_TOKEN: "control-gateway-secret",
    CONTROL_BROKER_TOKEN: "control-broker-secret",
    GATEWAY_BASE_URL: "https://gateway.example",
    GATEWAY: gateway,
    BROKER: broker,
    CREDENTIAL_VAULTS: fakeCredentialVaults(),
  } as never);
  return { registry, storage };
}

async function deployGolden(registry: InstanceType<typeof AccountRegistry>, keySuffix = "") {
  const slug = "golden-assistant";
  const ensure = valueOf(await registry.dispatchJson({
    operation: "ensure_angel",
    accountId: "acct_demo",
    slug,
    mutation: registryMutation(`ensure-golden${keySuffix}`, {}),
  }));
  const artifact = checkedArtifact(slug);
  const publishBody = { artifact, expectedDigest: artifact.digest };
  const version = valueOf(await registry.dispatchJson({
    operation: "publish_version",
    angelId: ensure.angel.id,
    input: publishBody,
    mutation: registryMutation(`publish-golden${keySuffix}`, publishBody),
  }));
  const bindings = {
    "gdocs-read": ["con_personal_google"],
    "gmail-read-and-draft": ["con_personal_google", "con_work_google"],
  };
  const stagingBody = { versionId: version.id, expectedDigest: version.digest, bindings };
  const staged = valueOf(await registry.dispatchJson({
    operation: "deploy_preview",
    angelId: ensure.angel.id,
    input: stagingBody,
    mutation: registryMutation(`stage-golden${keySuffix}`, stagingBody),
  }));
  const productionBody = {
    stagedDeploymentId: staged.id,
    expectedDigest: staged.digest,
    bindings,
  };
  valueOf(await registry.dispatchJson({
    operation: "promote_production",
    angelId: ensure.angel.id,
    input: productionBody,
    mutation: registryMutation(`promote-golden${keySuffix}`, productionBody),
  }));
  return { ensure, version, staged, bindings };
}

function registryMutation(idempotencyKey: string, body: unknown) {
  return { method: "POST", path: `/test/${idempotencyKey}`, idempotencyKey, body };
}

function checkedArtifact(slug: string) {
  const canonicalSource = readFileSync(
    new URL(`../../examples/angels/${slug}/build/angel.version.json`, import.meta.url),
    "utf8",
  ).trim();
  const digest = readFileSync(
    new URL(`../../examples/angels/${slug}/build/angel.version.sha256`, import.meta.url),
    "utf8",
  ).trim();
  return { ...JSON.parse(canonicalSource), canonicalSource, digest };
}

function toolConnections(view: DemoView, toolName: string): Array<[string, boolean]> {
  const angel = view.angels[0];
  if (angel === undefined) throw new Error("expected one demo Angel");
  const tool = angel.environments.production.tools.find(
    (candidate: { name: string }) => candidate.name === toolName,
  );
  if (tool === undefined) throw new Error(`expected deployed tool ${toolName}`);
  return tool.connections.map(
    (connection: { connectionId: string; available: boolean }) => [
      connection.connectionId,
      connection.available,
    ],
  );
}

function gateService(
  expectedGate: "gateway" | "broker",
  observe: (input: GateInternalRequest) => void = () => {},
) {
  const states = new Map<string, import("../../src/gate").PolicyGate>();
  return {
    async fetch(url: string | URL | Request, init?: RequestInit) {
      const target = typeof url === "string" || url instanceof URL ? url.toString() : url.url;
      if (new URL(target).pathname === "/internal/connections") {
        return Response.json(fixtureConnectionSummaries("acct_demo"));
      }
      const request = new Request("https://gate.internal/internal/gate", init);
      expect(request.headers.get("authorization")).toBe(
        expectedGate === "gateway" ? "Bearer control-gateway-secret" : "Bearer control-broker-secret",
      );
      const input = await request.json() as GateInternalRequest;
      expect(input.gate).toBe(expectedGate);
      observe(input);
      const { PolicyGate, createPolicyGateState } = await import("../../src/gate");
      let policy = states.get(input.runtimeId) ?? new PolicyGate(createPolicyGateState(expectedGate));
      switch (input.operation) {
        case "reset":
          policy = new PolicyGate(createPolicyGateState(expectedGate));
          states.set(input.runtimeId, policy);
          return Response.json(null);
        case "install":
          states.set(input.runtimeId, policy);
          return Response.json(await policy.install(input.command));
        case "availability":
          return Response.json(policy.changeAvailability(input.command));
        case "reconcile_keys":
          states.set(input.runtimeId, policy);
          return Response.json(policy.reconcileGatewayKeys(input.hashes));
        case "snapshot":
          return Response.json(policy.snapshot());
      }
    },
  };
}
