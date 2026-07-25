import { parse as parseYaml } from "yaml";
import { sha256Hex } from "./crypto";
import type { ArgGuard } from "./types";
import type { HttpRequestTemplate } from "./adapter-derive";
import { selectRequiredScopes } from "./adapter-derive";
import { GENERATED_ADAPTERS } from "./adapters.generated";

export type DeploymentEnvironment = "staging" | "production";
export type CredentialKind = "google_oauth" | "service_token" | "bot_token" | "bridge_token";

// The only request kind today. Future non-HTTP adapter kinds (mcp, local)
// extend this union together with a format bump — the gates never read it.
export type ToolRequest = HttpRequestTemplate;

export interface HostedTool {
  name: string;
  provider: string;
  operation: string;
  argGuards: ArgGuard[];
  request: ToolRequest;
}

export interface HostedProvider {
  adapter: string;
  origin: string;
  sourceDigest: string;
}

export interface AngelVersionChild {
  name: string;
  digest: string;
}

export interface ProviderBindingRequirement {
  id: string;
  source: string;
  provider: string;
  credential: CredentialKind;
  requiredScopes: string[];
  tools: string[];
}

export interface HostedVersionContent {
  format: "angel.version.v2";
  name: string;
  charter: string;
  children: AngelVersionChild[];
  providers: Record<string, HostedProvider>;
  bindingRequirements: ProviderBindingRequirement[];
  tools: HostedTool[];
}

export interface HostedVersionArtifact extends HostedVersionContent {
  canonicalSource: string;
  digest: string;
}

export interface CompileHostedAngelOptions {
  loadAngel?: (name: string) => string | undefined | Promise<string | undefined>;
}

const ADAPTERS = GENERATED_ADAPTERS;

export async function compileHostedAngel(
  raw: string,
  options: CompileHostedAngelOptions = {},
): Promise<HostedVersionArtifact> {
  return compileSource(raw, options, []);
}

async function compileSource(
  raw: string,
  options: CompileHostedAngelOptions,
  ancestors: string[],
): Promise<HostedVersionArtifact> {
  const root = object(parseYaml(raw), "ANGEL.yaml");
  const name = angelName(root.name, "name");
  const charter = root.charter === undefined ? "" : text(root.charter, "charter").trim();
  const hasTools = root.tools !== undefined;
  const hasAngels = root.angels !== undefined;
  if (hasTools === hasAngels) {
    throw new Error("ANGEL.yaml must set exactly one of tools or angels");
  }
  if (hasTools) {
    exactKeys(root, ["name", "charter", "tools"], "ANGEL.yaml");
    const tools = directTools(root.tools);
    return artifact({
      format: "angel.version.v2",
      name,
      charter,
      children: [],
      providers: providersFor(tools),
      bindingRequirements: requirementsFor(name, tools),
      tools,
    });
  }

  exactKeys(root, ["name", "charter", "angels"], "ANGEL.yaml");
  if (ancestors.includes(name)) {
    throw new Error(`Angel composition cycle: ${[...ancestors, name].join(" -> ")}`);
  }
  if (!options.loadAngel) throw new Error(`composite Angel ${name} needs a local Angel resolver`);
  const childNames = localAngelNames(root.angels);
  const childArtifacts = await Promise.all(childNames.map(async (childName) => {
    const childRaw = await options.loadAngel!(childName);
    if (childRaw === undefined) throw new Error(`local Angel not found: ${childName}`);
    const child = await compileSource(childRaw, options, [...ancestors, name]);
    if (child.name !== childName) {
      throw new Error(`local Angel ${childName} declares name ${child.name}`);
    }
    return child;
  }));
  const tools = flattenTools(childArtifacts);
  const bindingRequirements = rebaseComposedRequirements(
    childArtifacts.flatMap((child) => child.bindingRequirements),
  );
  return artifact({
    format: "angel.version.v2",
    name,
    charter,
    children: childArtifacts
      .map((child) => ({ name: child.name, digest: child.digest }))
      .sort(byName),
    providers: providersFor(tools),
    bindingRequirements,
    tools,
  });
}

async function artifact(content: HostedVersionContent): Promise<HostedVersionArtifact> {
  const canonicalSource = JSON.stringify(content);
  return { ...content, canonicalSource, digest: await sha256Hex(canonicalSource) };
}

function directTools(value: unknown): HostedTool[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("tools must be a non-empty list");
  const seen = new Map<string, string>();
  const tools = value.map((entry, index) => sourceTool(entry, `tools[${index}]`));
  for (const tool of tools) {
    const folded = tool.name.toUpperCase();
    const prior = seen.get(folded);
    if (prior) throw new Error(`duplicate tool: ${prior} and ${tool.name}`);
    seen.set(folded, tool.name);
  }
  return tools.sort(byName);
}

function localAngelNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("angels must be a non-empty list");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const name = angelName(entry, `angels[${index}]`);
    if (seen.has(name)) throw new Error(`duplicate local Angel: ${name}`);
    seen.add(name);
    return name;
  });
}

function flattenTools(children: HostedVersionArtifact[]): HostedTool[] {
  const seen = new Map<string, string>();
  const tools = children.flatMap((child) => child.tools);
  for (const tool of tools) {
    const folded = tool.name.toUpperCase();
    const prior = seen.get(folded);
    if (prior) throw new Error(`composed tool collision: ${prior} and ${tool.name}`);
    seen.set(folded, tool.name);
  }
  return tools.sort(byName);
}

