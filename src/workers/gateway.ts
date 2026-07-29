/// <reference path="../../types/gateway.d.ts" />

import { GateRuntime } from "./gate-object";
import {
  availableRuntimeTools,
  gateReceiptIdentity,
  gateReceiptMismatch,
  type GateEvaluation,
} from "../gate";
import { sha256Hex, timingSafeEqualText } from "@smcllns/angel-core";
import {
  MCP_PROTOCOL_VERSION,
  McpRequestError,
  McpTransportError,
  agentSafeGateReceipt,
  type AgentSafeGateReceipt,
  mcpAccepted,
  mcpError,
  mcpMethodNotAllowed,
  mcpResult,
  mcpToolDefinitions,
  mcpToolDenied,
  parseMcpRequest,
  validateMcpPost,
} from "../mcp";
import {
  dispatchGate,
  errorResponse,
  HttpError,
  requireBearerToken,
  requireDistinctRoleCredentials,
  requireInternalRequest,
} from "./protocol";
import { DurableObject } from "cloudflare:workers";
import { ACCOUNT_HANDLE_GRAMMAR, ACCOUNT_HANDLE_PATTERN, isInternalAccountId } from "../handles";
import { canonicalEnvironment, type HostedEnvironment } from "../environments";

export { GateRuntime };

/** Name of the single HandleDirectory instance in the HANDLES namespace. */
const HANDLE_DIRECTORY_INSTANCE = "directory";

/**
 * Replica of the Control-side handle directory, pushed by Control on every
 * claim, so handle resolution on the MCP request path stays inside this
 * worker. Bindings are append-only — PD 0004 never releases a name — and a
 * name can never move to a different Account.
 */
export class HandleDirectory extends DurableObject {
  // One storage key per name: the hot-path resolve reads exactly one key, and
  // prototype names like `constructor` are ordinary keys, never phantoms.
  async bind(handle: string, accountId: string): Promise<"bound" | "conflict"> {
    const existing = await this.ctx.storage.get<string>(`handle:${handle}`);
    if (existing !== undefined) return existing === accountId ? "bound" : "conflict";
    await this.ctx.storage.put(`handle:${handle}`, accountId);
    return "bound";
  }

  async resolve(handle: string): Promise<string | null> {
    return await this.ctx.storage.get<string>(`handle:${handle}`) ?? null;
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    return handleGatewayRequest(request, env);
  },
} satisfies ExportedHandler<GatewayEnv>;

