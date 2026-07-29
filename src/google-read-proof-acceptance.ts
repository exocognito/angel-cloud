import type { FetchLike } from "@smcllns/angel-core";
import { MCP_PROTOCOL_VERSION } from "./mcp";

export const GOOGLE_READ_PROOF_OPERATIONS = [
  "gmail.users.messages.list",
  "docs.documents.get",
] as const;

type GoogleReadProofOperation = (typeof GOOGLE_READ_PROOF_OPERATIONS)[number];

export interface GoogleReadProofAcceptanceOptions {
  gatewayUrl: string;
  angelKey: string;
  gmailQuery: string;
  documentId: string;
  expectedPolicyDigest: string;
  fetch?: FetchLike;
}

export interface GoogleReadProofAcceptanceReport {
  passed: true;
  operations: Array<{
    operation: GoogleReadProofOperation;
    requestId: string;
    deploymentId: string;
    version: number;
    policyDigest: string;
    availabilityDigest: string;
    checks: {
      gateway: true;
      broker: true;
      receiptMatch: true;
      response: true;
    };
  }>;
}

interface ListedTool {
  name: string;
  connectionRef: string;
}

interface SafeReceipt {
  requestId: string;
  gate: string;
  deploymentId: string;
  version: number;
  policyDigest: string;
  availabilityDigest: string;
  tool: string;
  provider: string;
  operation: string;
  connectionRef: string;
  decision: "allow";
}

export function googleReadProofOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  expectedPolicyDigest: string,
): GoogleReadProofAcceptanceOptions {
  validatePolicyDigest(expectedPolicyDigest);
  return {
    gatewayUrl: requiredEnvironment(env, "GOLDEN_GATEWAY_URL", validateGatewayUrl),
    angelKey: requiredEnvironment(env, "GOLDEN_ANGEL_KEY"),
    gmailQuery: requiredEnvironment(env, "GOLDEN_GMAIL_QUERY"),
    documentId: requiredEnvironment(env, "GOLDEN_DOC_ID", validateDocumentId),
    expectedPolicyDigest,
  };
}

export async function runGoogleReadProofAcceptance(
  input: GoogleReadProofAcceptanceOptions,
): Promise<GoogleReadProofAcceptanceReport> {
  validateGatewayUrl(input.gatewayUrl);
  validateNonEmptyInput(input.angelKey, "GOLDEN_ANGEL_KEY");
  validateNonEmptyInput(input.gmailQuery, "GOLDEN_GMAIL_QUERY");
  validateDocumentId(input.documentId);
  validatePolicyDigest(input.expectedPolicyDigest);
  const fetch = input.fetch ?? globalThis.fetch;
  const headers = mcpHeaders(input.angelKey);

  await initialize(fetch, input.gatewayUrl, headers);
  const tools = await listTools(fetch, input.gatewayUrl, headers);
  const listedByOperation = new Map(tools.map((tool) => [tool.name, tool]));
  const gmailConnectionRef = listedByOperation.get("gmail.users.messages.list")!.connectionRef;
  const docsConnectionRef = listedByOperation.get("docs.documents.get")!.connectionRef;
  if (gmailConnectionRef !== docsConnectionRef) {
    throw new Error("M1 proof requires both canonical tools to expose the same non-empty opaque Connection ref");
  }
  const calls = [
    await callTool(fetch, input.gatewayUrl, headers, "gmail.users.messages.list", {
      q: input.gmailQuery,
      maxResults: 5,
    }, gmailConnectionRef, input.expectedPolicyDigest),
    await callTool(fetch, input.gatewayUrl, headers, "docs.documents.get", {
      documentId: input.documentId,
    }, docsConnectionRef, input.expectedPolicyDigest),
  ];
  const requestIds = new Set<string>();
  for (const call of calls) {
    if (requestIds.has(call.gateway.requestId)) {
      throw new Error("acceptance calls did not receive distinct request correlations");
    }
    requestIds.add(call.gateway.requestId);
  }

  return {
    passed: true,
    operations: calls.map((call) => ({
      operation: call.operation,
      requestId: call.gateway.requestId,
      deploymentId: call.gateway.deploymentId,
      version: call.gateway.version,
      policyDigest: call.gateway.policyDigest,
      availabilityDigest: call.gateway.availabilityDigest,
      checks: { gateway: true, broker: true, receiptMatch: true, response: true },
    })),
  };
}

