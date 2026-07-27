import { describe, expect, test } from "bun:test";
import { compileHostedAngel } from "../../src/domain";
import {
  PolicyGate,
  availableRuntimeTools,
  createPolicyGateState,
  type GateToolBinding,
} from "../../src/gate";
import { sha256Hex } from "@smcllns/angel-core";

const source = `
name: golden-research-assistant
tools:
  - tool: gmail.users.messages.list
    argGuards:
      - field: maxResults
        pin: "5"
  - tool: docs.documents.get
    argGuards:
      - field: documentId
        pin: doc_golden_1
`;

const gmailTool = "gmail.users.messages.list";
const docsTool = "docs.documents.get";
const bindings: GateToolBinding[] = [
  {
    tool: gmailTool,
    connectionRef: "arc_personal",
    connectionId: "con_personal",
    provider: "gmail",
    identityLabel: "sam@example.com",
  },
  {
    tool: gmailTool,
    connectionRef: "arc_work",
    connectionId: "con_work",
    provider: "gmail",
    identityLabel: "sam@work.example",
  },
  {
    tool: docsTool,
    connectionRef: "arc_personal",
    connectionId: "con_personal",
    provider: "docs",
    identityLabel: "sam@example.com",
  },
];

describe("authenticated runtime Connection selection", () => {
  test("requires a selector for repeated Connections, strips it, and records the chosen opaque ref", async () => {
    const key = "ak_runtime_selector";
    const gate = new PolicyGate(createPolicyGateState("gateway"));
    const artifact = await compileHostedAngel(source);
    await gate.install({
      accountId: "acct_personal",
      angelId: artifact.name,
      environment: "production",
      deploymentId: "dep_selector_v1",
      version: 1,
      artifact,
      bindings,
      gatewayKeyHash: await sha256Hex(key),
    });

    expect(await gate.evaluate({
      requestId: "req_missing",
      presentedKey: key,
      tool: gmailTool,
      arguments: {},
    })).toMatchObject({ allowed: false, reason: "connection_required" });

    const allowed = await gate.evaluate({
      requestId: "req_work",
      presentedKey: key,
      tool: gmailTool,
      arguments: { angel_connection: "arc_work" },
    });
    expect(allowed).toMatchObject({
      allowed: true,
      reason: "allowed",
      effectiveArguments: { maxResults: "5" },
      receipt: {
        tool: gmailTool,
        connectionRef: "arc_work",
        connectionId: "con_work",
        connectionIdentityLabel: "sam@work.example",
      },
    });
  });

  test("rejects duplicate tuples, ref collisions, and provider mismatches at install", async () => {
    const artifact = await compileHostedAngel(source);
    const command = (candidateBindings: GateToolBinding[]) => ({
      accountId: "acct_personal",
      angelId: artifact.name,
      environment: "production" as const,
      deploymentId: "dep_invalid_binding",
      version: 1,
      artifact,
      bindings: candidateBindings,
    });

    await expect(new PolicyGate(createPolicyGateState("broker")).install(command([
      ...bindings,
      { ...bindings[0]! },
    ]))).rejects.toThrow(/duplicate tool Connection binding/);

    await expect(new PolicyGate(createPolicyGateState("broker")).install(command(
      bindings.map((binding) => binding.tool === docsTool
        ? { ...binding, connectionId: "con_collision" }
        : binding),
    ))).rejects.toThrow(/Connection ref collision/);

    await expect(new PolicyGate(createPolicyGateState("broker")).install(command(
      bindings.map((binding) => binding.tool === docsTool
        ? { ...binding, provider: "gmail" }
        : binding),
    ))).rejects.toThrow(/binding provider does not match/);
  });

  test("defaults one eligible Connection and rejects unknown or ineligible refs", async () => {
    const gate = new PolicyGate(createPolicyGateState("broker"));
    const artifact = await compileHostedAngel(source);
    await gate.install({
      accountId: "acct_personal",
      angelId: artifact.name,
      environment: "production",
      deploymentId: "dep_selector_v1",
      version: 1,
      artifact,
      bindings,
    });

    expect(await gate.evaluate({
      requestId: "req_docs_default",
      tool: docsTool,
      arguments: {},
    })).toMatchObject({
      allowed: true,
      receipt: { connectionRef: "arc_personal" },
    });
    for (const [requestId, tool, connectionRef] of [
      ["req_unknown", gmailTool, "arc_stale"],
      ["req_ineligible", docsTool, "arc_work"],
    ] as const) {
      expect(await gate.evaluate({
        requestId,
        tool,
        connectionRef,
        arguments: {},
      })).toMatchObject({ allowed: false, reason: "connection_unavailable" });
    }
  });

  test("pauses one tool/Connection tuple and can resume one after freezing all", async () => {
    const gate = new PolicyGate(createPolicyGateState("broker"));
    const artifact = await compileHostedAngel(source);
    await gate.install({
      accountId: "acct_personal",
      angelId: artifact.name,
      environment: "production",
      deploymentId: "dep_selector_v1",
      version: 1,
      artifact,
      bindings,
    });

    gate.changeAvailability({
      kind: "tool_connection",
      tool: gmailTool,
      connectionRef: "arc_work",
      enabled: false,
      expectedRevision: 0,
    });
    expect(await gate.evaluate({
      requestId: "req_paused_work",
      tool: gmailTool,
      connectionRef: "arc_work",
      arguments: {},
    })).toMatchObject({ allowed: false, reason: "connection_paused" });
    expect(await gate.evaluate({
      requestId: "req_live_personal",
      tool: gmailTool,
      connectionRef: "arc_personal",
      arguments: {},
    })).toMatchObject({ allowed: true, receipt: { connectionRef: "arc_personal" } });
    expect(availableRuntimeTools(gate.snapshot()).find(({ tool }) => tool.name === gmailTool))
      .toMatchObject({ connections: [{ ref: "arc_personal" }] });

    gate.changeAvailability({ kind: "all", enabled: false, expectedRevision: 1 });
    gate.changeAvailability({
      kind: "tool_connection",
      tool: gmailTool,
      connectionRef: "arc_work",
      enabled: true,
      expectedRevision: 2,
    });
    expect(availableRuntimeTools(gate.snapshot())).toMatchObject([{
      tool: { name: gmailTool },
      connections: [{ ref: "arc_work" }],
    }]);
  });
});
