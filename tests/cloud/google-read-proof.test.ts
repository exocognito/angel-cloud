import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileHostedAngel } from "../../src/domain";
import {
  GOOGLE_READ_PROOF_OPERATIONS,
  googleReadProofOptionsFromEnv,
  runGoogleReadProofAcceptance,
  serializeGoogleReadProofReport,
} from "../../src/google-read-proof-acceptance";

const repoRoot = join(import.meta.dir, "../..");
const endpoint = "https://gateway.example/v1/a/acct_m1/google-read-proof/production/mcp";
const key = "angel-production-key";
const query = "from:proof@example.com subject:\"M1\"";
const documentId = "doc_ABC_-123";
const expectedPolicyDigest = readFileSync(
  join(repoRoot, "angels/google-read-proof/build/angel.version.sha256"),
  "utf8",
).trim();

describe("google-read-proof fixture", () => {
  test("matches the portable source and keeps both requirements on one nickname", async () => {
    const source = readFileSync(join(repoRoot, "angels/google-read-proof/ANGEL.yaml"), "utf8");
    const artifact = await compileHostedAngel(source);
    const tracked = JSON.parse(readFileSync(
      join(repoRoot, "angels/google-read-proof/build/angel.version.json"),
      "utf8",
    )) as { name: string; tools: Array<{ name: string }> };
    const example = JSON.parse(readFileSync(
      join(repoRoot, "angels/google-read-proof/angel.example.json"),
      "utf8",
    )) as { bindings: { staging: Record<string, string>; production: Record<string, string> } };

    expect(tracked).toEqual(JSON.parse(artifact.canonicalSource));
    expect(tracked.name).toBe("google-read-proof");
    expect(tracked.tools.map(({ name }) => name)).toEqual([...GOOGLE_READ_PROOF_OPERATIONS].sort());
    expect(example.bindings.staging).toEqual({ docs: "proof-google", gmail: "proof-google" });
    expect(example.bindings.production).toEqual({ docs: "proof-google", gmail: "proof-google" });
  });
});