export function serializeGoogleReadProofReport(
  report: GoogleReadProofAcceptanceReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function initialize(fetch: FetchLike, url: string, headers: Headers): Promise<void> {
  const response = await requestJson(fetch, url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "google-read-proof-initialize",
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "angelmcp-google-read-proof", version: "1.0.0" },
      },
    }),
  }, "MCP initialize");
  const result = record(response.result, "MCP initialize result");
  if (
    result.protocolVersion !== MCP_PROTOCOL_VERSION
    || record(result.serverInfo, "MCP initialize serverInfo").name !== "AngelMCP"
  ) {
    throw new Error("MCP initialize did not negotiate the expected Angel contract");
  }

  const notificationHeaders = new Headers(headers);
  notificationHeaders.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
  const notification = await fetch(url, {
    method: "POST",
    headers: notificationHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  if (notification.status !== 202 || (await notification.text()) !== "") {
    throw new Error("MCP initialized notification failed");
  }
}

async function listTools(
  fetch: FetchLike,
  url: string,
  headers: Headers,
): Promise<ListedTool[]> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
  const response = await requestJson(fetch, url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "google-read-proof-tools",
      method: "tools/list",
      params: {},
    }),
  }, "MCP tools/list");
  const tools = record(response.result, "MCP tools/list result").tools;
  if (!Array.isArray(tools)) throw new Error("MCP tools/list returned no tool list");
  const listed = tools.map((value, index) => parseListedTool(value, index));
  const names = listed.map(({ name }) => name).sort();
  if (names.length !== GOOGLE_READ_PROOF_OPERATIONS.length
    || names.some((name, index) => name !== [...GOOGLE_READ_PROOF_OPERATIONS].sort()[index])) {
    throw new Error("tools/list did not expose exactly the canonical proof tools");
  }
  return listed;
}

async function callTool(
  fetch: FetchLike,
  url: string,
  headers: Headers,
  operation: GoogleReadProofOperation,
  args: Record<string, unknown>,
  expectedConnectionRef: string,
  expectedPolicyDigest: string,
): Promise<{ operation: GoogleReadProofOperation; gateway: SafeReceipt; broker: SafeReceipt }> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
  const response = await requestJson(fetch, url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `google-read-proof-${operation === "gmail.users.messages.list" ? "gmail" : "docs"}`,
      method: "tools/call",
      params: { name: operation, arguments: args },
    }),
  }, operation);
  const result = record(response.result, `${operation} result`);
  if (result.isError === true) throw new Error(`${operation} was denied by the deployed Angel`);
  const structured = record(result.structuredContent, `${operation} structured response`);
  if (operation === "gmail.users.messages.list") {
    if (!Array.isArray(structured.messages) || structured.messages.length === 0) {
      throw new Error("gmail.users.messages.list response did not contain a message");
    }
  } else if (structured.documentId !== args.documentId) {
    throw new Error("docs.documents.get response did not contain the requested document");
  }
  const metadata = record(result._meta, `${operation} metadata`);
  const gateway = parseReceipt(metadata.gateway, "Gateway", operation);
  const broker = parseReceipt(metadata.broker, "Broker", operation);
  assertReceiptPair(
    gateway,
    broker,
    operation,
    expectedConnectionRef,
    expectedPolicyDigest,
  );
  return { operation, gateway, broker };
}

function assertReceiptPair(
  gateway: SafeReceipt,
  broker: SafeReceipt,
  operation: GoogleReadProofOperation,
  expectedConnectionRef: string,
  expectedPolicyDigest: string,
): void {
  if (gateway.gate !== "gateway" || broker.gate !== "broker") {
    throw new Error(`${operation} did not succeed through both Angel gates`);
  }
  if (gateway.requestId !== broker.requestId) {
    throw new Error(`${operation} Gateway and Broker request correlations did not match`);
  }
  for (const field of ["deploymentId", "version", "policyDigest", "availabilityDigest", "tool", "provider", "operation", "connectionRef"] as const) {
    if (gateway[field] !== broker[field]) {
      throw new Error(`${operation} Gateway and Broker receipt identity did not match`);
    }
  }
  if (gateway.policyDigest !== expectedPolicyDigest) {
    throw new Error(`${operation} receipt policy digest did not match the checked-in google-read-proof build`);
  }
  if (
    gateway.tool !== operation
    || gateway.operation !== operation
    || gateway.connectionRef !== expectedConnectionRef
    || gateway.decision !== "allow"
    || broker.decision !== "allow"
  ) {
    throw new Error(`${operation} receipt did not prove the expected allowed operation`);
  }
}

