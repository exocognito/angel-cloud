import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compileHostedAngel,
  type HostedVersionArtifact,
} from "./domain";
import type {
  ManagementConnection,
  ManagementEnvironmentView,
} from "./management-contract";
import {
  canonicalJson,
  ManagementClient,
  type FetchLike,
} from "@smcllns/angel-core";
import {
  buildPortableAngel,
  type PortableBuildResult,
} from "@smcllns/angel-core/build";
import {
  loadAngelDeploymentConfig,
  runAngelCommand,
  type AngelDeploymentConfig,
  cloudflareAccessHeaders,
} from "@smcllns/angel-core/cli";
import { MCP_PROTOCOL_VERSION } from "./mcp";

const GMAIL_TOOL = "gmail.users.messages.list";

export interface GoldenAngelInput extends PortableBuildResult {
  config: AngelDeploymentConfig;
}

export type GoldenDeploymentConfigLoader = (
  repoRoot: string,
  angelId: string,
) => AngelDeploymentConfig;

export interface GoldenListedTool {
  name: string;
  inputSchema: {
    properties: {
      angel_connection: {
        oneOf: Array<{ const: string; title: string }>;
      };
    };
    required?: string[];
  };
  _meta: {
    "angelmcp.dev/connections": Array<{
      ref: string;
      provider: string;
      identity: string;
    }>;
  };
}

export interface GoldenJourneyOptions {
  repoRoot: string;
  controlBaseUrl: string;
  gatewayBaseUrl: string;
  managementToken: string;
  adminToken: string;
  accessToken: string;
  fetch?: FetchLike;
  loadDeploymentConfig?: GoldenDeploymentConfigLoader;
}

export function goldenOptionsFromEnv(
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): GoldenJourneyOptions {
  return {
    repoRoot,
    controlBaseUrl: requiredEnvironment(env, "GOLDEN_CONTROL_URL"),
    gatewayBaseUrl: requiredEnvironment(env, "GOLDEN_GATEWAY_URL"),
    managementToken: requiredEnvironment(env, "GOLDEN_MANAGEMENT_TOKEN"),
    adminToken: requiredEnvironment(env, "GOLDEN_ADMIN_TOKEN"),
    accessToken: requiredEnvironment(env, "GOLDEN_ACCESS_TOKEN"),
  };
}

export interface GoldenJourneyReport {
  accountId: string;
  /** The Account handle the coordinate ran under. */
  handle: string;
  angels: {
    gmailInboxZero: {
      slug: "gmail-inbox-zero";
      version: 1;
      digest: string;
      toolCount: 21;
      productionKeyFingerprint: string;
    };
    goldenAssistant: {
      slug: "golden-assistant";
      versions: [1, 2];
      versionToolCounts: [4, 5];
      digests: [string, string];
      productionKeyFingerprint: string;
      gmailConnectionRefs: string[];
    };
  };
  checks: {
    builtFromCheckedInFiles: true;
    exactPreviewPromoted: true;
    coordinateAnswersMcp: true;
    legacyRouteStillAnswers: true;
    authenticatedDiscovery: true;
    canonicalRepeatedTool: true;
    eachConnectionInvokedSeparately: true;
    noImplicitFanout: true;
    oneConnectionPausedIndependently: true;
    pauseAllThenResumeOne: true;
    stableProductionKey: true;
    bothGateReceiptsMatch: true;
    wrongAccountDenied: true;
  };
  trace: string[];
}

export async function loadGoldenAngelInput(
  repoRoot: string,
  angelId: "gmail-inbox-zero" | "golden-assistant",
  loadConfig: GoldenDeploymentConfigLoader = (root, id) => loadAngelDeploymentConfig({
    repoRoot: root,
    angelId: id,
  }),
): Promise<GoldenAngelInput> {
  const built = await buildPortableAngel({ repoRoot, angelId });
  const config = loadConfig(repoRoot, angelId);
  if (config.angel !== built.artifact.name) {
    throw new Error(`angel.json Angel ${config.angel} does not match ${built.artifact.name}`);
  }
  return { ...built, config };
}