describe("credentialed google-read-proof acceptance", () => {
  test("requires the exact full production MCP endpoint and four non-empty inputs", () => {
    expect(() => googleReadProofOptionsFromEnv({}, expectedPolicyDigest)).toThrow("GOLDEN_GATEWAY_URL is required");
    expect(() => googleReadProofOptionsFromEnv({
      GOLDEN_GATEWAY_URL: "https://gateway.example",
      GOLDEN_ANGEL_KEY: key,
      GOLDEN_GMAIL_QUERY: query,
      GOLDEN_DOC_ID: documentId,
    }, expectedPolicyDigest)).toThrow(/google-read-proof production MCP endpoint/);
    expect(() => googleReadProofOptionsFromEnv({
      GOLDEN_GATEWAY_URL: `${endpoint}?bad=1`,
      GOLDEN_ANGEL_KEY: key,
      GOLDEN_GMAIL_QUERY: query,
      GOLDEN_DOC_ID: documentId,
    }, expectedPolicyDigest)).toThrow(/google-read-proof production MCP endpoint/);
    expect(() => googleReadProofOptionsFromEnv({
      GOLDEN_GATEWAY_URL: "https://gateway.example/v1/a/acct_m1/another-angel/production/mcp",
      GOLDEN_ANGEL_KEY: key,
      GOLDEN_GMAIL_QUERY: query,
      GOLDEN_DOC_ID: documentId,
    }, expectedPolicyDigest)).toThrow(/google-read-proof production MCP endpoint/);
    // The canonical coordinate is a valid production endpoint; other Angels
    // and non-production suffixes are not.
    expect(() => googleReadProofOptionsFromEnv({
      GOLDEN_GATEWAY_URL: "https://gateway.example/@smcllns/another-angel",
      GOLDEN_ANGEL_KEY: key,
      GOLDEN_GMAIL_QUERY: query,
      GOLDEN_DOC_ID: documentId,
    }, expectedPolicyDigest)).toThrow(/google-read-proof production MCP endpoint/);
    expect(() => googleReadProofOptionsFromEnv({
      GOLDEN_GATEWAY_URL: "https://gateway.example/@smcllns/google-read-proof@preview",
      GOLDEN_ANGEL_KEY: key,
      GOLDEN_GMAIL_QUERY: query,
      GOLDEN_DOC_ID: documentId,
    }, expectedPolicyDigest)).toThrow(/google-read-proof production MCP endpoint/);
    expect(googleReadProofOptionsFromEnv({
      GOLDEN_GATEWAY_URL: "https://gateway.example/@smcllns/google-read-proof",
      GOLDEN_ANGEL_KEY: key,
      GOLDEN_GMAIL_QUERY: query,
      GOLDEN_DOC_ID: documentId,
    }, expectedPolicyDigest).gatewayUrl).toBe("https://gateway.example/@smcllns/google-read-proof");
    expect(googleReadProofOptionsFromEnv({
      GOLDEN_GATEWAY_URL: endpoint,
      GOLDEN_ANGEL_KEY: key,
      GOLDEN_GMAIL_QUERY: query,
      GOLDEN_DOC_ID: documentId,
    }, expectedPolicyDigest)).toEqual({
      gatewayUrl: endpoint,
      angelKey: key,
      gmailQuery: query,
      documentId,
      expectedPolicyDigest,
    });
  });

  test("sends exact MCP requests, matches receipts, and proves both payloads", async () => {
    const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ input, init });
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: string };
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "AngelMCP", version: "0.1.0" },
        } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [listedTool("docs.documents.get", "arc_proof"), listedTool("gmail.users.messages.list", "arc_proof")] },
      });
      const operation = (JSON.parse(String(init?.body)) as { params: { name: string } }).params.name;
      return Response.json(successResponse(
        body.id!,
        operation,
        operation === "gmail.users.messages.list"
          ? { messages: [{ id: "provider-message", threadId: "provider-thread" }] }
          : { documentId, title: "private document title" },
        operation === "gmail.users.messages.list" ? "proof-gmail-request" : "proof-docs-request",
      ));
    };

    const report = await runGoogleReadProofAcceptance({
      gatewayUrl: endpoint,
      angelKey: key,
      gmailQuery: query,
      documentId,
      expectedPolicyDigest,
      fetch,
    });

    expect(requests.map(({ input }) => String(input))).toEqual([endpoint, endpoint, endpoint, endpoint, endpoint]);
    expect(requests.map(({ init }) => JSON.parse(String(init?.body)))).toEqual([
      {
        jsonrpc: "2.0",
        id: "google-read-proof-initialize",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "angelmcp-google-read-proof", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "google-read-proof-tools", method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: "google-read-proof-gmail",
        method: "tools/call",
        params: { name: "gmail.users.messages.list", arguments: { q: query, maxResults: 5 } },
      },
      {
        jsonrpc: "2.0",
        id: "google-read-proof-docs",
        method: "tools/call",
        params: { name: "docs.documents.get", arguments: { documentId } },
      },
    ]);
    for (const { init } of requests) {
      expect(new Headers(init?.headers as Record<string, string> | undefined).get("authorization"))
        .toBe(`Bearer ${key}`);
    }
    expect(report).toEqual({
      passed: true,
      operations: [
        {
          operation: "gmail.users.messages.list",
          requestId: "proof-gmail-request",
          deploymentId: "dep_proof",
          version: 1,
          policyDigest: expectedPolicyDigest,
          availabilityDigest: "c".repeat(64),
          checks: { gateway: true, broker: true, receiptMatch: true, response: true },
        },
        {
          operation: "docs.documents.get",
          requestId: "proof-docs-request",
          deploymentId: "dep_proof",
          version: 1,
          policyDigest: expectedPolicyDigest,
          availabilityDigest: "c".repeat(64),
          checks: { gateway: true, broker: true, receiptMatch: true, response: true },
        },
      ],
    });
  });

  test("requires both canonical tools to use the same non-empty opaque Connection ref", async () => {
    await expect(runGoogleReadProofAcceptance({
      gatewayUrl: endpoint,
      angelKey: key,
      gmailQuery: query,
      documentId,
      expectedPolicyDigest,
      fetch: transcriptFetch({
        tools: [
          listedTool("docs.documents.get", "arc_proof_a"),
          listedTool("gmail.users.messages.list", "arc_proof_b"),
        ],
      }),
    })).rejects.toThrow("both canonical tools to expose the same non-empty opaque Connection ref");
  });

  test("fails when tools/list is not exactly the canonical two-tool set", async () => {
    await expect(runGoogleReadProofAcceptance({
      gatewayUrl: endpoint,
      angelKey: key,
      gmailQuery: query,
      documentId,
      expectedPolicyDigest,
      fetch: transcriptFetch({
        tools: [listedTool("gmail.users.messages.list", "arc_proof")],
      }),
    })).rejects.toThrow("tools/list did not expose exactly the canonical proof tools");
  });

  test("fails loudly on a denied provider response", async () => {
    await expect(runGoogleReadProofAcceptance({
      gatewayUrl: endpoint,
      angelKey: key,
      gmailQuery: query,
      documentId,
      expectedPolicyDigest,
      fetch: transcriptFetch({ denied: true }),
    })).rejects.toThrow("gmail.users.messages.list was denied");
  });

  test("includes the safe Gateway error message when a provider call fails", async () => {
    await expect(runGoogleReadProofAcceptance({
      gatewayUrl: endpoint,
      angelKey: key,
      gmailQuery: query,
      documentId,
      expectedPolicyDigest,
      fetch: transcriptFetch({ providerError: "Google docs.documents.get request failed with status 403" }),
    })).rejects.toThrow("docs.documents.get failed with HTTP 500: Google docs.documents.get request failed with status 403");
  });

  test("fails loudly on malformed provider payloads", async () => {
    await expect(runGoogleReadProofAcceptance({
      gatewayUrl: endpoint,
      angelKey: key,
      gmailQuery: query,
      documentId,
      expectedPolicyDigest,
      fetch: transcriptFetch({ malformed: true }),
    })).rejects.toThrow("docs.documents.get response did not contain the requested document");
  });

  test("rejects a same-shaped Angel whose receipt is not bound to the checked-in policy", async () => {
    await expect(runGoogleReadProofAcceptance({
      gatewayUrl: endpoint,
      angelKey: key,
      gmailQuery: query,
      documentId,
      expectedPolicyDigest,
      fetch: transcriptFetch({ policyDigest: "b".repeat(64) }),
    })).rejects.toThrow("receipt policy digest did not match the checked-in google-read-proof build");
  });

  test("serializes only safe identity and pass fields", async () => {
    const report = await runGoogleReadProofAcceptance({
      gatewayUrl: endpoint,
      angelKey: key,
      gmailQuery: query,
      documentId,
      expectedPolicyDigest,
      fetch: transcriptFetch({}),
    });
    const serialized = serializeGoogleReadProofReport(report);
    expect(serialized).toContain("proof-gmail-request");
    expect(serialized).not.toContain(key);
    expect(serialized).not.toContain("provider-message");
    expect(serialized).not.toContain("private document title");
    expect(serialized).not.toContain("proof@example.com");
    expect(serialized).not.toContain("arc_proof");
    expect(serialized).not.toContain("con_");
    expect(serialized).not.toContain("refresh");
  });
});

