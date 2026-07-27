import { DurableObject } from "cloudflare:workers";
import {
  PolicyGate,
  createPolicyGateState,
  type GateAvailability,
  type GateAvailabilityCommand,
  type GateEvaluation,
  type GateEvaluationInput,
  type GateInstallCommand,
  type GateInstallation,
  type GateKind,
  type PolicyGateState,
} from "../gate";

export class GateRuntime extends DurableObject {
  private tail: Promise<void> = Promise.resolve();

  async reset(gate: GateKind): Promise<void> {
    return this.exclusive(async () => {
      await this.ctx.storage.put("state", createPolicyGateState(gate));
    });
  }

  async install(gate: GateKind, command: GateInstallCommand): Promise<GateInstallation> {
    return this.exclusive(async () => {
      const policy = await this.load(gate);
      const result = await policy.install(command);
      await this.ctx.storage.put("state", policy.snapshot());
      return result;
    });
  }

  async changeAvailability(
    gate: GateKind,
    command: GateAvailabilityCommand,
  ): Promise<GateAvailability> {
    return this.exclusive(async () => {
      const policy = await this.load(gate);
      const result = policy.changeAvailability(command);
      await this.ctx.storage.put("state", policy.snapshot());
      return result;
    });
  }

  async reconcileKeys(gate: GateKind, hashes: string[]): Promise<string[]> {
    return this.exclusive(async () => {
      const policy = await this.load(gate);
      const result = policy.reconcileGatewayKeys(hashes);
      await this.ctx.storage.put("state", policy.snapshot());
      return result;
    });
  }

  async evaluate(gate: GateKind, input: GateEvaluationInput): Promise<GateEvaluation> {
    return this.exclusive(async () => {
      const policy = await this.load(gate);
      const result = await policy.evaluate(input);
      await this.ctx.storage.put("state", policy.snapshot());
      return result;
    });
  }

  async evaluateJson(gate: GateKind, input: GateEvaluationInput): Promise<string> {
    return JSON.stringify(await this.evaluate(gate, input));
  }

  async snapshot(gate: GateKind): Promise<PolicyGateState> {
    return (await this.load(gate)).snapshot();
  }

  async verify(gate: GateKind) {
    return (await this.load(gate)).verifyChain();
  }

  private async load(gate: GateKind): Promise<PolicyGate> {
    const state = await this.ctx.storage.get<PolicyGateState>("state");
    if (state && state.gate !== gate) throw new Error("gate namespace kind mismatch");
    return new PolicyGate(state ?? createPolicyGateState(gate));
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