export async function handleGatewayRequest(request: Request, env: GatewayEnv): Promise<Response> {
  try {
    await requireDistinctRoleCredentials(
      [env.CONTROL_GATEWAY_TOKEN, env.GATEWAY_BROKER_INVOKE_TOKEN],
      "gateway internal role credentials must be non-empty and distinct",
    );
    const url = new URL(request.url);
      if (url.pathname === "/internal/gate") {
        const input = await requireInternalRequest(request, env.CONTROL_GATEWAY_TOKEN);
        if (input.gate !== "gateway") return Response.json({ error: "wrong gate" }, { status: 400 });
        return Response.json(await dispatchGate(env.GATES, input));
      }
      if (url.pathname === "/internal/handles") {
        return await bindHandle(request, env);
      }
      const target = mcpTarget(url.pathname);
      if (target !== null) {
        if (request.method !== "POST") return mcpMethodNotAllowed();
        const presentedKey = bearer(request);
        if (presentedKey === undefined || presentedKey === "") return invalidAngelKey();
        const { angelId, environment } = target;
        // An unknown handle answers exactly like a wrong key — same status and
        // body — so a 404 never confirms which handles exist. Accepted
        // residual risk: the unknown-handle path returns after one directory
        // read while a known handle also snapshots the gate runtime, so a
        // timing channel remains (as on the legacy route's account segment).
        let accountId: string | null;
        if (target.coordinate) {
          accountId = await resolveHandleOnly(env, target.accountSegment);
        } else {
          let accountSegment: string;
          try {
            accountSegment = decodeURIComponent(target.accountSegment);
          } catch {
            return Response.json({ error: "malformed account segment encoding" }, { status: 400 });
          }
          accountId = await resolveAccountSegment(env, accountSegment);
        }
        if (accountId === null) return invalidAngelKey();
        const runtimeId = `${accountId}:${angelId}:${environment}`;
        const runtime = env.GATES.getByName(runtimeId);
        const state = await runtime.snapshot("gateway");
        if (!await authenticatedAgainstActiveKeys(presentedKey, state)) return invalidAngelKey();
        let rawMessage: unknown;
        try {
          rawMessage = await request.json();
        } catch {
          return Response.json(mcpError(null, -32700, "Parse error"), { status: 400 });
        }
        let message;
        try {
          message = parseMcpRequest(rawMessage);
          validateMcpPost(request, message.method !== "initialize");
        } catch (error) {
          if (error instanceof McpRequestError) {
            return Response.json(mcpError(requestId(rawMessage), error.code, error.message), { status: 400 });
          }
          if (error instanceof McpTransportError) {
            return Response.json(mcpError(requestId(rawMessage), -32600, error.message), { status: error.status });
          }
          throw error;
        }
        if (message.method === "notifications/initialized") return mcpAccepted();
        if (message.method === "initialize") {
          return Response.json(mcpResult(message.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "AngelMCP", version: "0.1.0" },
          }));
        }
        if (message.method === "tools/list") {
          const tools = mcpToolDefinitions(availableRuntimeTools(state));
          return Response.json(mcpResult(message.id, { tools }));
        }
        const outcome = await executeTool(
          env,
          { accountId, angelId, environment },
          presentedKey,
          message.params.name,
          message.params.arguments,
        );
        if (outcome.status !== 200) {
          const denial = outcome.payload as {
            requestId?: string;
            reason?: string;
            denied?: string;
            error?: string;
            mismatch?: unknown;
            gateway?: AgentSafeGateReceipt;
            broker?: {
              evaluation?: {
                reason?: string;
                receipt?: AgentSafeGateReceipt;
              };
            };
          };
          if (outcome.status === 409 && denial.error === "gate receipt mismatch") {
            return Response.json(mcpError(
              message.id,
              -32603,
              "Angel gates failed to converge",
              outcome.payload,
            ), { status: 500 });
          }
          if (outcome.status !== 401 && denial.requestId !== undefined && denial.gateway !== undefined) {
            const brokerReceipt = denial.broker?.evaluation?.receipt;
            const detail = denial.denied ?? brokerReceipt?.detail;
            if (detail !== undefined) {
              return Response.json(mcpToolDenied(message.id, {
                requestId: denial.requestId,
                reason: denial.reason ?? denial.broker?.evaluation?.reason ?? "broker_denied",
                detail,
                gateway: denial.gateway,
                ...(brokerReceipt === undefined ? {} : { broker: brokerReceipt }),
              }));
            }
          }
          return Response.json(mcpError(
            message.id,
            outcome.status === 401 ? -32001 : -32003,
            denial.denied ?? denial.error ?? "Angel denied the tool call",
            outcome.payload,
          ), { status: outcome.status });
        }
        const payload = outcome.payload as InvocationPayload;
        return Response.json(mcpResult(message.id, {
          content: [{ type: "text", text: JSON.stringify(payload.result) }],
          structuredContent: payload.result,
          _meta: {
            requestId: payload.requestId,
            gateway: payload.gateway,
            broker: payload.broker,
          },
        }), { headers: outcome.headers });
      }

      return Response.json({ error: "not found" }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}

interface RuntimeIdentity {
  accountId: string;
  angelId: string;
  environment: string;
}

interface McpTarget {
  /** Raw account path segment: a handle on the coordinate, id-or-handle on the legacy route. */
  accountSegment: string;
  angelId: string;
  environment: HostedEnvironment;
  /** True for the PD 0001 `/@handle/angel[@preview]` shape. */
  coordinate: boolean;
}

/**
 * Parse an MCP request path. Two shapes answer:
 *
 * - The PD 0001 coordinate `/@{handle}/{angel}` (production — bare means
 *   production) and `/@{handle}/{angel}@preview`. The suffix alternation is
 *   closed: `latest`, `production`, `staging`, and anything else unknown are
 *   404s, and pinned `@N` Version addresses are reserved in the grammar but
 *   deferred, so they 404 too — before any handle resolution, which keeps the
 *   response independent of whether the handle exists.
 * - The legacy `/v1/a/{account}/{angel}/{environment}/mcp` route, serving
 *   through the cutover. Its `staging` segment is the legacy spelling of
 *   `preview`.
 */
