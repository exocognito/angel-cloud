// Publish-time adapter validation for a received v2 artifact. The publisher
// never trusts client-compiled adapter data: every request template, provider
// pin, consent set, and requirement tool list must equal what the reviewed
// registry derives. This is the check that makes "policy accepts what the
// runtime cannot execute" impossible — an operation with no reviewed template
// cannot publish.
//
// The content is attacker-supplied JSON, so every keyed lookup goes through
// Object.hasOwn — prototype-chain names (constructor, __proto__) must reject
// cleanly, never pass a truthy check or die on an incidental TypeError.

import type { HostedVersionContent } from "./domain";
import type { DerivedAdapter } from "./adapter-derive";
import { selectRequiredScopes } from "./adapter-derive";
import { GENERATED_ADAPTERS } from "./adapters.generated";
import { canonicalJson } from "./canonical-json";

export function validateArtifactAdapters(content: HostedVersionContent): void {
  if (content.format !== "angel.version.v2") {
    throw new Error(`unsupported artifact format: ${String(content.format)}`);
  }
  if (content.providers === null || typeof content.providers !== "object" || Array.isArray(content.providers)) {
    throw new Error("artifact providers must be an object");
  }
  if (!Array.isArray(content.tools)) throw new Error("artifact tools must be an array");
  if (!Array.isArray(content.bindingRequirements)) {
    throw new Error("artifact bindingRequirements must be an array");
  }
  for (const tool of content.tools) {
    if (tool === null || typeof tool !== "object") throw new Error("artifact tool must be an object");
  }
  const usedProviders = new Set(content.tools.map((tool) => tool.provider));

  for (const [provider, pinned] of Object.entries(content.providers)) {
    if (pinned === null || typeof pinned !== "object") {
      throw new Error(`providers entry ${provider} must be an object`);
    }
    const adapter = registryAdapter(provider);
    if (!usedProviders.has(provider)) throw new Error(`provider ${provider} is not used by any tool`);
    if (pinned.adapter !== adapter.adapter) {
      throw new Error(`unsupported adapter version for ${provider}: ${pinned.adapter}`);
    }
    if (pinned.origin !== adapter.origin) {
      throw new Error(`unapproved origin for ${provider}: ${pinned.origin}`);
    }
    if (pinned.sourceDigest !== adapter.sourceDigest) {
      throw new Error(`sourceDigest for ${provider} does not match the reviewed spec`);
    }
  }
  for (const provider of usedProviders) {
    registryAdapter(provider);
    if (!Object.hasOwn(content.providers, provider)) {
      throw new Error(`tool provider ${provider} has no providers entry`);
    }
  }

  // Tool identity: the compiler emits name === operation and forbids
  // case-folded collisions — a received artifact must satisfy the same rules.
  const foldedNames = new Set<string>();
  for (const tool of content.tools) {
    if (tool.name !== tool.operation) {
      throw new Error(`tool name ${tool.name} must equal its operation ${tool.operation}`);
    }
    const folded = tool.name.toUpperCase();
    if (foldedNames.has(folded)) throw new Error(`duplicate tool: ${tool.name}`);
    foldedNames.add(folded);
    const adapter = registryAdapter(tool.provider);
    const contract = Object.hasOwn(adapter.operations, tool.operation)
      ? adapter.operations[tool.operation]
      : undefined;
    if (!contract) {
      throw new Error(`operation ${tool.operation} is not in the reviewed ${tool.provider} spec`);
    }
    // Structural comparison — a normalizing hop (jsonb, proxies) may reorder
    // keys of a perfectly valid request.
    if (canonicalJson(tool.request) !== canonicalJson(contract.request)) {
      throw new Error(`tool ${tool.name} request does not match the reviewed spec template`);
    }
  }

  // Requirement tool lists are the consent inputs — reconcile them exactly
  // with the artifact's tools, or a padded list escalates requiredScopes past
  // what the artifact's real tools justify.
  const artifactTools = new Map(content.tools.map((tool) => [tool.name, tool.provider]));
  const claimedBy = new Map<string, string>();
  const requirementIds = new Set<string>();
  for (const requirement of content.bindingRequirements) {
    if (requirement === null || typeof requirement !== "object" || !Array.isArray(requirement.tools)) {
      throw new Error("artifact requirement must be an object with a tools array");
    }
    if (requirement.id === "") throw new Error("requirement id must be non-empty");
    if (requirementIds.has(requirement.id)) {
      throw new Error(`duplicate requirement id: ${requirement.id}`);
    }
    requirementIds.add(requirement.id);
    const adapter = registryAdapter(requirement.provider);
    if (requirement.credential !== adapter.credential) {
      throw new Error(`requirement ${requirement.id} credential does not match the ${requirement.provider} adapter`);
    }
    if (requirement.tools.length === 0) {
      throw new Error(`requirement ${requirement.id} lists no tools`);
    }
    for (const toolName of requirement.tools) {
      // has(), not get()-truthiness — an empty-string id must still count as
      // a claim, or one tool can belong to two requirements.
      if (claimedBy.has(toolName)) {
        throw new Error(`tool ${toolName} is claimed by requirements ${claimedBy.get(toolName)} and ${requirement.id}`);
      }
      claimedBy.set(toolName, requirement.id);
      if (artifactTools.get(toolName) !== requirement.provider) {
        throw new Error(
          `requirement ${requirement.id} lists tool ${toolName} the artifact does not contain for ${requirement.provider}`,
        );
      }
    }
    const expected = selectRequiredScopes({
      tools: requirement.tools,
      operations: adapter.operations,
      scopeRanking: adapter.scopeRanking,
    });
    if (JSON.stringify(requirement.requiredScopes) !== JSON.stringify(expected)) {
      throw new Error(
        `requirement ${requirement.id} requiredScopes do not match the spec-derived consent`,
      );
    }
  }
  for (const toolName of artifactTools.keys()) {
    if (!claimedBy.has(toolName)) {
      throw new Error(`tool ${toolName} has no binding requirement`);
    }
  }
}

function registryAdapter(provider: string): DerivedAdapter {
  if (!Object.hasOwn(GENERATED_ADAPTERS, provider)) {
    throw new Error(`unknown provider namespace: ${provider}`);
  }
  return GENERATED_ADAPTERS[provider]!;
}