function sourceTool(value: unknown, at: string): HostedTool {
  let operation: string;
  let argGuards: ArgGuard[] = [];
  if (typeof value === "string") {
    operation = text(value, at);
  } else {
    const tool = object(value, at);
    exactKeys(tool, ["tool", "argGuards"], at);
    operation = text(tool.tool, `${at}.tool`);
    if (tool.argGuards !== undefined) argGuards = guards(tool.argGuards, `${at}.argGuards`);
  }

  const provider = operation.split(".", 1)[0]!;
  // hasOwn, not truthiness: "constructor" and friends resolve up the
  // prototype chain to truthy junk and would crash later instead of rejecting.
  const adapter = Object.hasOwn(ADAPTERS, provider) ? ADAPTERS[provider] : undefined;
  if (!adapter) throw new Error(`unknown provider namespace: ${provider}`);
  const contract = adapter.operations[operation];
  if (!contract) {
    throw new Error(`operation ${operation} is not in the ${provider} adapter`);
  }
  return { name: operation, provider, operation, argGuards, request: contract.request };
}

function providersFor(tools: HostedTool[]): Record<string, HostedProvider> {
  const providers: Record<string, HostedProvider> = {};
  for (const provider of [...new Set(tools.map((tool) => tool.provider))].sort(codeUnitCompare)) {
    const adapter = ADAPTERS[provider]!;
    providers[provider] = {
      adapter: adapter.adapter,
      origin: adapter.origin,
      sourceDigest: adapter.sourceDigest,
    };
  }
  return providers;
}

function requirementsFor(source: string, tools: HostedTool[]): ProviderBindingRequirement[] {
  const byProvider = new Map<string, HostedTool[]>();
  for (const tool of tools) {
    const existing = byProvider.get(tool.provider) ?? [];
    existing.push(tool);
    byProvider.set(tool.provider, existing);
  }
  return [...byProvider.entries()].map(([provider, providerTools]) => {
    const adapter = ADAPTERS[provider]!;
    const toolNames = providerTools.map((tool) => tool.name).sort(codeUnitCompare);
    return {
      id: provider,
      source,
      provider,
      credential: adapter.credential,
      requiredScopes: selectRequiredScopes({
        tools: toolNames,
        operations: adapter.operations,
        scopeRanking: adapter.scopeRanking,
      }),
      tools: toolNames,
    };
  }).sort(compareRequirement);
}

function rebaseComposedRequirements(
  requirements: ProviderBindingRequirement[],
): ProviderBindingRequirement[] {
  const providersBySource = new Map<string, Set<string>>();
  for (const requirement of requirements) {
    const providers = providersBySource.get(requirement.source) ?? new Set<string>();
    providers.add(requirement.provider);
    providersBySource.set(requirement.source, providers);
  }
  const seenIds = new Set<string>();
  return requirements.map((requirement) => {
    const providers = providersBySource.get(requirement.source)!;
    const id = providers.size === 1
      ? requirement.source
      : `${requirement.source}:${requirement.provider}`;
    if (seenIds.has(id)) throw new Error(`composed binding requirement collision: ${id}`);
    seenIds.add(id);
    return { ...requirement, id };
  }).sort(compareRequirement);
}

function guards(value: unknown, at: string): ArgGuard[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${at} must be a non-empty list`);
  const seen = new Set<string>();
  const parsed = value.map((entry, index): ArgGuard => {
    const guard = object(entry, `${at}[${index}]`);
    exactKeys(guard, ["field", "forbiddenValues", "forbid", "pin"], `${at}[${index}]`);
    const field = text(guard.field, `${at}[${index}].field`).normalize("NFC");
    if (field === "angel_connection") throw new Error("angel_connection is reserved by Angel Cloud");
    if (seen.has(field)) throw new Error(`${at} has duplicate field: ${field}`);
    seen.add(field);
    const kinds = ["forbiddenValues", "forbid", "pin"].filter((key) => guard[key] !== undefined);
    if (kinds.length !== 1) throw new Error(`${at}[${index}] must set exactly one guard kind`);
    if (guard.forbid !== undefined) {
      if (guard.forbid !== true) throw new Error(`${at}[${index}].forbid must be true`);
      return { field, forbid: true };
    }
    if (guard.pin !== undefined) return { field, pin: text(guard.pin, `${at}[${index}].pin`) };
    if (!Array.isArray(guard.forbiddenValues) || guard.forbiddenValues.length === 0) {
      throw new Error(`${at}[${index}].forbiddenValues must be a non-empty list`);
    }
    const forbiddenValues = [...new Set(guard.forbiddenValues.map((item) => text(item, at).normalize("NFC").toUpperCase()))]
      .sort(codeUnitCompare);
    return { field, forbiddenValues };
  });
  return parsed.sort((left, right) => codeUnitCompare(left.field, right.field));
}

function angelName(value: unknown, at: string): string {
  const name = text(value, at);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`${at} must be a lowercase slug: ${name}`);
  return name;
}

function object(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${at} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${at} must be a non-empty string`);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], at: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${at} has unknown key: ${unknown.join(", ")}`);
}

function compareRequirement(left: ProviderBindingRequirement, right: ProviderBindingRequirement): number {
  return codeUnitCompare(left.id, right.id);
}

function byName<T extends { name: string }>(left: T, right: T): number {
  return codeUnitCompare(left.name, right.name);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