function mcpTarget(pathname: string): McpTarget | null {
  const coordinate = /^\/@([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)(?:@([a-z0-9-]+))?$/.exec(pathname);
  if (coordinate !== null) {
    const [, handle, angelId, suffix] = coordinate;
    if (suffix !== undefined && suffix !== "preview") return null;
    return {
      accountSegment: handle!,
      angelId: angelId!,
      environment: suffix === "preview" ? "preview" : "production",
      coordinate: true,
    };
  }
  const legacy = /^\/v1\/a\/([^/]+)\/([^/]+)\/(staging|preview|production)\/mcp$/.exec(pathname);
  if (legacy !== null) {
    return {
      accountSegment: legacy[1]!,
      angelId: legacy[2]!,
      environment: canonicalEnvironment(legacy[3]!)!,
      coordinate: false,
    };
  }
  return null;
}

/**
 * Resolve a coordinate's account segment, which is only ever a handle. The
 * route grammar already guarantees the handle shape; a segment outside the
 * claimable pattern (too short, too long) can never be claimed, so it fails
 * like an unknown handle without probing the directory.
 */
async function resolveHandleOnly(env: GatewayEnv, handle: string): Promise<string | null> {
  if (!ACCOUNT_HANDLE_PATTERN.test(handle)) return null;
  return env.HANDLES.getByName(HANDLE_DIRECTORY_INSTANCE).resolve(handle);
}

/** Control pushes handle claims here; the token is the existing control role. */
async function bindHandle(request: Request, env: GatewayEnv): Promise<Response> {
  await requireBearerToken(request, env.CONTROL_GATEWAY_TOKEN, "unauthorized internal request");
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "internal request must be an object");
  }
  const handle = (body as { handle?: unknown }).handle;
  const accountId = (body as { accountId?: unknown }).accountId;
  if (typeof handle !== "string" || handle === "" || typeof accountId !== "string" || accountId === "") {
    throw new HttpError(400, "handle and accountId are required");
  }
  // Defense in depth against a misbehaving Control: an unclaimable name must
  // never become a replica storage key (Durable Object keys cap at 2 KiB).
  if (!ACCOUNT_HANDLE_PATTERN.test(handle)) {
    throw new HttpError(400, "handle is outside the claimable pattern");
  }
  const outcome = await env.HANDLES.getByName(HANDLE_DIRECTORY_INSTANCE).bind(handle, accountId);
  if (outcome === "conflict") {
    return Response.json({ error: "handle is bound to another Account" }, { status: 409 });
  }
  return Response.json({ handle, accountId });
}

/**
 * Resolve the account path segment. Internal `acct_*` ids pass through
 * untouched — checked positively, not just by grammar exclusion, so a
 * misconfigured id can never be silently reclassified as a handle. A
 * handle-shaped segment — current or retired — resolves to its Account and is
 * answered directly, with no redirect (PD 0004).
 */
async function resolveAccountSegment(env: GatewayEnv, segment: string): Promise<string | null> {
  if (isInternalAccountId(segment) || !ACCOUNT_HANDLE_GRAMMAR.test(segment)) return segment;
  // Handle-shaped but past the claimable pattern (the cap, or under the
  // floor): it can never be claimed, and probing the directory would build an
  // over-long Durable Object storage key that errors as a distinguishable 500.
  if (!ACCOUNT_HANDLE_PATTERN.test(segment)) return null;
  return env.HANDLES.getByName(HANDLE_DIRECTORY_INSTANCE).resolve(segment);
}

interface InvocationPayload {
  requestId: string;
  result: unknown;
  gateway: AgentSafeGateReceipt;
  broker: AgentSafeGateReceipt;
}

