import { describe, expect, mock, test } from "bun:test";
import {
  mcpAccepted,
  mcpMethodNotAllowed,
  mcpToolDenied,
  parseMcpRequest,
  validateMcpPost,
} from "../../src/mcp";
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

const endpoint = "https://gateway.example/v1/a/acct_demo/angel_demo/production/mcp";
const accept = "application/json, text/event-stream";

// Direct protocol contracts avoid an SDK-only dependency; the deployed golden run covers Worker wiring.
describe("MCP 2025-06-18 Streamable HTTP contract", () => {
  test("negotiates a real initialize request and accepts initialized with no body", async () => {
    const initializeRequest = new Request(endpoint, {
      method: "POST",
      headers: { accept, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "contract-client", version: "1.0.0" },
        },
      }),
    });
    validateMcpPost(initializeRequest, false);
    expect(parseMcpRequest(await initializeRequest.json())).toMatchObject({
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });

    const initializedRequest = new Request(endpoint, {
      method: "POST",
      headers: {
        accept,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    validateMcpPost(initializedRequest, true);
    expect(parseMcpRequest(await initializedRequest.json()).method).toBe("notifications/initialized");
    const accepted = mcpAccepted();
    expect(accepted.status).toBe(202);
    expect(await accepted.text()).toBe("");
  });

  test("returns 405 for GET because this server does not expose an SSE listener", async () => {
    const response = mcpMethodNotAllowed();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  test("returns a policy denial as CallToolResult isError and never reaches Broker", async () => {
    const receipt = {
      requestId: "req_guard",
      gate: "gateway" as const,
      deploymentId: "dep_1",
      version: 1,
      policyDigest: "digest-v1",
      availabilityDigest: "availability-v1",
      tool: "gmail.users.messages.list",
      provider: "gmail",
      operation: "gmail.users.messages.list",
      connectionRef: "arc_google",
      decision: "deny" as const,
      detail: "argGuard: maxResults is pinned to 5",
    };
    expect(mcpToolDenied(2, {
      requestId: "req_guard",
      reason: "guard_denied",
      detail: "argGuard: maxResults is pinned to 5",
      gateway: receipt,
    })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "text", text: "argGuard: maxResults is pinned to 5" }],
        isError: true,
        structuredContent: {
          requestId: "req_guard",
          denial: { reason: "guard_denied", detail: "argGuard: maxResults is pinned to 5" },
        },
        _meta: { requestId: "req_guard", gateway: receipt, broker: null },
      },
    });
  });
});

