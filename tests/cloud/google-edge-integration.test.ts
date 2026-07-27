import { GENERATED_ADAPTERS } from "@smcllns/angel-core";
import { describe, expect, mock, test } from "bun:test";
import { sha256Hex } from "@smcllns/angel-core";

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

const { handleGatewayRequest } = await import("../../src/workers/gateway");
const { handleBrokerRequest } = await import("../../src/workers/broker");

describe("real Google edge through both gates", () => {
  test("returns Gmail and Docs payloads with agent-safe converged receipts", async () => {
    const key = "angel-key";
    const events: string[] = [];
    const accessTokens: string[] = [];
    const receiptFor = (input: { requestId: string; tool: string; arguments: Record<string, unknown> }, gate: "gateway" | "broker") => ({
      allowed: true as const,
      reason: "allowed" as const,
      effectiveArguments: input.arguments,
      execution: {
        origin: GENERATED_ADAPTERS[input.tool.startsWith("docs.") ? "docs" : "gmail"]!.origin,
        request: GENERATED_ADAPTERS[input.tool.startsWith("docs.") ? "docs" : "gmail"]!.operations[input.tool]!.request,
      },
      receipt: {
        sequence: events.length,
        gate,
        accountId: "acct_real",
        angelId: "angel_real",
        environment: "production" as const,
        deploymentId: "dep_real",
        version: 1,
        policyDigest: "a".repeat(64),
        bindingsDigest: "b".repeat(64),
        availabilityDigest: "c".repeat(64),
        requestId: input.requestId,
        tool: input.tool,
        provider: input.tool.startsWith("docs.") ? "docs" : "gmail",
        operation: input.tool,
        connectionId: "con_real",
        connectionRef: "arc_real",
        connectionIdentityLabel: "Real Google",
        argumentsDigest: "d".repeat(64),
        decision: "allow" as const,
        detail: "exact policy allowed",
        previousHash: "e".repeat(64),
        hash: "f".repeat(64),
      },
    });
    const state = { gatewayKeyHash: await sha256Hex(key) };
    const gate = (kind: "gateway" | "broker") => ({
      async snapshot() {
        events.push(`${kind}:snapshot`);
        return state;
      },
      async evaluateJson(_gate: "gateway" | "broker", input: { requestId: string; tool: string; arguments: Record<string, unknown> }) {
        events.push(`${kind}:evaluate`);
        return JSON.stringify(receiptFor(input, kind));
      },
    });
    const vault = {
      async fetch(input: string | Request) {
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/connections/con_real/lease") {
          events.push("custody:lease");
          return Response.json({
            accountId: "acct_real",
            connectionId: "con_real",
            providerAppId: "app_google",
            provider: "google",
            clientId: "client-id",
            clientSecret: "client-secret",
            refreshToken: "refresh-token",
            subject: "google-sub",
            grantedScopes: [],
          });
        }
        throw new Error(`unexpected vault path ${url.pathname}`);
      },
    };
    const fetcher = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        events.push("google:refresh");
        const token = `access-${accessTokens.length + 1}`;
        accessTokens.push(token);
        return Response.json({ access_token: token, token_type: "Bearer", expires_in: 3600 });
      }
      events.push(`google:${new URL(url).pathname}`);
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(`Bearer ${accessTokens.at(-1)}`);
      return url.includes("gmail.googleapis.com")
        ? Response.json({ messages: [{ id: "msg_real" }] })
        : Response.json({ documentId: "doc_real", title: "Real M1" });
    };
    const brokerEnv = {
      CONTROL_BROKER_TOKEN: "control-broker",
      GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker",
      GATES: { getByName: () => gate("broker") },
      CREDENTIAL_VAULTS: { getByName: () => vault },
    };
    const broker = {
      async fetch(input: string | URL | Request, init?: RequestInit) {
        return handleBrokerRequest(
          typeof input === "string" || input instanceof URL ? new Request(input.toString(), init) : input,
          brokerEnv as never,
          undefined,
          fetcher,
        );
      },
    };
    const gatewayEnv = {
      CONTROL_GATEWAY_TOKEN: "control-gateway",
      GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker",
      GATES: { getByName: () => gate("gateway") },
      BROKER: broker,
    };

    for (const [id, tool, args, expectedPayload] of [
      [1, "gmail.users.messages.list", { maxResults: 5 }, { messages: [{ id: "msg_real" }] }],
      [2, "docs.documents.get", { documentId: "doc_ABC_-123" }, { documentId: "doc_real", title: "Real M1" }],
    ] as const) {
      const response = await handleGatewayRequest(new Request("https://gateway.test/v1/a/acct_real/angel_real/production/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } }),
      }), gatewayEnv as never);
      expect(response.status).toBe(200);
      const body = await response.json() as { result: { structuredContent: unknown; _meta: { gateway: Record<string, unknown>; broker: Record<string, unknown> } } };
      expect(body.result.structuredContent).toEqual(expectedPayload);
      expect(body.result._meta.gateway.connectionId).toBeUndefined();
      expect(body.result._meta.broker.connectionId).toBeUndefined();
      expect(body.result._meta.gateway.connectionRef).toBe("arc_real");
      expect(body.result._meta.broker.connectionRef).toBe("arc_real");
      expect(JSON.stringify(body)).not.toContain("con_real");
      expect(JSON.stringify(body)).not.toContain("refresh-token");
    }

    expect(events).toEqual([
      "gateway:snapshot", "gateway:evaluate", "broker:evaluate", "custody:lease", "google:refresh", "google:/gmail/v1/users/me/messages",
      "gateway:snapshot", "gateway:evaluate", "broker:evaluate", "custody:lease", "google:refresh", "google:/v1/documents/doc_ABC_-123",
    ]);
  });
});
