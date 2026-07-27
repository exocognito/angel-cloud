import type { DeploymentEnvironment } from "../domain";
import type {
  GateAvailability,
  GateAvailabilityCommand,
  GateInstallCommand,
  GateInstallation,
  GateKind,
  GateReceipt,
  PolicyGateState,
} from "../gate";
import type { GateFleet } from "../control";
import type { GateInternalRequest } from "./protocol";

interface ServiceFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ServiceGateFleetInput {
  accountId: string;
  angelId: string;
  gatewayControlToken: string;
  brokerControlToken: string;
  gateway: ServiceFetcher;
  broker: ServiceFetcher;
}

export class ServiceGateFleet implements GateFleet {
  constructor(private readonly input: ServiceGateFleetInput) {}

  async reset(gate: GateKind, environment: DeploymentEnvironment): Promise<void> {
    await this.request(gate, environment, { operation: "reset" });
  }

  install(gate: GateKind, command: GateInstallCommand): Promise<GateInstallation> {
    return this.request(gate, command.environment, { operation: "install", command });
  }

  change(
    gate: GateKind,
    environment: DeploymentEnvironment,
    command: GateAvailabilityCommand,
  ): Promise<GateAvailability> {
    return this.request(gate, environment, { operation: "availability", command });
  }

  reconcileKeys(
    gate: GateKind,
    environment: DeploymentEnvironment,
    hashes: string[],
  ): Promise<string[]> {
    return this.request(gate, environment, { operation: "reconcile_keys", hashes });
  }

  snapshot(gate: GateKind, environment: DeploymentEnvironment): Promise<PolicyGateState> {
    return this.request(gate, environment, { operation: "snapshot" });
  }

  async activity(gate: GateKind, environment: DeploymentEnvironment): Promise<GateReceipt[]> {
    return (await this.snapshot(gate, environment)).receipts;
  }

  private async request<T>(
    gate: GateKind,
    environment: DeploymentEnvironment,
    operation:
      | { operation: "reset" }
      | { operation: "install"; command: GateInstallCommand }
      | { operation: "availability"; command: GateAvailabilityCommand }
      | { operation: "reconcile_keys"; hashes: string[] }
      | { operation: "snapshot" },
  ): Promise<T> {
    const input = {
      ...operation,
      gate,
      runtimeId: `${this.input.accountId}:${this.input.angelId}:${environment}`,
    } satisfies GateInternalRequest;
    const response = await this.input[gate].fetch("https://gate.internal/internal/gate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${gate === "gateway"
          ? this.input.gatewayControlToken
          : this.input.brokerControlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const message = isRecord(body) && typeof body.error === "string"
        ? body.error
        : `gate request failed with ${response.status}`;
      throw new Error(message);
    }
    return body as T;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