function listedTool(name: string, ref: string) {
  return {
    name,
    inputSchema: { type: "object", properties: { angel_connection: { oneOf: [{ const: ref }] } } },
    _meta: { "angelmcp.dev/connections": [{ ref, provider: name.startsWith("docs.") ? "docs" : "gmail", identity: "Proof Google" }] },
  };
}

function successResponse(
  id: string,
  operation: string,
  result: Record<string, unknown>,
  requestId: string,
  policyDigest = expectedPolicyDigest,
) {
  const provider = operation.startsWith("docs.") ? "docs" : "gmail";
  const receipt = (gate: "gateway" | "broker") => ({
    requestId,
    gate,
    deploymentId: "dep_proof",
    version: 1,
    policyDigest,
    availabilityDigest: "c".repeat(64),
    tool: operation,
    provider,
    operation,
    connectionRef: "arc_proof",
    decision: "allow",
  });
  return {
    jsonrpc: "2.0",
    id,
    result: {
      structuredContent: result,
      _meta: { gateway: receipt("gateway"), broker: receipt("broker") },
    },
  };
}

function transcriptFetch(options: {
  tools?: unknown[];
  denied?: boolean;
  malformed?: boolean;
  providerError?: string;
  policyDigest?: string;
}) {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: string };
    if (body.method === "initialize") return Response.json({ result: { protocolVersion: "2025-06-18", serverInfo: { name: "AngelMCP" } } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return Response.json({ result: { tools: options.tools ?? [listedTool("docs.documents.get", "arc_proof"), listedTool("gmail.users.messages.list", "arc_proof")] } });
    const operation = (JSON.parse(String(init?.body)) as { params: { name: string } }).params.name;
    if (options.denied) return Response.json({ result: { isError: true, structuredContent: { denial: { reason: "provider_denied" } }, _meta: {} } });
    if (options.providerError !== undefined && operation === "docs.documents.get") {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32003, message: options.providerError },
      }, { status: 500 });
    }
    return Response.json(successResponse(
      body.id ?? "call",
      operation,
      options.malformed && operation === "docs.documents.get" ? { title: "wrong document" } : operation === "gmail.users.messages.list" ? { messages: [{ id: "provider-message" }] } : { documentId },
      operation === "gmail.users.messages.list" ? "proof-gmail-request" : "proof-docs-request",
      options.policyDigest,
    ));
  };
}
