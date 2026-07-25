import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { deriveAdapter, selectRequiredScopes } from "../src/adapter-derive";

const adaptersDir = join(import.meta.dir, "..", "adapters");
const gmail = {
  provider: "gmail",
  adapterYaml: readFileSync(join(adaptersDir, "gmail", "adapter.yaml"), "utf8"),
  specYaml: readFileSync(join(adaptersDir, "gmail", "openapi.angel.yaml"), "utf8"),
};

describe("adapter derivation", () => {
  test("derives an http request template for every spec operation", async () => {
    const derived = await deriveAdapter(gmail);

    expect(derived.adapter).toBe("google-discovery@1");
    expect(derived.credential).toBe("google_oauth");
    expect(derived.origin).toBe("https://gmail.googleapis.com");
    expect(derived.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(derived.operations)).toHaveLength(21);

    expect(derived.operations["gmail.users.messages.list"]!.request).toEqual({
      kind: "http",
      method: "GET",
      pathTemplate: "/gmail/v1/users/{userId}/messages",
      pathParams: ["userId"],
      pathDefaults: { userId: "me" },
      queryParams: ["includeSpamTrash", "labelIds", "maxResults", "pageToken", "q"],
      hasBody: false,
    });
    expect(derived.operations["gmail.users.drafts.create"]!.request).toEqual({
      kind: "http",
      method: "POST",
      pathTemplate: "/gmail/v1/users/{userId}/drafts",
      pathParams: ["userId"],
      pathDefaults: { userId: "me" },
      queryParams: [],
      hasBody: true,
    });
  });

  test("rejects an adapter origin that differs from the spec servers origin", async () => {
    const adapterYaml = gmail.adapterYaml.replace(
      "origin: https://gmail.googleapis.com",
      "origin: https://evil.example",
    );
    await expect(deriveAdapter({ ...gmail, adapterYaml })).rejects.toThrow(/origin/);
  });

  test("rejects a server URL carrying a base path the templates would lose", async () => {
    const specYaml = gmail.specYaml.replace(
      "url: https://gmail.googleapis.com",
      "url: https://gmail.googleapis.com/v2",
    );
    await expect(deriveAdapter({ ...gmail, specYaml })).rejects.toThrow(/base path|pathname/);
  });

  test("derives the same sourceDigest for LF and CRLF copies of a spec", async () => {
    const lf = await deriveAdapter(gmail);
    const crlf = await deriveAdapter({ ...gmail, specYaml: gmail.specYaml.replace(/\n/g, "\r\n") });
    expect(crlf.sourceDigest).toBe(lf.sourceDigest);
  });

  test("rejects an operation whose security shape is not a single oauth2 entry", async () => {
    const specYaml = `
openapi: 3.0.3
info: { title: t, version: v1 }
servers:
  - url: https://gmail.googleapis.com
paths:
  /v1/things:
    get:
      operationId: gmail.things.list
`;
    await expect(deriveAdapter({ ...gmail, specYaml })).rejects.toThrow(/security/);
  });
});

describe("required scope selection", () => {
  const operations = {
    "gmail.users.messages.list": {
      scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify"],
    },
    "gmail.users.drafts.create": {
      scopes: ["https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/gmail.modify"],
    },
  };
  const ranking = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
  ];

  test("prefers the fewest scopes, then the narrowest ranking", () => {
    // One scope (modify) covers both tools, so it beats readonly+compose.
    expect(selectRequiredScopes({
      tools: Object.keys(operations),
      operations,
      scopeRanking: ranking,
    })).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);

    // For the read-only subset the narrowest single cover wins.
    expect(selectRequiredScopes({
      tools: ["gmail.users.messages.list"],
      operations,
      scopeRanking: ranking,
    })).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
  });

  test("fails when no ranked scope covers a tool", () => {
    expect(() => selectRequiredScopes({
      tools: ["gmail.users.messages.list"],
      operations,
      scopeRanking: ["https://www.googleapis.com/auth/gmail.compose"],
    })).toThrow(/gmail.users.messages.list/);
  });
});