export async function buildGoldenAssistantVersion(
  repoRoot: string,
  version: 1 | 2,
): Promise<HostedVersionArtifact> {
  const root = readFileSync(
    join(repoRoot, "angels/golden-assistant/ANGEL.yaml"),
    "utf8",
  );
  return compileHostedAngel(root, {
    loadAngel: (name) => readLocalAngel(
      repoRoot,
      name,
      version === 2 && name === "gmail-read-and-draft" ? "ANGEL.v2.yaml" : "ANGEL.yaml",
    ),
  });
}

export async function runGoldenJourney(
  options: GoldenJourneyOptions,
): Promise<GoldenJourneyReport> {
  const fetch = options.fetch ?? globalThis.fetch;
  const controlBaseUrl = origin(options.controlBaseUrl, "controlBaseUrl");
  const gatewayBaseUrl = origin(options.gatewayBaseUrl, "gatewayBaseUrl");
  const trace: string[] = [];
  const loadConfig = options.loadDeploymentConfig ?? ((repoRoot, angelId) => loadAngelDeploymentConfig({
    repoRoot,
    angelId,
  }));
  const inboxConfig = loadConfig(options.repoRoot, "gmail-inbox-zero");
  const assistantConfig = loadConfig(options.repoRoot, "golden-assistant");
  for (const config of [inboxConfig, assistantConfig]) {
    if (origin(config.target, "angel.json target") !== controlBaseUrl) {
      throw new Error(`angel.json target ${config.target} does not match ${controlBaseUrl}`);
    }
  }

  const resetHeaders = new Headers(bearerJson(options.adminToken));
  const resetAccessHeaders = cloudflareAccessHeaders(options.accessToken);
  resetHeaders.set("CF-Access-Client-ID", resetAccessHeaders["CF-Access-Client-ID"]);
  resetHeaders.set("CF-Access-Client-Secret", resetAccessHeaders["CF-Access-Client-Secret"]);
  const reset = await requestJson<{ schema: string; angels: unknown[] }>(
    fetch,
    `${controlBaseUrl}/api/demo/reset`,
    {
      method: "POST",
      headers: resetHeaders,
      body: JSON.stringify({}),
    },
  );
  if (reset.schema !== "angelmcp.demo.v4" || reset.angels.length !== 0) {
    throw new Error("golden reset did not produce an empty v4 Account");
  }
  trace.push("control:reset:management");

  // The PD 0001 coordinate needs the Account's handle. Reuse an existing
  // claim; claim the deterministic demo handle only when none exists, so the
  // journey can never spend PD 0004's one rename on a live Account.
  const handle = await ensureAccountHandle(fetch, controlBaseUrl, options, assistantConfig.account, "golden-demo");
  trace.push(`account:handle:@${handle}`);

  const client = new ManagementClient({
    target: controlBaseUrl,
    token: options.managementToken,
    accessToken: options.accessToken,
    fetch,
  });
  const inboxPublished = await cliPublish(
    "gmail-inbox-zero",
    options,
    fetch,
  );
  assertToolCount(inboxPublished.artifact, 21, "gmail-inbox-zero");
  trace.push(
    "gmail-inbox-zero:build:ANGEL.yaml",
    "gmail-inbox-zero:read:angel.json",
    "gmail-inbox-zero:ensure",
    "gmail-inbox-zero:publish:v1",
    "gmail-inbox-zero:deploy:preview:v1",
  );
  await cliDeployProduction("gmail-inbox-zero", options, fetch);
  trace.push("gmail-inbox-zero:promote:production:v1");
  const inboxAngel = await client.getAngel(inboxConfig.account, inboxConfig.angel);
  const inboxProduction = await client.getEnvironment(inboxAngel.id, "production");
  assertActiveVersion(inboxProduction, inboxPublished.artifact.digest, "Gmail Inbox Zero v1");

  const assistantPublished = await cliPublish(
    "golden-assistant",
    options,
    fetch,
  );
  assertToolCount(assistantPublished.artifact, 4, "golden-assistant v1");
  trace.push(
    "golden-assistant:build:ANGEL.yaml",
    "golden-assistant:read:angel.json",
    "golden-assistant:ensure",
    "golden-assistant:publish:v1",
    "golden-assistant:deploy:preview:v1",
  );
  await cliDeployProduction("golden-assistant", options, fetch);
  trace.push("golden-assistant:promote:production:v1");
  const assistantAngel = await client.getAngel(assistantConfig.account, assistantConfig.angel);
  const assistantProductionV1 = await client.getEnvironment(assistantAngel.id, "production");
  assertActiveVersion(
    assistantProductionV1,
    assistantPublished.artifact.digest,
    "Golden Assistant v1",
  );
  const productionKey = assistantPublished.productionKey;
  if (productionKey === undefined) {
    throw new Error("CLI did not return the shown-once Golden Assistant production key");
  }
  // Production is the bare coordinate: no environment in the URL (PD 0001).
  const mcpUrl = `${gatewayBaseUrl}/@${handle}/${assistantConfig.angel}`;
  await initializeMcpHttp(fetch, mcpUrl, productionKey);
  const listed = await listMcpToolsHttp(fetch, mcpUrl, productionKey);
  trace.push("golden-assistant:tools/list:production");
  // The pre-coordinate route keeps answering through the cutover.
  const legacyMcpUrl = `${gatewayBaseUrl}/v1/a/${assistantConfig.account}/${assistantConfig.angel}/production/mcp`;
  await initializeMcpHttp(fetch, legacyMcpUrl, productionKey);
  const legacyListed = await listMcpToolsHttp(fetch, legacyMcpUrl, productionKey);
  if (canonicalJson(legacyListed.map(({ name }) => name).sort())
    !== canonicalJson(listed.map(({ name }) => name).sort())) {
    throw new Error("the legacy MCP route no longer matches the coordinate");
  }
  trace.push("golden-assistant:tools/list:legacy-route");
  const gmail = onlyTool(listed, GMAIL_TOOL);
  const connections = await client.listConnections(assistantConfig.account);
  const personal = connectionByNickname(connections, "personal-google");
  const work = connectionByNickname(connections, "work-google");
  const choices = toolChoices(gmail);
  if (choices.length !== 2 || !toolRequiresConnection(gmail)) {
    throw new Error("one canonical Gmail tool must require one of two opaque Connections");
  }
  const personalChoice = connectionChoice(choices, personal.identityLabel);
  const workChoice = connectionChoice(choices, work.identityLabel);
  assertDiscoveryPrivate(gmail);

  const omitted = await callMcpToolHttp(fetch, mcpUrl, productionKey, GMAIL_TOOL, {});
  if (omitted.allowed || omitted.reason !== "connection_required") {
    throw new Error("omitting angel_connection must fail instead of fan out");
  }
  const personalCall = await callMcpToolHttp(fetch, mcpUrl, productionKey, GMAIL_TOOL, {
    angel_connection: personalChoice.ref,
  });
  const workCall = await callMcpToolHttp(fetch, mcpUrl, productionKey, GMAIL_TOOL, {
    angel_connection: workChoice.ref,
  });
  assertAllowedMcp(personalCall, personalChoice.ref, "personal");
  assertAllowedMcp(workCall, workChoice.ref, "work");
  trace.push(
    `golden-assistant:call:${GMAIL_TOOL}:connection:1`,
    `golden-assistant:call:${GMAIL_TOOL}:connection:2`,
  );

  await demoAction(fetch, controlBaseUrl, options.accessToken, {
    angelId: assistantConfig.angel,
    action: "pause_tool",
    environment: "production",
    tool: GMAIL_TOOL,
    connectionId: work.id,
  });
  trace.push(`golden-assistant:pause:${GMAIL_TOOL}:connection:2`);
  const pausedWork = await callMcpToolHttp(fetch, mcpUrl, productionKey, GMAIL_TOOL, {
    angel_connection: workChoice.ref,
  });
  const livePersonal = await callMcpToolHttp(fetch, mcpUrl, productionKey, GMAIL_TOOL, {
    angel_connection: personalChoice.ref,
  });
  if (pausedWork.allowed || pausedWork.reason !== "connection_paused" || !livePersonal.allowed) {
    throw new Error("www tuple pause did not isolate one Gmail Connection");
  }

  await demoAction(fetch, controlBaseUrl, options.accessToken, {
    angelId: assistantConfig.angel,
    action: "pause_all",
    environment: "production",
  });
  trace.push("golden-assistant:pause:all");
  await demoAction(fetch, controlBaseUrl, options.accessToken, {
    angelId: assistantConfig.angel,
    action: "resume_tool",
    environment: "production",
    tool: GMAIL_TOOL,
    connectionId: personal.id,
  });
  trace.push(`golden-assistant:resume:${GMAIL_TOOL}:connection:1`);
  const oneResumed = toolChoices(onlyTool(
    await listMcpToolsHttp(fetch, mcpUrl, productionKey),
    GMAIL_TOOL,
  ));
  if (oneResumed.length !== 1 || oneResumed[0]?.ref !== personalChoice.ref) {
    throw new Error("Pause all then resume one exposed the wrong Connection set");
  }
  await demoAction(fetch, controlBaseUrl, options.accessToken, {
    angelId: assistantConfig.angel,
    action: "resume_all",
    environment: "production",
  });
  trace.push("golden-assistant:resume:all");

  const v2Artifact = await buildGoldenAssistantVersion(options.repoRoot, 2);
  assertToolCount(v2Artifact, 5, "golden-assistant v2");
  await cliPublish("golden-assistant", options, fetch, async () => ({
    artifact: v2Artifact,
    outDir: "<in-memory-checked-in-v2-build>",
  }));
  trace.push(
    "golden-assistant:build:ANGEL.v2.yaml",
    "golden-assistant:publish:v2",
    "golden-assistant:deploy:preview:v2",
  );
  const previewV2 = await client.getEnvironment(assistantAngel.id, "preview");
  const stagedV2 = previewV2.activeDeployment;
  if (stagedV2 === null || stagedV2.digest !== v2Artifact.digest) {
    throw new Error("CLI did not stage the checked-in v2 artifact");
  }
  await demoAction(fetch, controlBaseUrl, options.accessToken, {
    angelId: assistantConfig.angel,
    action: "promote",
    environment: "production",
    stagedDeploymentId: stagedV2.id,
    expectedDigest: stagedV2.digest,
    bindings: stagedV2.bindings,
  });
  trace.push("golden-assistant:promote:production:v2");
  const productionV2 = await client.getEnvironment(assistantAngel.id, "production");
  assertActiveVersion(productionV2, v2Artifact.digest, "Golden Assistant v2");
  if (productionV2.keyFingerprint !== assistantProductionV1.keyFingerprint) {
    throw new Error("production Angel key changed across v2 promotion");
  }
  const listedV2 = await listMcpToolsHttp(fetch, mcpUrl, productionKey);
  const labels = onlyTool(listedV2, "gmail.users.labels.list");
  const labelChoice = connectionChoice(toolChoices(labels), personal.identityLabel);
  const labelCall = await callMcpToolHttp(
    fetch,
    mcpUrl,
    productionKey,
    "gmail.users.labels.list",
    { angel_connection: labelChoice.ref },
  );
  assertAllowedMcp(labelCall, labelChoice.ref);
  trace.push("golden-assistant:call:gmail.users.labels.list:v2");

  const finalView = await requestJson<{ schema: string; angels: Array<{ id: string }> }>(
    fetch,
    `${controlBaseUrl}/api/demo/state`,
    { headers: cloudflareAccessHeaders(options.accessToken) },
  );
  if (
    finalView.schema !== "angelmcp.demo.v4"
    || canonicalJson(finalView.angels.map(({ id }) => id).sort()) !== canonicalJson([
      "gmail-inbox-zero",
      "golden-assistant",
    ])
  ) {
    throw new Error("www state did not project both CLI-published Angels");
  }
  const wrongAccount = await fetch(`${controlBaseUrl}/v1/accounts/acct_wrong/connections`, {
    headers: {
      authorization: `Bearer ${options.managementToken}`,
      ...cloudflareAccessHeaders(options.accessToken),
    },
  });
  if (wrongAccount.status !== 404) throw new Error("wrong Account was not tenant-safe denied");
  trace.push("account-isolation:wrong-account-denied");

  return {
    accountId: assistantConfig.account,
    handle,
    angels: {
      gmailInboxZero: {
        slug: "gmail-inbox-zero",
        version: 1,
        digest: inboxPublished.artifact.digest,
        toolCount: 21,
        productionKeyFingerprint: inboxProduction.keyFingerprint,
      },
      goldenAssistant: {
        slug: "golden-assistant",
        versions: [1, 2],
        versionToolCounts: [4, 5],
        digests: [assistantPublished.artifact.digest, v2Artifact.digest],
        productionKeyFingerprint: productionV2.keyFingerprint,
        gmailConnectionRefs: [personalChoice.ref, workChoice.ref],
      },
    },
    checks: {
      builtFromCheckedInFiles: true,
      exactPreviewPromoted: true,
      coordinateAnswersMcp: true,
      legacyRouteStillAnswers: true,
      authenticatedDiscovery: true,
      canonicalRepeatedTool: true,
      eachConnectionInvokedSeparately: true,
      noImplicitFanout: true,
      oneConnectionPausedIndependently: true,
      pauseAllThenResumeOne: true,
      stableProductionKey: true,
      bothGateReceiptsMatch: true,
      wrongAccountDenied: true,
    },
    trace,
  };
}

