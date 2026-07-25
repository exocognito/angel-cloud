import { describe, expect, test } from "bun:test";
import { compileHostedAngel, type HostedVersionContent } from "../src/domain";
import { validateArtifactAdapters } from "../src/artifact-validate";

async function compiled(): Promise<HostedVersionContent> {
  const { canonicalSource, digest, ...content } = await compileHostedAngel(`
name: proof
charter: Read mail and one doc.
tools:
  - tool: gmail.users.messages.list
  - tool: docs.documents.get
`);
  return structuredClone(content);
}

describe("publish-time adapter validation", () => {
  test("accepts a faithfully compiled artifact", async () => {
    const content = await compiled();
    expect(() => validateArtifactAdapters(content)).not.toThrow();
  });

  test("rejects a tampered request template", async () => {
    const content = await compiled();
    const gmailTool = content.tools.find((tool) => tool.provider === "gmail")!;
    gmailTool.request = { ...gmailTool.request, method: "DELETE" };
    expect(() => validateArtifactAdapters(content)).toThrow(/request .* reviewed spec/);
  });

  test("rejects an unapproved provider origin", async () => {
    const content = await compiled();
    content.providers.gmail!.origin = "https://evil.example";
    expect(() => validateArtifactAdapters(content)).toThrow(/origin/);
  });

  test("rejects an unsupported adapter version", async () => {
    const content = await compiled();
    content.providers.gmail!.adapter = "google-discovery@999";
    expect(() => validateArtifactAdapters(content)).toThrow(/adapter/);
  });

  test("rejects a stale source digest", async () => {
    const content = await compiled();
    content.providers.docs!.sourceDigest = `sha256:${"0".repeat(64)}`;
    expect(() => validateArtifactAdapters(content)).toThrow(/sourceDigest/);
  });

  test("rejects an operation the reviewed spec does not contain", async () => {
    const content = await compiled();
    const gmailTool = content.tools.find((tool) => tool.provider === "gmail")!;
    gmailTool.operation = "gmail.users.messages.delete";
    gmailTool.name = "gmail.users.messages.delete";
    expect(() => validateArtifactAdapters(content)).toThrow(/gmail.users.messages.delete/);
  });

  test("rejects a scope set that disagrees with the spec-derived consent", async () => {
    const content = await compiled();
    content.bindingRequirements.find((r) => r.provider === "gmail")!.requiredScopes = [
      "https://mail.google.com/",
    ];
    expect(() => validateArtifactAdapters(content)).toThrow(/scope/i);
  });

  test("rejects a provider entry no tool uses", async () => {
    const content = await compiled();
    content.tools = content.tools.filter((tool) => tool.provider !== "docs");
    content.bindingRequirements = content.bindingRequirements.filter((r) => r.provider !== "docs");
    expect(() => validateArtifactAdapters(content)).toThrow(/docs/);
  });

  test("rejects a requirement listing a tool the artifact does not contain", async () => {
    // Padding the requirement's tool list escalates requiredScopes past what
    // the artifact's actual tools justify — the consent-escalation tamper.
    const content = await compiled();
    const gmailReq = content.bindingRequirements.find((r) => r.provider === "gmail")!;
    gmailReq.tools = [...gmailReq.tools, "gmail.users.drafts.create"].sort();
    gmailReq.requiredScopes = ["https://www.googleapis.com/auth/gmail.modify"];
    expect(() => validateArtifactAdapters(content)).toThrow(/tool/);
  });

  test("rejects an artifact whose tools have no binding requirement", async () => {
    const content = await compiled();
    content.bindingRequirements = [];
    expect(() => validateArtifactAdapters(content)).toThrow(/requirement/);
  });

  test("rejects a tool claimed by two requirements", async () => {
    const content = await compiled();
    const gmailReq = content.bindingRequirements.find((r) => r.provider === "gmail")!;
    content.bindingRequirements.push({ ...gmailReq, id: `${gmailReq.id}-dup` });
    expect(() => validateArtifactAdapters(content)).toThrow(/requirement/);
  });

  test("cleanly rejects prototype-chain provider names from untrusted JSON", async () => {
    const content = await compiled();
    content.tools.push({
      name: "constructor.x",
      provider: "constructor",
      operation: "constructor.x",
      argGuards: [],
      request: content.tools[0]!.request,
    });
    expect(() => validateArtifactAdapters(content)).toThrow(/unknown provider/);
  });
});