describe("Gateway MCP Angel key authentication", () => {
  test("rejects absent and empty Angel keys before state access, and invalid state before body parsing", async () => {
    const noStateEnv = {
      CONTROL_GATEWAY_TOKEN: "control-gateway",
      GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-invoke",
      GATES: { getByName: () => { throw new Error("state must not be reached"); } },
    } as never;
    for (const authorization of [undefined, "Bearer "]) {
      const response = await handleGatewayRequest(new Request(endpoint, {
        method: "POST",
        headers: {
          accept,
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        body: "not json",
      }), noStateEnv);
      expect(response.status).toBe(401);
    }

    let stateReads = 0;
    const stateEnv = (state: unknown) => ({
      CONTROL_GATEWAY_TOKEN: "control-gateway",
      GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-invoke",
      GATES: {
        getByName() {
          stateReads += 1;
          return { snapshot: async () => state };
        },
      },
    }) as never;
    for (const [authorization, state] of [
      ["Bearer ak_production_test", {}],
      ["Bearer ak_production_test", { gatewayKeyHash: undefined }],
      ["Bearer ak_production_test", { gatewayKeyHash: null }],
      ["Bearer ak_production_test", { gatewayKeyHash: "" }],
      ["Bearer wrong_key", { gatewayKeyHash: await sha256Hex("ak_production_test") }],
    ] as const) {
      const response = await handleGatewayRequest(new Request(endpoint, {
        method: "POST",
        headers: { accept, authorization, "content-type": "application/json" },
        body: "not json",
      }), stateEnv(state));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "invalid Angel key" },
      });
    }
    expect(stateReads).toBe(5);
  });

  test("rejects missing and wrong Angel keys for initialize, initialized, and tools/list", async () => {
    const env = await gatewayEnv("ak_production_test");
    const messages = [
      {
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "contract-client", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "list", method: "tools/list" },
    ];

    for (const message of messages) {
      for (const authorization of [undefined, "Bearer wrong_key"]) {
        const response = await handleGatewayRequest(mcpRequest(message, authorization), env);
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          jsonrpc: "2.0",
          error: { code: -32001, message: "invalid Angel key" },
        });
      }
    }
  });

  test("accepts the environment Angel key for initialize, initialized, and tools/list", async () => {
    const key = "ak_production_test";
    const env = await gatewayEnv(key);
    const authorization = `Bearer ${key}`;

    const initialized = await handleGatewayRequest(mcpRequest({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "contract-client", version: "1.0.0" },
      },
    }, authorization), env);
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "AngelMCP" } },
    });

    const notification = await handleGatewayRequest(mcpRequest({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, authorization), env);
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");

    const listed = await handleGatewayRequest(mcpRequest({
      jsonrpc: "2.0",
      id: "list",
      method: "tools/list",
    }, authorization), env);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      result: { tools: [{ name: "gmail.users.messages.list" }] },
    });
  });

  test("lists opaque active Connection choices without management IDs or nicknames", async () => {
    const key = "ak_production_test";
    const env = await gatewayEnv(key, {
      state: {
        gatewayKeyHash: await sha256Hex(key),
        installation: {
          artifact: {
            tools: [
              {
                name: "docs.documents.get",
                provider: "docs",
                operation: "docs.documents.get",
                argGuards: [],
              },
              {
                name: "gmail.users.messages.list",
                provider: "gmail",
                operation: "gmail.users.messages.list",
                argGuards: [],
              },
            ],
          },
          bindings: [
            {
              tool: "docs.documents.get",
              connectionRef: "arc_personal",
              connectionId: "con_management_personal",
              provider: "docs",
              identityLabel: "sam@example.com",
            },
            {
              tool: "gmail.users.messages.list",
              connectionRef: "arc_personal",
              connectionId: "con_management_personal",
              provider: "gmail",
              identityLabel: "sam@example.com",
            },
            {
              tool: "gmail.users.messages.list",
              connectionRef: "arc_work",
              connectionId: "con_management_work",
              provider: "gmail",
              identityLabel: "sam@work.example",
            },
          ],
        },
        availability: {
          defaultEnabled: true,
          overrides: {},
          connectionOverrides: {},
          revision: 0,
        },
      },
    });

    const response = await handleGatewayRequest(mcpRequest({
      jsonrpc: "2.0",
      id: "list-connections",
      method: "tools/list",
    }, `Bearer ${key}`), env);
    const payload = await response.json() as {
      result: { tools: Array<Record<string, unknown>> };
    };

    const docs = payload.result.tools.find((tool) => tool.name === "docs.documents.get");
    expect(docs).toMatchObject({
      inputSchema: {
        type: "object",
        properties: {
          angel_connection: {
            type: "string",
            oneOf: [{ const: "arc_personal", title: "docs - sam@example.com" }],
          },
        },
      },
      _meta: {
        "angelmcp.dev/connections": [
          { ref: "arc_personal", provider: "docs", identity: "sam@example.com" },
        ],
      },
    });
    expect((docs!.inputSchema as { required?: string[] }).required).toBeUndefined();

    const gmail = payload.result.tools.find((tool) => tool.name === "gmail.users.messages.list");
    expect(gmail).toMatchObject({
      inputSchema: {
        properties: {
          angel_connection: {
            oneOf: [
              { const: "arc_personal", title: "gmail - sam@example.com" },
              { const: "arc_work", title: "gmail - sam@work.example" },
            ],
          },
        },
        required: ["angel_connection"],
      },
    });
    expect(JSON.stringify(payload)).not.toContain("con_management");
    expect(JSON.stringify(payload)).not.toContain("personal-google");
  });

  test("returns an internal JSON-RPC error when allowed Gateway and Broker receipts disagree", async () => {
    const key = "ak_production_test";
    const gatewayReceipt = allowedReceipt("gateway", { policyDigest: "digest-gateway" });
    const brokerReceipt = allowedReceipt("broker", { policyDigest: "digest-broker" });
    const env = await gatewayEnv(key, {
      gatewayReceipt,
      brokerResponse: Response.json({
        error: "gate receipt mismatch",
        mismatch: {
          field: "policyDigest",
          expected: gatewayReceipt.policyDigest,
          actual: brokerReceipt.policyDigest,
        },
        evaluation: {
          allowed: true,
          reason: "allowed",
          effectiveArguments: { maxResults: "5", userId: "me" },
          // Broker internals that must never reach the agent-facing payload.
          execution: {
            origin: "https://gmail.googleapis.com",
            request: { kind: "http", method: "GET", pathTemplate: "/gmail/v1/users/{userId}/messages" },
          },
          receipt: brokerReceipt,
        },
      }, { status: 409 }),
    });

    const response = await handleGatewayRequest(mcpRequest({
      jsonrpc: "2.0",
      id: "mismatch",
      method: "tools/call",
      params: { name: "gmail.users.messages.list", arguments: {} },
    }, `Bearer ${key}`), env);

    expect(response.status).toBe(500);
    const serialized = await response.clone().text();
    expect(serialized).not.toContain("pathTemplate");
    expect(serialized).not.toContain("gmail.googleapis.com");
    expect(serialized).not.toContain("effectiveArguments");
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: "mismatch",
      error: {
        code: -32603,
        message: "Angel gates failed to converge",
        data: {
          error: "gate receipt mismatch",
          mismatch: {
            field: "policyDigest",
            expected: "digest-gateway",
            actual: "digest-broker",
          },
          gateway: { decision: "allow", policyDigest: "digest-gateway" },
          broker: { evaluation: { allowed: true, receipt: { policyDigest: "digest-broker" } } },
        },
      },
    });
  });

  test("returns a Broker provider failure without assuming a gate evaluation exists", async () => {
    const key = "ak_production_test";
    const env = await gatewayEnv(key, {
      gatewayReceipt: allowedReceipt("gateway", {
        tool: "docs.documents.get",
        provider: "docs",
        operation: "docs.documents.get",
      }),
      brokerResponse: Response.json({
        error: "Google docs.documents.get request failed with status 403",
      }, { status: 500 }),
    });

    const response = await handleGatewayRequest(mcpRequest({
      jsonrpc: "2.0",
      id: "provider-failure",
      method: "tools/call",
      params: { name: "docs.documents.get", arguments: { documentId: "document-id" } },
    }, `Bearer ${key}`), env);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: "provider-failure",
      error: {
        code: -32003,
        message: "Google docs.documents.get request failed with status 403",
        data: {
          error: "Google docs.documents.get request failed with status 403",
          gateway: { decision: "allow" },
          broker: { error: "Google docs.documents.get request failed with status 403" },
        },
      },
    });
  });

  test("treats a mismatched Broker denial as convergence failure rather than policy denial", async () => {
    const key = "ak_production_test";
    const gatewayReceipt = allowedReceipt("gateway", { availabilityDigest: "gateway-availability" });
    const brokerReceipt = {
      ...allowedReceipt("broker", { availabilityDigest: "broker-availability" }),
      decision: "deny" as const,
      detail: "tool paused",
    };
    const env = await gatewayEnv(key, {
      gatewayReceipt,
      brokerResponse: Response.json({
        error: "gate receipt mismatch",
        mismatch: {
          field: "availabilityDigest",
          expected: gatewayReceipt.availabilityDigest,
          actual: brokerReceipt.availabilityDigest,
        },
        evaluation: {
          allowed: false,
          reason: "tool_paused",
          receipt: brokerReceipt,
        },
      }, { status: 409 }),
    });

    const response = await handleGatewayRequest(mcpRequest({
      jsonrpc: "2.0",
      id: "mismatched-denial",
      method: "tools/call",
      params: { name: "gmail.users.messages.list", arguments: {} },
    }, `Bearer ${key}`), env);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: {
        code: -32603,
        message: "Angel gates failed to converge",
        data: {
          mismatch: { field: "availabilityDigest" },
          broker: { evaluation: { allowed: false, reason: "tool_paused" } },
        },
      },
    });
  });

  test("preserves both receipts when Gateway detects a mismatch after a successful Broker response", async () => {
    const key = "ak_production_test";
    const gatewayReceipt = allowedReceipt("gateway", { policyDigest: "digest-gateway" });
    const brokerReceipt = allowedReceipt("broker", { policyDigest: "digest-broker" });
    const env = await gatewayEnv(key, {
      gatewayReceipt,
      brokerResponse: Response.json({
        evaluation: {
          allowed: true,
          reason: "allowed",
          effectiveArguments: {},
          receipt: brokerReceipt,
        },
        result: { messages: [] },
      }),
    });

    const response = await handleGatewayRequest(mcpRequest({
      jsonrpc: "2.0",
      id: "post-broker-mismatch",
      method: "tools/call",
      params: { name: "gmail.users.messages.list", arguments: {} },
    }, `Bearer ${key}`), env);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: {
        code: -32603,
        data: {
          error: "gate receipt mismatch",
          gateway: { gate: "gateway", policyDigest: "digest-gateway" },
          broker: {
            evaluation: {
              allowed: true,
              receipt: { gate: "broker", policyDigest: "digest-broker" },
            },
          },
        },
      },
    });
  });

  test("forwards the selected ref privately to Broker without restoring the public selector", async () => {
    const key = "ak_production_test";
    const gatewayReceipt = allowedReceipt("gateway", {
      connectionRef: "arc_work",
      connectionId: "con_work",
    });
    const brokerReceipt = allowedReceipt("broker", {
      connectionRef: "arc_work",
      connectionId: "con_work",
    });
    let brokerBody: unknown;
    const env = await gatewayEnv(key, {
      gatewayReceipt,
      onBrokerRequest: async (request) => {
        brokerBody = await request.json();
      },
      brokerResponse: Response.json({
        evaluation: {
          allowed: true,
          reason: "allowed",
          effectiveArguments: { maxResults: "5" },
          receipt: brokerReceipt,
        },
        result: { messages: [] },
      }),
    });

    const response = await handleGatewayRequest(mcpRequest({
      jsonrpc: "2.0",
      id: "selected-connection",
      method: "tools/call",
      params: {
        name: "gmail.users.messages.list",
        arguments: { angel_connection: "arc_work" },
      },
    }, `Bearer ${key}`), env);

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      result: { _meta: { gateway: Record<string, unknown>; broker: Record<string, unknown> } };
    };
    expect(brokerBody).toMatchObject({
      input: {
        tool: "gmail.users.messages.list",
        connectionRef: "arc_work",
        arguments: {},
      },
      expected: { connectionRef: "arc_work" },
    });
    expect(JSON.stringify(brokerBody)).not.toContain("angel_connection");
    expect(payload.result._meta).toMatchObject({
      gateway: { connectionRef: "arc_work", policyDigest: "digest-v1", version: 1 },
      broker: { connectionRef: "arc_work", policyDigest: "digest-v1", version: 1 },
    });
    expect(JSON.stringify(payload)).not.toContain("con_work");
    expect(JSON.stringify(payload)).not.toContain("connectionId");
    expect(JSON.stringify(payload)).not.toContain("connectionIdentityLabel");
  });

  test("projects a denied Gateway receipt without private Connection management data", async () => {
    const key = "ak_production_test";
    const receipt = {
      ...allowedReceipt("gateway", {
        connectionRef: "arc_work",
        connectionId: "con_private_work",
        connectionIdentityLabel: "provider-derived@example.com",
      }),
      decision: "deny" as const,
      detail: "angel_connection is paused for this tool",
    };
    const env = await gatewayEnv(key, {
      gatewayEvaluation: {
        allowed: false,
        reason: "connection_paused",
        receipt,
      },
    });

    const response = await handleGatewayRequest(mcpRequest({
      jsonrpc: "2.0",
      id: "denied-connection",
      method: "tools/call",
      params: {
        name: "gmail.users.messages.list",
        arguments: { angel_connection: "arc_work" },
      },
    }, `Bearer ${key}`), env);
    const payload = await response.json() as {
      result: { _meta: { gateway: Record<string, unknown>; broker: null } };
    };

    expect(response.status).toBe(200);
    expect(payload.result._meta).toMatchObject({
      gateway: { connectionRef: "arc_work", policyDigest: "digest-v1", version: 1 },
      broker: null,
    });
    expect(JSON.stringify(payload)).not.toContain("con_private_work");
    expect(JSON.stringify(payload)).not.toContain("connectionId");
    expect(JSON.stringify(payload)).not.toContain("connectionIdentityLabel");
  });
});