function parseListedTool(value: unknown, index: number): ListedTool {
  const tool = record(value, `tools/list tool ${index}`);
  const name = nonEmptyString(tool.name, `tools/list tool ${index} name`);
  const schema = record(tool.inputSchema, `tools/list ${name} inputSchema`);
  if (Array.isArray(schema.required) && schema.required.includes("angel_connection")) {
    throw new Error(`${name} unexpectedly requires angel_connection`);
  }
  const metadata = record(tool._meta, `tools/list ${name} metadata`);
  const connections = metadata["angelmcp.dev/connections"];
  if (!Array.isArray(connections) || connections.length !== 1) {
    throw new Error(`${name} did not expose exactly one runtime Connection`);
  }
  const connection = record(connections[0], `tools/list ${name} Connection`);
  return { name, connectionRef: nonEmptyString(connection.ref, `${name} Connection ref`) };
}

function parseReceipt(value: unknown, label: string, operation: string): SafeReceipt {
  const receipt = record(value, `${label} ${operation} receipt`);
  const parsed = {
    requestId: nonEmptyString(receipt.requestId, `${label} requestId`),
    gate: nonEmptyString(receipt.gate, `${label} gate`),
    deploymentId: nonEmptyString(receipt.deploymentId, `${label} deploymentId`),
    version: integer(receipt.version, `${label} version`),
    policyDigest: nonEmptyString(receipt.policyDigest, `${label} policyDigest`),
    availabilityDigest: nonEmptyString(receipt.availabilityDigest, `${label} availabilityDigest`),
    tool: nonEmptyString(receipt.tool, `${label} tool`),
    provider: nonEmptyString(receipt.provider, `${label} provider`),
    operation: nonEmptyString(receipt.operation, `${label} operation`),
    connectionRef: nonEmptyString(receipt.connectionRef, `${label} connectionRef`),
    decision: receipt.decision,
  };
  if (parsed.decision !== "allow") throw new Error(`${operation} ${label} receipt was not allowed`);
  return parsed as SafeReceipt;
}

async function requestJson(
  fetch: FetchLike,
  url: string,
  init: RequestInit,
  label: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
  const payload = record(value, `${label} response`);
  if (!response.ok) {
    const error = payload.error;
    const message = typeof error === "object"
      && error !== null
      && !Array.isArray(error)
      && typeof (error as Record<string, unknown>).message === "string"
      ? `: ${(error as Record<string, unknown>).message}`
      : "";
    throw new Error(`${label} failed with HTTP ${response.status}${message}`);
  }
  if (payload.error !== undefined) throw new Error(`${label} returned an MCP error`);
  return payload;
}

function mcpHeaders(key: string): Headers {
  return new Headers({
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  });
}

function validateGatewayUrl(value: string): void {
  if (value.trim() !== value) {
    throw new Error("GOLDEN_GATEWAY_URL must be the exact google-read-proof production MCP endpoint");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GOLDEN_GATEWAY_URL must be the exact google-read-proof production MCP endpoint");
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || !isProductionReadProofPath(url.pathname)
  ) {
    throw new Error("GOLDEN_GATEWAY_URL must be the exact google-read-proof production MCP endpoint");
  }
}

/**
 * Production endpoints only: the bare PD 0001 coordinate (bare means
 * production — any suffix is another environment or a pinned Version), or the
 * legacy route with the explicit production segment.
 */
function isProductionReadProofPath(pathname: string): boolean {
  return /^\/@[a-z][a-z0-9-]*\/google-read-proof$/.test(pathname)
    || /^\/v1\/a\/[^/]+\/google-read-proof\/production\/mcp$/.test(pathname);
}

function validatePolicyDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("checked-in google-read-proof policy digest is invalid");
  }
}

function validateDocumentId(value: string): void {
  validateNonEmptyInput(value, "GOLDEN_DOC_ID");
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("GOLDEN_DOC_ID is malformed");
}

function validateNonEmptyInput(value: string, label: string): void {
  if (value.trim() !== value || value.trim() === "") throw new Error(`${label} must be a non-empty value`);
}

function requiredEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  validate: (value: string) => void = (value) => validateNonEmptyInput(value, name),
): string {
  const value = env[name];
  if (value === undefined) throw new Error(`${name} is required`);
  validate(value);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${label} is invalid`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label} is invalid`);
  return value as number;
}
