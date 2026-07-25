// Publish-time adapter validation for a received v2 artifact. The publisher
// never trusts client-compiled adapter data: every request template, provider
// pin, and consent set must equal what the reviewed registry derives. This is
// the check that makes "policy accepts what the runtime cannot execute"
// impossible — an operation with no reviewed template cannot publish.

import type { HostedVersionContent } from "./domain";
import { selectRequiredScopes } from "./adapter-derive";
import { GENERATED_ADAPTERS } from "./adapters.generated";

export function validateArtifactAdapters(content: HostedVersionContent): void {
  const usedProviders = new Set(content.tools.map((tool) => tool.provider));

  for (const [provider, pinned] of Object.entries(content.providers)) {
    const adapter = GENERATED_ADAPTERS[provider];
    if (!adapter) throw new Error(`unknown provider namespace: ${provider}`);
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
    if (!content.providers[provider]) throw new Error(`tool provider ${provider} has no providers entry`);
  }

  for (const tool of content.tools) {
    const adapter = GENERATED_ADAPTERS[tool.provider]!;
    const contract = adapter.operations[tool.operation];
    if (!contract) {
      throw new Error(`operation ${tool.operation} is not in the reviewed ${tool.provider} spec`);
    }
    if (JSON.stringify(tool.request) !== JSON.stringify(contract.request)) {
      throw new Error(`tool ${tool.name} request does not match the reviewed spec template`);
    }
  }

  for (const requirement of content.bindingRequirements) {
    const adapter = GENERATED_ADAPTERS[requirement.provider];
    if (!adapter) throw new Error(`unknown provider namespace: ${requirement.provider}`);
    if (requirement.credential !== adapter.credential) {
      throw new Error(`requirement ${requirement.id} credential does not match the ${requirement.provider} adapter`);
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
}
