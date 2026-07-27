import { describe, expect, mock, test } from "bun:test";
import { GENERATED_ADAPTERS } from "@smcllns/angel-core";
import type { GateEvaluation, GateReceipt } from "../../src/gate";
import { fakeCredentialVaults } from "./fake-vault";

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

const { handleBrokerRequest } = await import("../../src/workers/broker");

describe("Broker gate convergence", () => {
  test("rejects every expected Gateway receipt mismatch before invoking the provider", async () => {
    const providerCalls: unknown[] = [];
    const mismatches = {
      deploymentId: "different-deployment",
      version: 2,
      policyDigest: "different-policy",
      bindingsDigest: "different-bindings",
      availabilityDigest: "different-availability",
    } as const;

    for (const [field, actual] of Object.entries(mismatches)) {
      const evaluation = allowedEvaluation({ [field]: actual });
      const response = await handleBrokerRequest(
        invokeRequest(evaluation, { [field]: field === "version" ? 1 : `${field}-expected` }),
        brokerEnv(evaluation),
        (operation, args) => {
          providerCalls.push({ operation, args });
          return { shouldNot: "run" };
        },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "gate receipt mismatch",
        mismatch: { field, actual },
        evaluation: { allowed: true },
      });
    }
    expect(providerCalls).toEqual([]);
  });

  test("reports receipt mismatch before a Broker policy denial and never invokes the provider", async () => {
    const providerCalls: unknown[] = [];
    const evaluation = deniedEvaluation({ availabilityDigest: "broker-availability" });
    const response = await handleBrokerRequest(
      invokeRequest(evaluation, { availabilityDigest: "gateway-availability" }),
      brokerEnv(evaluation),
      (operation, args) => {
        providerCalls.push({ operation, args });
        return { shouldNot: "run" };
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "gate receipt mismatch",
      mismatch: {
        field: "availabilityDigest",
        expected: "gateway-availability",
        actual: "broker-availability",
      },
      evaluation: { allowed: false, reason: "tool_paused" },
    });
    expect(providerCalls).toEqual([]);
  });

  test("rejects an expected receipt that omits the selected Connection before gate access", async () => {
    const request = invokeRequest(allowedEvaluation());
    const body = await request.json() as { expected: Record<string, unknown> };
    delete body.expected.connectionRef;
    const response = await handleBrokerRequest(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
      }),
      {
        CONTROL_BROKER_TOKEN: "control-broker-secret",
        GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-secret",
        GATES: { getByName: () => { throw new Error("gate state must not be reached"); } },
      } as never,
      () => ({ shouldNot: "run" }),
    );

    expect(await response.json()).toEqual({ error: "invoke expected gate receipt is required" });
  });

  test("invokes the provider only after all seven expected deployment and tuple fields match", async () => {
    const providerCalls: unknown[] = [];
    const evaluation = allowedEvaluation();
    const response = await handleBrokerRequest(
      invokeRequest(evaluation),
      brokerEnv(evaluation),
      (operation, args, connectionId) => {
        providerCalls.push({ operation, args, connectionId });
        return { ok: true };
      },
    );

    expect(response.status).toBe(200);
    expect(providerCalls).toEqual([{
      operation: "gmail.users.messages.list",
      args: { maxResults: 5 },
      connectionId: "con_google",
    }]);
  });

  test("rejects an argument the sealed request cannot express before custody or provider fetch", async () => {
    let custodyCalls = 0;
    let fetchCalls = 0;
    const evaluation = allowedEvaluation({});
    evaluation.effectiveArguments = { maxResults: 5, unexpected: "x" };
    const response = await handleBrokerRequest(
      invokeRequest(evaluation),
      {
        ...(brokerEnv(evaluation) as Record<string, unknown>),
        CREDENTIAL_VAULTS: { getByName: () => { custodyCalls += 1; throw new Error("custody must not be reached"); } },
      } as never,
      undefined,
      async () => { fetchCalls += 1; return Response.json({}); },
    );

    expect(response.status).toBe(500);
    expect(custodyCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test("fails closed when a custody lease belongs to another Account or Connection", async () => {
    for (const mismatch of [
      { accountId: "acct_other", connectionId: "con_google" },
      { accountId: "acct_demo", connectionId: "con_other" },
    ]) {
      let fetchCalls = 0;
      const evaluation = allowedEvaluation();
      const response = await handleBrokerRequest(
        invokeRequest(evaluation),
        {
          ...(brokerEnv(evaluation) as Record<string, unknown>),
          CREDENTIAL_VAULTS: {
            getByName: () => ({
              async fetch() {
                return Response.json({
                  ...leaseFields(),
                  ...mismatch,
                });
              },
            }),
          },
        } as never,
        undefined,
        async () => { fetchCalls += 1; return Response.json({}); },
      );
      expect(response.status).toBe(500);
      expect(fetchCalls).toBe(0);
    }
  });

  test("does not refresh a revoked or error Connection", async () => {
    for (const health of ["revoked", "error"] as const) {
      let vaultCalls = 0;
      let fetchCalls = 0;
      const evaluation = allowedEvaluation();
      const response = await handleBrokerRequest(
        invokeRequest(evaluation),
        {
          ...(brokerEnv(evaluation) as Record<string, unknown>),
          CREDENTIAL_VAULTS: {
            getByName: () => ({
              async fetch() {
                vaultCalls += 1;
                return Response.json({ error: `Connection is ${health}` }, { status: 409 });
              },
            }),
          },
        } as never,
        undefined,
        async () => { fetchCalls += 1; return Response.json({}); },
      );
      expect(response.status).toBe(500);
      expect(vaultCalls).toBe(1);
      expect(fetchCalls).toBe(0);
    }
  });

  test("marks custody error on refresh authorization failure without exposing credentials", async () => {
    const vaultCalls: string[] = [];
    const evaluation = allowedEvaluation();
    const response = await handleBrokerRequest(
      invokeRequest(evaluation),
      {
        ...(brokerEnv(evaluation) as Record<string, unknown>),
        CREDENTIAL_VAULTS: {
          getByName: () => ({
            async fetch(input: string | Request) {
              const request = typeof input === "string" ? new Request(input) : input;
              vaultCalls.push(`${request.method} ${new URL(request.url).pathname}`);
              if (new URL(request.url).pathname.endsWith("/lease")) return Response.json(leaseFields());
              if (new URL(request.url).pathname.endsWith("/error")) return Response.json({ health: "error" });
              throw new Error("unexpected custody call");
            },
          }),
        },
      } as never,
      undefined,
      async (input) => {
        if (String(input) === "https://oauth2.googleapis.com/token") return new Response("not json", { status: 401 });
        return Response.json({});
      },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Google refresh authorization failed" });
    expect(vaultCalls).toEqual(["GET /connections/con_google/lease", "POST /connections/con_google/error"]);
  });

  test("the deployed fixture provider makes repeated Gmail Connections distinguishable", async () => {
    const personal = allowedEvaluation({ connectionId: "con_personal_google" });
    const work = allowedEvaluation({ connectionId: "con_work_google" });

    const personalResponse = await handleBrokerRequest(
      invokeRequest(personal),
      brokerEnv(personal),
      (_operation, args, connectionId) => ({ mailbox: connectionId === "con_personal_google" ? "personal" : "work", arguments: args }),
    );
    const workResponse = await handleBrokerRequest(
      invokeRequest(work),
      brokerEnv(work),
      (_operation, args, connectionId) => ({ mailbox: connectionId === "con_personal_google" ? "personal" : "work", arguments: args }),
    );

    expect(await personalResponse.json()).toMatchObject({ result: { mailbox: "personal" } });
    expect(await workResponse.json()).toMatchObject({ result: { mailbox: "work" } });
  });
});

function allowedEvaluation(
  receiptOverrides: Partial<GateReceipt> = {},
): Extract<GateEvaluation, { allowed: true }> {
  return {
    allowed: true,
    reason: "allowed",
    effectiveArguments: { maxResults: 5 },
    execution: {
      origin: GENERATED_ADAPTERS.gmail!.origin,
      request: GENERATED_ADAPTERS.gmail!.operations["gmail.users.messages.list"]!.request,
    },
    receipt: {
      sequence: 0,
      gate: "broker",
      accountId: "acct_demo",
      angelId: "golden-research-assistant",
      environment: "production",
      deploymentId: "dep_production_1",
      version: 1,
      policyDigest: "policy-digest",
      bindingsDigest: "bindings-digest",
      availabilityDigest: "availability-digest",
      requestId: "req_1",
      tool: "gmail.users.messages.list",
      provider: "google",
      operation: "gmail.users.messages.list",
      connectionId: "con_google",
      connectionRef: "arc_google",
      connectionIdentityLabel: "Golden Google",
      argumentsDigest: "arguments-digest",
      decision: "allow",
      detail: "exact policy allowed",
      previousHash: "previous-hash",
      hash: "receipt-hash",
      ...receiptOverrides,
    },
  };
}

function deniedEvaluation(
  receiptOverrides: Partial<GateReceipt> = {},
): Extract<GateEvaluation, { allowed: false }> {
  return {
    allowed: false,
    reason: "tool_paused",
    receipt: {
      ...allowedEvaluation().receipt,
      decision: "deny",
      detail: "tool paused",
      ...receiptOverrides,
    },
  };
}

function invokeRequest(
  evaluation: GateEvaluation,
  expectedOverrides: Record<string, unknown> = {},
): Request {
  const receipt = evaluation.receipt;
  return new Request("https://broker.internal/internal/invoke", {
    method: "POST",
    headers: {
      authorization: "Bearer gateway-broker-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      runtimeId: "acct_demo:golden-research-assistant:production",
      input: {
        requestId: receipt.requestId,
        tool: receipt.tool,
        arguments: evaluation.allowed ? evaluation.effectiveArguments : {},
      },
      expected: {
        deploymentId: receipt.deploymentId,
        version: receipt.version,
        policyDigest: receipt.policyDigest,
        bindingsDigest: receipt.bindingsDigest,
        availabilityDigest: receipt.availabilityDigest,
        tool: receipt.tool,
        connectionRef: receipt.connectionRef,
        ...expectedOverrides,
      },
    }),
  });
}

function brokerEnv(evaluation: GateEvaluation) {
  return {
    CONTROL_BROKER_TOKEN: "control-broker-secret",
    GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-secret",
    CREDENTIAL_VAULTS: fakeCredentialVaults(),
    GATES: {
      getByName() {
        return {
          async evaluateJson() {
            return JSON.stringify(evaluation);
          },
        };
      },
    },
  } as never;
}

function leaseFields() {
  return {
    accountId: "acct_demo",
    connectionId: "con_google",
    providerAppId: "app_google",
    provider: "google",
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    subject: "google-sub",
    grantedScopes: [],
  };
}
