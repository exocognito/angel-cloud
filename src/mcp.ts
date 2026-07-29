import type { AvailableRuntimeTool, GateReceipt } from "./gate";

export const MCP_PROTOCOL_VERSION = "2025-06-18" as const;

export type McpRequestId = string | number;

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: {
    name: string;
    version: string;
    title?: string;
  };
}

export type AngelMcpRequest =
  | { jsonrpc: "2.0"; id: McpRequestId; method: "initialize"; params: McpInitializeParams }
  | { jsonrpc: "2.0"; method: "notifications/initialized"; params: Record<string, unknown> }
  | { jsonrpc: "2.0"; id: McpRequestId; method: "tools/list"; params: { cursor?: string } }
  | {
      jsonrpc: "2.0";
      id: McpRequestId;
      method: "tools/call";
      params: { name: string; arguments: Record<string, unknown> };
    };

export class McpRequestError extends Error {
  constructor(readonly code: -32600 | -32601 | -32602, message: string) {
    super(message);
  }
}

export function parseMcpRequest(value: unknown): AngelMcpRequest {
  const request = object(value, "JSON-RPC request", -32600);
  if (request.jsonrpc !== "2.0") throw new McpRequestError(-32600, "jsonrpc must equal 2.0");
  if (request.method === "notifications/initialized") {
    exactKeys(request, request.params === undefined
      ? ["jsonrpc", "method"]
      : ["jsonrpc", "method", "params"], "initialized notification", -32600);
    return {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: request.params === undefined
        ? {}
        : object(request.params, "initialized params", -32602),
    };
  }

  const id = request.id;
  if (typeof id !== "string" && typeof id !== "number") {
    throw new McpRequestError(-32600, "JSON-RPC request id must be a string or number");
  }
  if (request.method === "initialize") {
    exactKeys(request, ["jsonrpc", "id", "method", "params"], "initialize request", -32600);
    const params = object(request.params, "initialize params", -32602);
    exactKeysWithOptional(
      params,
      ["protocolVersion", "capabilities", "clientInfo"],
      ["_meta"],
      "initialize params",
    );
    if (typeof params.protocolVersion !== "string" || params.protocolVersion === "") {
      throw new McpRequestError(-32602, "initialize protocolVersion is required");
    }
    const capabilities = object(params.capabilities, "initialize capabilities", -32602);
    const clientInfo = object(params.clientInfo, "initialize clientInfo", -32602);
    exactKeysWithOptional(clientInfo, ["name", "version"], ["title"], "initialize clientInfo");
    const name = requiredString(clientInfo.name, "initialize clientInfo.name");
    const version = requiredString(clientInfo.version, "initialize clientInfo.version");
    const title = optionalString(clientInfo.title, "initialize clientInfo.title");
    return {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: params.protocolVersion,
        capabilities,
        clientInfo: {
          name,
          version,
          ...(title === undefined ? {} : { title }),
        },
      },
    };
  }
  if (request.method === "tools/list") {
    exactKeys(request, request.params === undefined
      ? ["jsonrpc", "id", "method"]
      : ["jsonrpc", "id", "method", "params"], "tools/list request", -32600);
    const params = request.params === undefined
      ? {}
      : object(request.params, "tools/list params", -32602);
    exactKeysWithOptional(params, [], ["cursor", "_meta"], "tools/list params");
    const cursor = optionalString(params.cursor, "tools/list cursor");
    return { jsonrpc: "2.0", id, method: "tools/list", params: cursor === undefined ? {} : { cursor } };
  }
  if (request.method === "tools/call") {
    exactKeys(request, ["jsonrpc", "id", "method", "params"], "tools/call request", -32600);
    const params = object(request.params, "tools/call params", -32602);
    exactKeysWithOptional(params, ["name"], ["arguments", "_meta"], "tools/call params");
    const name = requiredString(params.name, "tool name");
    return {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: params.arguments === undefined
          ? {}
          : object(params.arguments, "tool arguments", -32602),
      },
    };
  }
  if (typeof request.method !== "string") {
    throw new McpRequestError(-32600, "JSON-RPC request method must be a string");
  }
  throw new McpRequestError(-32601, `unsupported MCP method: ${request.method}`);
}