test("does not expose a parallel REST tool invocation surface", async () => {
  const env = await gatewayEnv("ak_production_test");
  const response = await handleGatewayRequest(new Request(
    "https://gateway.example/v1/a/acct_demo/angel_demo/production/tools/gmail.users.messages.list",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    },
  ), env);

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not found" });
});

async function gatewayEnv(
  key: string,
  options: {
    gatewayReceipt?: ReturnType<typeof allowedReceipt>;
    brokerResponse?: Response;
    state?: unknown;
    onBrokerRequest?: (request: Request) => Promise<void>;
    gatewayEvaluation?: unknown;
  } = {},
): Promise<GatewayEnv> {
  const gatewayKeyHash = await sha256Hex(key);
  return {
    CONTROL_GATEWAY_TOKEN: "control-gateway",
    GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-invoke",
    GATES: {
      getByName() {
        return {
          async snapshot() {
            return options.state ?? {
              gatewayKeyHash,
              installation: {
                artifact: {
                  tools: [{
                    name: "gmail.users.messages.list",
                    provider: "gmail",
                    operation: "gmail.users.messages.list",
                    argGuards: [],
                  }],
                },
                bindings: [{
                  tool: "gmail.users.messages.list",
                  connectionRef: "arc_google",
                  connectionId: "con_google",
                  provider: "gmail",
                  identityLabel: "sam@example.com",
                }],
              },
              availability: {
                defaultEnabled: true,
                overrides: {},
                connectionOverrides: {},
                revision: 0,
              },
            };
          },
          async evaluateJson() {
            if (options.gatewayEvaluation !== undefined) {
              return JSON.stringify(options.gatewayEvaluation);
            }
            if (options.gatewayReceipt === undefined) throw new Error("unexpected Gateway evaluation");
            return JSON.stringify({
              allowed: true,
              reason: "allowed",
              effectiveArguments: {},
              receipt: options.gatewayReceipt,
            });
          },
        };
      },
    },
    BROKER: {
      fetch: async (input: string, init?: RequestInit) => {
        if (options.onBrokerRequest !== undefined) {
          await options.onBrokerRequest(new Request(input, init));
        }
        return options.brokerResponse
          ?? Response.json({ error: "unexpected Broker call" }, { status: 500 });
      },
    },
  } as never;
}

function allowedReceipt(
  gate: "gateway" | "broker",
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    sequence: 1,
    requestId: "req_mismatch",
    gate,
    accountId: "acct_demo",
    angelId: "angel_demo",
    environment: "production",
    deploymentId: "dep_1",
    version: 1,
    policyDigest: "digest-v1",
    bindingsDigest: "bindings-v1",
    availabilityDigest: "availability-v1",
    tool: "gmail.users.messages.list",
    provider: "gmail",
    operation: "gmail.users.messages.list",
    connectionId: "conn_google",
    connectionIdentityLabel: "sam@example.com",
    argumentsDigest: "args",
    decision: "allow" as const,
    detail: "allowed by compiled policy",
    previousHash: "0",
    hash: "1",
    ...overrides,
  };
}

function mcpRequest(message: unknown, authorization?: string): Request {
  const method = (message as { method?: string }).method;
  return new Request(endpoint, {
    method: "POST",
    headers: {
      accept,
      "content-type": "application/json",
      ...(method === "initialize" ? {} : { "mcp-protocol-version": "2025-06-18" }),
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify(message),
  });
}