async function executeTool(
  env: GatewayEnv,
  identity: RuntimeIdentity,
  presentedKey: string | undefined,
  tool: string,
  argumentsValue: Record<string, unknown>,
): Promise<{ status: number; payload: unknown; headers?: HeadersInit }> {
  const runtimeId = `${identity.accountId}:${identity.angelId}:${identity.environment}`;
  const requestId = crypto.randomUUID();
  const input = { requestId, presentedKey, tool, arguments: argumentsValue };
  const gateway = env.GATES.getByName(runtimeId);
  const gate2 = JSON.parse(await gateway.evaluateJson("gateway", input)) as GateEvaluation;
  if (!gate2.allowed) {
    const status = gate2.reason === "unauthorized" ? 401 : 403;
    return {
      status,
      payload: {
        requestId,
        reason: gate2.reason,
        denied: gate2.receipt.detail,
        gateway: agentSafeGateReceipt(gate2.receipt),
      },
    };
  }
  const brokerResponse = await env.BROKER.fetch("https://broker.internal/internal/invoke", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GATEWAY_BROKER_INVOKE_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      runtimeId,
      input: {
        requestId,
        tool: gate2.receipt.tool,
        connectionRef: gate2.receipt.connectionRef ?? undefined,
        arguments: gate2.effectiveArguments,
      },
      expected: gateReceiptIdentity(gate2.receipt),
    }),
  });
  const broker = await brokerResponse.json() as {
    error?: string;
    mismatch?: unknown;
    evaluation?: { allowed: boolean; receipt: GateEvaluation["receipt"] };
    result?: unknown;
  };
  if (!brokerResponse.ok) {
    return {
      status: brokerResponse.status,
      payload: {
        requestId,
        gateway: agentSafeGateReceipt(gate2.receipt),
        broker: agentSafeBrokerPayload(broker),
        ...(broker.error === undefined ? {} : { error: broker.error }),
        ...(broker.error === "gate receipt mismatch"
          ? { mismatch: broker.mismatch }
          : {}),
      },
    };
  }
  if (broker.evaluation === undefined) throw new Error("successful Broker response is missing a gate evaluation");
  const receiptMismatch = gateReceiptMismatch(
    gateReceiptIdentity(gate2.receipt),
    broker.evaluation.receipt,
  );
  if (receiptMismatch !== null) {
    return {
      status: 409,
      payload: {
        error: "gate receipt mismatch",
        mismatch: receiptMismatch,
        requestId,
        gateway: agentSafeGateReceipt(gate2.receipt),
        broker: agentSafeBrokerPayload(broker),
      },
    };
  }
  return {
    status: 200,
    payload: {
      requestId,
      result: broker.result,
      gateway: agentSafeGateReceipt(gate2.receipt),
      broker: agentSafeGateReceipt(broker.evaluation.receipt),
    },
    headers: {
      "x-angel-policy-digest": gate2.receipt.policyDigest,
      "x-angel-version": String(gate2.receipt.version),
    },
  };
}

function agentSafeBrokerPayload(broker: {
  error?: string;
  mismatch?: unknown;
  evaluation?: { allowed: boolean; reason?: string; receipt: GateEvaluation["receipt"] };
  result?: unknown;
}) {
  if (broker.evaluation === undefined) return broker;
  return {
    ...broker,
    // Curated pick, never a spread: an allowed evaluation also carries the
    // sealed execution block (origin + request template), which is Broker
    // internals, not agent-facing data.
    evaluation: {
      allowed: broker.evaluation.allowed,
      ...(broker.evaluation.reason === undefined ? {} : { reason: broker.evaluation.reason }),
      receipt: agentSafeGateReceipt(broker.evaluation.receipt),
    },
  };
}

function bearer(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
}

/**
 * Accept any ACTIVE named gateway key. The set lives in `gatewayKeyHashes`; a
 * pre-named-keys snapshot has only the legacy single hash, so fall back to it.
 * A revoked key is absent from the set and therefore rejected.
 */
async function authenticatedAgainstActiveKeys(
  presentedKey: string,
  state: { gatewayKeyHashes?: unknown; gatewayKeyHash?: unknown },
): Promise<boolean> {
  if (presentedKey === "") return false;
  const hashes = Array.isArray(state.gatewayKeyHashes) && state.gatewayKeyHashes.length > 0
    ? state.gatewayKeyHashes
    : (typeof state.gatewayKeyHash === "string" && state.gatewayKeyHash !== "" ? [state.gatewayKeyHash] : []);
  if (hashes.length === 0) return false;
  const presentedHash = await sha256Hex(presentedKey);
  let matched = false;
  for (const hash of hashes) {
    if (typeof hash === "string" && hash !== "" && await timingSafeEqualText(presentedHash, hash)) {
      matched = true;
    }
  }
  return matched;
}

function invalidAngelKey(): Response {
  return Response.json(mcpError(null, -32001, "invalid Angel key"), { status: 401 });
}

function requestId(value: unknown): string | number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}