interface CliPublishResult {
  artifact: HostedVersionArtifact;
  productionKey: string | undefined;
}

interface SafeReceipt {
  deploymentId: string;
  version: number;
  policyDigest: string;
  availabilityDigest: string;
  tool: string;
  connectionRef: string | null;
  decision: "allow" | "deny";
}

type HttpMcpCall =
  | {
      allowed: true;
      result: Record<string, unknown>;
      gateway: SafeReceipt;
      broker: SafeReceipt;
    }
  | {
      allowed: false;
      reason: string;
      gateway: SafeReceipt;
      broker: SafeReceipt | null;
    };

async function cliPublish(
  angelId: "gmail-inbox-zero" | "golden-assistant",
  options: GoldenJourneyOptions,
  fetch: FetchLike,
  buildOverride?: () => Promise<PortableBuildResult>,
): Promise<CliPublishResult> {
  let artifact: HostedVersionArtifact | undefined;
  const output: string[] = [];
  // Core 0.3.0's bare `publish` one-step deploys to production; the journey
  // exercises the publish -> preview -> promote path, so target preview.
  await runAngelCommand(["publish", angelId, "--preview"], {
    repoRoot: options.repoRoot,
    fetch,
    build: async (input) => {
      const result = buildOverride === undefined
        ? await buildPortableAngel(input)
        : await buildOverride();
      artifact = result.artifact;
      return result;
    },
    loadDeploymentConfig: options.loadDeploymentConfig === undefined
      ? undefined
      : ({ repoRoot, angelId: id }) => options.loadDeploymentConfig!(repoRoot, id),
    output: (line) => output.push(line),
    env: {
      ANGEL_MANAGEMENT_TOKEN: options.managementToken,
      ANGEL_ACCESS_TOKEN: options.accessToken,
    },
  });
  if (artifact === undefined) throw new Error(`CLI did not build ${angelId}`);
  return {
    artifact,
    productionKey: output
      .find((line) => line.startsWith("production key: "))
      ?.slice("production key: ".length),
  };
}

