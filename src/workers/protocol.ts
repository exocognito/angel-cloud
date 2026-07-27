import type {
  GateAvailabilityCommand,
  GateInstallCommand,
  GateKind,
} from "../gate";
import { timingSafeEqualText } from "@smcllns/angel-core";

export type GateInternalRequest =
  | { operation: "reset"; gate: GateKind; runtimeId: string }
  | { operation: "install"; gate: GateKind; runtimeId: string; command: GateInstallCommand }
  | { operation: "availability"; gate: GateKind; runtimeId: string; command: GateAvailabilityCommand }
  | { operation: "reconcile_keys"; gate: GateKind; runtimeId: string; hashes: string[] }
  | { operation: "snapshot"; gate: GateKind; runtimeId: string };

export async function requireInternalRequest(request: Request, token: string): Promise<GateInternalRequest> {
  await requireBearerToken(request, token, "unauthorized internal request");
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const body: unknown = await request.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "internal request must be an object");
  }
  const operation = (body as { operation?: unknown }).operation;
  const gate = (body as { gate?: unknown }).gate;
  const runtimeId = (body as { runtimeId?: unknown }).runtimeId;
  if (!["reset", "install", "availability", "reconcile_keys", "snapshot"].includes(String(operation))) {
    throw new HttpError(400, "unknown internal operation");
  }
  if (gate !== "gateway" && gate !== "broker") throw new HttpError(400, "invalid gate kind");
  if (typeof runtimeId !== "string" || runtimeId === "") throw new HttpError(400, "runtimeId is required");
  return body as GateInternalRequest;
}

export async function requireBearerToken(
  request: Request,
  expectedToken: unknown,
  message = "unauthorized",
): Promise<void> {
  if (!isNonEmptyCredential(expectedToken)) {
    throw new HttpError(500, "configured bearer credential must be non-empty");
  }
  const authorization = request.headers.get("authorization");
  const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (presented === "") throw new HttpError(401, message);
  if (!await timingSafeEqualText(presented, expectedToken)) throw new HttpError(401, message);
}

export async function requireDistinctRoleCredentials(
  credentials: readonly unknown[],
  message: string,
): Promise<void> {
  if (!credentials.every(isNonEmptyCredential)) {
    throw new HttpError(500, message);
  }
  for (let first = 0; first < credentials.length; first += 1) {
    for (let second = first + 1; second < credentials.length; second += 1) {
      if (await timingSafeEqualText(credentials[first]!, credentials[second]!)) {
        throw new HttpError(500, message);
      }
    }
  }
}

function isNonEmptyCredential(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export async function dispatchGate(
  namespace: DurableObjectNamespace<import("./gate-object").GateRuntime>,
  input: GateInternalRequest,
): Promise<unknown> {
  const gate = namespace.getByName(input.runtimeId);
  switch (input.operation) {
    case "reset":
      await gate.reset(input.gate);
      return null;
    case "install":
      return gate.install(input.gate, input.command);
    case "availability":
      return gate.changeAvailability(input.gate, input.command);
    case "reconcile_keys":
      return gate.reconcileKeys(input.gate, input.hashes);
    case "snapshot":
      return gate.snapshot(input.gate);
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
  const message = error instanceof Error ? error.message : "internal error";
  return Response.json({ error: message }, { status: 500 });
}
