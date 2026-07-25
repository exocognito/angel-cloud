import { describe, expect, test } from "bun:test";
import { compileHostedAngel } from "../src/domain";
import { GENERATED_ADAPTERS } from "../src/adapters.generated";

describe("angel.version.v2 artifact", () => {
  test("seals a spec-derived http request into every tool", async () => {
    const artifact = await compileHostedAngel(`
name: mail
charter: Read bounded mail.
tools:
  - tool: gmail.users.messages.list
`);

    expect(artifact.format).toBe("angel.version.v2");
    expect(artifact.tools[0]!.request).toEqual({
      kind: "http",
      method: "GET",
      pathTemplate: "/gmail/v1/users/{userId}/messages",
      pathParams: ["userId"],
      pathDefaults: { userId: "me" },
      queryParams: ["includeSpamTrash", "labelIds", "maxResults", "pageToken", "q"],
      hasBody: false,
    });
  });

  test("pins each provider's adapter, origin, and source digest", async () => {
    const artifact = await compileHostedAngel(`
name: mixed
charter: Mail and docs.
tools:
  - tool: gmail.users.messages.list
  - tool: docs.documents.get
`);

    expect(artifact.providers).toEqual({
      docs: {
        adapter: "google-discovery@1",
        origin: "https://docs.googleapis.com",
        sourceDigest: GENERATED_ADAPTERS.docs!.sourceDigest,
      },
      gmail: {
        adapter: "google-discovery@1",
        origin: "https://gmail.googleapis.com",
        sourceDigest: GENERATED_ADAPTERS.gmail!.sourceDigest,
      },
    });
  });

  test("derives the smallest covering consent per binding requirement", async () => {
    const readOnly = await compileHostedAngel(`
name: proof
charter: Read mail and one doc.
tools:
  - tool: gmail.users.messages.list
  - tool: docs.documents.get
`);
    const byId = Object.fromEntries(readOnly.bindingRequirements.map((r) => [r.id, r.requiredScopes]));
    expect(byId).toEqual({
      docs: ["https://www.googleapis.com/auth/documents.readonly"],
      gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
    });

    const workbench = await compileHostedAngel(`
name: workbench
charter: Read and write mail.
tools:
  - tool: gmail.users.messages.list
  - tool: gmail.users.drafts.create
  - tool: gmail.users.labels.create
`);
    // Least authority: three narrow scopes beat modify alone.
    expect(workbench.bindingRequirements[0]!.requiredScopes).toEqual([
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.labels",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
  });

  test("cleanly rejects prototype-chain provider namespaces", async () => {
    for (const operation of ["constructor.x", "toString.y", "hasOwnProperty.z"]) {
      await expect(compileHostedAngel(`
name: bad
charter: x
tools:
  - tool: ${operation}
`)).rejects.toThrow(/unknown provider namespace/);
    }
  });

  test("still rejects operations outside the reviewed adapter spec", async () => {
    await expect(compileHostedAngel(`
name: bad
charter: x
tools:
  - tool: gmail.users.messages.delete
`)).rejects.toThrow(/gmail.users.messages.delete/);
  });

  test("composition carries providers and requests through flattening", async () => {
    const children: Record<string, string> = {
      "mail-read": `
name: mail-read
charter: read
tools:
  - tool: gmail.users.messages.list
`,
      "doc-read": `
name: doc-read
charter: read
tools:
  - tool: docs.documents.get
`,
    };
    const artifact = await compileHostedAngel(`
name: assistant
charter: composed
angels:
  - mail-read
  - doc-read
`, { loadAngel: (name) => children[name] });

    expect(Object.keys(artifact.providers).sort()).toEqual(["docs", "gmail"]);
    for (const tool of artifact.tools) expect(tool.request.kind).toBe("http");
  });
});