export function validateMcpPost(request: Request, subsequent: boolean): void {
  const accepted = new Set(
    (request.headers.get("accept") ?? "")
      .split(",")
      .map((value) => value.trim().split(";", 1)[0]?.toLowerCase()),
  );
  if (!accepted.has("application/json") || !accepted.has("text/event-stream")) {
    throw new McpTransportError(406, "Accept must include application/json and text/event-stream");
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new McpTransportError(415, "Content-Type must be application/json");
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    throw new McpTransportError(403, "Origin is not allowed");
  }
  if (subsequent && request.headers.get("mcp-protocol-version") !== MCP_PROTOCOL_VERSION) {
    throw new McpTransportError(400, `MCP-Protocol-Version must equal ${MCP_PROTOCOL_VERSION}`);
  }
}

export class McpTransportError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function mcpResult(id: McpRequestId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

export function mcpError(id: McpRequestId | null, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

export function mcpAccepted(): Response {
  return new Response(null, { status: 202 });
}

export function mcpMethodNotAllowed(allow = "POST"): Response {
  return new Response(null, { status: 405, headers: { allow } });
}

export function mcpToolDefinitions(runtimeTools: AvailableRuntimeTool[]) {
  return runtimeTools.map(({ tool, connections }) => {
    const choices = connections.map((connection) => ({
      const: connection.ref,
      title: `${connection.provider} - ${connection.identity}`,
    }));
    return {
      name: tool.name,
      description: `${tool.operation} through the exact deployed Angel policy`,
      inputSchema: {
        type: "object",
        properties: {
          angel_connection: {
            type: "string",
            oneOf: choices,
          },
        },
        ...(connections.length > 1 ? { required: ["angel_connection"] } : {}),
        additionalProperties: true,
      },
      _meta: {
        "angelmcp.dev/connections": connections,
      },
    };
  });
}

export type AgentSafeGateReceipt = Pick<
  GateReceipt,
  | "requestId"
  | "gate"
  | "deploymentId"
  | "version"
  | "policyDigest"
  | "availabilityDigest"
  | "tool"
  | "provider"
  | "operation"
  | "connectionRef"
  | "decision"
  | "detail"
>;

export function agentSafeGateReceipt(receipt: GateReceipt): AgentSafeGateReceipt {
  return {
    requestId: receipt.requestId,
    gate: receipt.gate,
    deploymentId: receipt.deploymentId,
    version: receipt.version,
    policyDigest: receipt.policyDigest,
    availabilityDigest: receipt.availabilityDigest,
    tool: receipt.tool,
    provider: receipt.provider,
    operation: receipt.operation,
    connectionRef: receipt.connectionRef,
    decision: receipt.decision,
    detail: receipt.detail,
  };
}

export function mcpToolDenied(
  id: McpRequestId,
  denial: {
    requestId: string;
    reason: string;
    detail: string;
    gateway: AgentSafeGateReceipt;
    broker?: AgentSafeGateReceipt;
  },
): ReturnType<typeof mcpResult> {
  return mcpResult(id, {
    content: [{ type: "text", text: denial.detail }],
    isError: true,
    structuredContent: {
      requestId: denial.requestId,
      denial: { reason: denial.reason, detail: denial.detail },
    },
    _meta: {
      requestId: denial.requestId,
      gateway: denial.gateway,
      broker: denial.broker ?? null,
    },
  });
}

function object(
  value: unknown,
  path: string,
  code: -32600 | -32602,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new McpRequestError(code, `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") throw new McpRequestError(-32602, `${path} is required`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, path);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
  path: string,
  code: -32600 | -32602,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new McpRequestError(code, `${path} must contain exactly ${sortedExpected.join(", ")}`);
  }
}

function exactKeysWithOptional(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new McpRequestError(
      -32602,
      `${path} must contain ${required.join(", ")}${optional.length === 0 ? "" : ` and only optional ${optional.join(", ")}`}`,
    );
  }
}