async function cliDeployProduction(
  angelId: "gmail-inbox-zero" | "golden-assistant",
  options: GoldenJourneyOptions,
  fetch: FetchLike,
): Promise<void> {
  await runAngelCommand(["deploy", angelId, "--prod"], {
    repoRoot: options.repoRoot,
    fetch,
    loadDeploymentConfig: options.loadDeploymentConfig === undefined
      ? undefined
      : ({ repoRoot, angelId: id }) => options.loadDeploymentConfig!(repoRoot, id),
    output: () => {},
    env: {
      ANGEL_MANAGEMENT_TOKEN: options.managementToken,
      ANGEL_ACCESS_TOKEN: options.accessToken,
    },
  });
}

function assertToolCount(artifact: HostedVersionArtifact, expected: number, label: string): void {
  if (artifact.tools.length !== expected) {
    throw new Error(`${label} compiled ${artifact.tools.length} tools instead of ${expected}`);
  }
}

function assertActiveVersion(
  environment: ManagementEnvironmentView,
  expectedDigest: string,
  label: string,
): void {
  if (environment.activeDeployment?.digest !== expectedDigest) {
    throw new Error(`${label} is not the active deployment`);
  }
}

function origin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS origin`);
  }
  if (
    url.protocol !== "https:"
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || url.username !== ""
    || url.password !== ""
  ) {
    throw new Error(`${label} must be an HTTPS origin`);
  }
  return url.origin;
}

async function initializeMcpHttp(fetch: FetchLike, url: string, key: string): Promise<void> {
  const initialized = await requestJson<{
    result?: { protocolVersion?: unknown; serverInfo?: { name?: unknown } };
  }>(fetch, url, {
    method: "POST",
    headers: mcpHeaders(key, false),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "golden-initialize",
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "angelmcp-golden", version: "0.1.0" },
      },
    }),
  });
  if (
    initialized.result?.protocolVersion !== MCP_PROTOCOL_VERSION
    || initialized.result.serverInfo?.name !== "AngelMCP"
  ) {
    throw new Error("MCP initialize did not negotiate AngelMCP 2025-06-18");
  }
  const notification = await fetch(url, {
    method: "POST",
    headers: mcpHeaders(key, true),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  if (notification.status !== 202 || await notification.text() !== "") {
    throw new Error("MCP initialized notification failed");
  }
}

async function listMcpToolsHttp(
  fetch: FetchLike,
  url: string,
  key: string,
): Promise<GoldenListedTool[]> {
  const payload = await requestJson<{ result?: { tools?: unknown } }>(fetch, url, {
    method: "POST",
    headers: mcpHeaders(key, true),
    body: JSON.stringify({ jsonrpc: "2.0", id: "golden-tools", method: "tools/list" }),
  });
  if (!Array.isArray(payload.result?.tools)) throw new Error("MCP tools/list returned no tool list");
  return payload.result.tools as GoldenListedTool[];
}

async function callMcpToolHttp(
  fetch: FetchLike,
  url: string,
  key: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<HttpMcpCall> {
  const payload = await requestJson<{
    result?: {
      isError?: unknown;
      structuredContent?: unknown;
      _meta?: { gateway?: unknown; broker?: unknown };
    };
  }>(fetch, url, {
    method: "POST",
    headers: mcpHeaders(key, true),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `golden-call-${tool}`,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const result = payload.result;
  if (result === undefined || result._meta === undefined) {
    throw new Error(`MCP call ${tool} returned no result metadata`);
  }
  const gateway = safeReceipt(result._meta.gateway, "Gateway");
  const broker = result._meta.broker === null
    ? null
    : safeReceipt(result._meta.broker, "Broker");
  if (result.isError === true) {
    const structured = recordValue(result.structuredContent, "MCP denial");
    const denial = recordValue(structured.denial, "MCP denial detail");
    if (typeof denial.reason !== "string") throw new Error("MCP denial has no reason");
    return { allowed: false, reason: denial.reason, gateway, broker };
  }
  if (broker === null) throw new Error("allowed MCP call did not reach Broker");
  return {
    allowed: true,
    result: recordValue(result.structuredContent, "MCP structured result"),
    gateway,
    broker,
  };
}

function safeReceipt(value: unknown, label: string): SafeReceipt {
  const receipt = recordValue(value, `${label} receipt`);
  for (const field of [
    "deploymentId",
    "policyDigest",
    "availabilityDigest",
    "tool",
    "decision",
  ]) {
    if (typeof receipt[field] !== "string") throw new Error(`${label} receipt ${field} is invalid`);
  }
  if (!Number.isInteger(receipt.version)) throw new Error(`${label} receipt version is invalid`);
  if (receipt.connectionRef !== null && typeof receipt.connectionRef !== "string") {
    throw new Error(`${label} receipt connectionRef is invalid`);
  }
  if (receipt.decision !== "allow" && receipt.decision !== "deny") {
    throw new Error(`${label} receipt decision is invalid`);
  }
  return receipt as unknown as SafeReceipt;
}

function onlyTool(tools: GoldenListedTool[], name: string): GoldenListedTool {
  const matches = tools.filter((tool) => tool.name === name);
  if (matches.length !== 1) throw new Error(`expected exactly one canonical tool ${name}`);
  return matches[0]!;
}

function toolChoices(tool: GoldenListedTool) {
  return tool._meta["angelmcp.dev/connections"];
}

function toolRequiresConnection(tool: GoldenListedTool): boolean {
  return tool.inputSchema.required?.includes("angel_connection") ?? false;
}

function assertDiscoveryPrivate(tool: GoldenListedTool): void {
  const serialized = JSON.stringify(tool);
  if (
    serialized.includes("personal-google")
    || serialized.includes("work-google")
    || serialized.includes("con_personal_google")
    || serialized.includes("con_work_google")
  ) {
    throw new Error("agent discovery leaked management Connection data");
  }
}

function assertAllowedMcp(call: HttpMcpCall, expectedRef: string, expectedMailbox?: string): void {
  if (!call.allowed) throw new Error(`expected allowed MCP call, received ${call.reason}`);
  const identity = (receipt: SafeReceipt) => ({
    deploymentId: receipt.deploymentId,
    version: receipt.version,
    policyDigest: receipt.policyDigest,
    availabilityDigest: receipt.availabilityDigest,
    tool: receipt.tool,
    connectionRef: receipt.connectionRef,
  });
  if (canonicalJson(identity(call.gateway)) !== canonicalJson(identity(call.broker))) {
    throw new Error("Gateway and Broker receipts do not match");
  }
  if (
    call.gateway.connectionRef !== expectedRef
    || call.broker.connectionRef !== expectedRef
    || (expectedMailbox !== undefined && call.result.mailbox !== expectedMailbox)
  ) {
    throw new Error("MCP call did not use the selected Connection");
  }
}

/**
 * The Account's current handle, claiming `fallbackHandle` only when none is
 * claimed yet. An existing claim — whatever its name — is reused untouched:
 * PD 0004 allows one rename ever, and an acceptance run must never spend it.
 */
async function ensureAccountHandle(
  fetch: FetchLike,
  controlBaseUrl: string,
  options: GoldenJourneyOptions,
  accountId: string,
  fallbackHandle: string,
): Promise<string> {
  const headers = new Headers(bearerJson(options.managementToken));
  const access = cloudflareAccessHeaders(options.accessToken);
  headers.set("CF-Access-Client-ID", access["CF-Access-Client-ID"]);
  headers.set("CF-Access-Client-Secret", access["CF-Access-Client-Secret"]);
  const handleUrl = `${controlBaseUrl}/v1/accounts/${encodeURIComponent(accountId)}/handle`;
  const current = await fetch(handleUrl, { headers });
  if (current.status === 200) {
    const record = recordValue(await current.json(), "account handle");
    if (typeof record.handle !== "string" || record.handle === "") {
      throw new Error("account handle response is missing the handle");
    }
    return record.handle;
  }
  if (current.status !== 404) {
    throw new Error(`GET account handle failed (${current.status})`);
  }
  const claimed = await requestJson<{ handle: string }>(fetch, handleUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({ handle: fallbackHandle }),
  });
  return claimed.handle;
}

async function demoAction(
  fetch: FetchLike,
  controlBaseUrl: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<void> {
  await requestJson(fetch, `${controlBaseUrl}/api/demo/action`, {
    method: "POST",
    headers: {
      ...cloudflareAccessHeaders(accessToken),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function mcpHeaders(key: string, subsequent: boolean): Headers {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  });
  if (subsequent) headers.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
  return headers;
}

function bearerJson(token: string): Headers {
  return new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });
}

async function requestJson<T>(
  fetch: FetchLike,
  input: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${init?.method ?? "GET"} ${new URL(input).pathname} returned non-JSON`);
  }
  if (!response.ok) {
    const error = typeof value === "object" && value !== null && "error" in value
      ? String((value as { error: unknown }).error)
      : text;
    throw new Error(`${init?.method ?? "GET"} ${new URL(input).pathname} failed (${response.status}): ${error}`);
  }
  return value as T;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function connectionByNickname(
  connections: readonly ManagementConnection[],
  nickname: string,
): ManagementConnection {
  const connection = connections.find((candidate) => candidate.nickname === nickname);
  if (connection === undefined) throw new Error(`Connection ${nickname} was not found`);
  return connection;
}

function connectionChoice(
  choices: readonly { ref: string; identity: string }[],
  identityLabel: string,
): { ref: string; identity: string } {
  const choice = choices.find(({ identity }) => identity === identityLabel);
  if (choice === undefined) throw new Error(`runtime Connection for ${identityLabel} was not found`);
  return choice;
}

function readLocalAngel(repoRoot: string, name: string, file: string): string | undefined {
  try {
    return readFileSync(join(repoRoot, "angels", name, file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
