import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostedVersionArtifact } from "../src/domain";
import { GENERATED_ADAPTERS } from "../src/adapters.generated";
import { sha256Hex } from "../src/crypto";
import { canonicalJson } from "../src/canonical-json";
import { parseAngelDeploymentConfig } from "../src/cli/config";
import { runAngelCommand } from "../src/cli/commands";

describe("Angel CLI module surface", () => {
  test("exposes config parsing and injectable commands", async () => {
    const [config, commands] = await Promise.all([
      import("../src/cli/config").catch(() => ({})),
      import("../src/cli/commands").catch(() => ({})),
    ]);

    expect(typeof (config as { parseAngelDeploymentConfig?: unknown }).parseAngelDeploymentConfig)
      .toBe("function");
    expect(typeof (commands as { runAngelCommand?: unknown }).runAngelCommand).toBe("function");
  });

  test("exposes the Angel command through the package", () => {
    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
    expect(packageJson.bin).toEqual({ angel: "src/scripts/angel.ts" });
    expect(packageJson.scripts.angel).toBe("bun run src/scripts/angel.ts");
    expect(existsSync(join(PACKAGE_ROOT, "src/scripts/angel.ts"))).toBe(true);
  });
});

describe("angel.json", () => {
  test("parses the exact portable deployment shape with scalar and repeated bindings", () => {
    expect(parseAngelDeploymentConfig(JSON.stringify({
      target: "https://cloud.example/",
      account: "acct_personal",
      angel: "golden-assistant",
      bindings: {
        staging: {
          "gmail-read-and-draft": ["personal-google", "work-google"],
          "gdocs-read": "personal-google",
        },
        production: {
          "gmail-read-and-draft": ["personal-google", "work-google"],
          "gdocs-read": "personal-google",
        },
      },
    }))).toEqual({
      target: "https://cloud.example",
      account: "acct_personal",
      angel: "golden-assistant",
      bindings: {
        staging: {
          "gmail-read-and-draft": ["personal-google", "work-google"],
          "gdocs-read": "personal-google",
        },
        production: {
          "gmail-read-and-draft": ["personal-google", "work-google"],
          "gdocs-read": "personal-google",
        },
      },
    });
  });

  test("rejects unknown keys, incomplete environments, and unsafe targets", () => {
    const valid = {
      target: "https://cloud.example",
      account: "acct_personal",
      angel: "gmail-inbox-zero",
      bindings: { staging: { gmail: "personal-google" }, production: { gmail: "personal-google" } },
    };
    for (const candidate of [
      { ...valid, credentials: "must-not-exist" },
      { ...valid, bindings: { staging: valid.bindings.staging } },
      { ...valid, target: "http://cloud.example" },
      { ...valid, target: "https://token@cloud.example" },
      { ...valid, target: "https://cloud.example?account=private" },
      { ...valid, target: "https://cloud.example#private" },
      { ...valid, bindings: { ...valid.bindings, staging: { gmail: [] } } },
    ]) {
      expect(() => parseAngelDeploymentConfig(JSON.stringify(candidate))).toThrow();
    }
  });
});

describe("Angel management commands", () => {
  test("publishes one built artifact through the exact primitive API sequence", async () => {
    const artifact = versionArtifact();
    const api = fakeApi([
      jsonResponse(connections()),
      jsonResponse({ angel: managementAngel(), keys: { staging: "ak_staging_once", production: "ak_production_once" } }),
      jsonResponse(publishedVersion(artifact)),
      jsonResponse(stagingDeployment(artifact)),
    ]);
    const output: string[] = [];
    const builds: string[] = [];

    await runAngelCommand(["publish", "golden-assistant"], {
      repoRoot: commandRepo(),
      fetch: api.fetch,
      build: async ({ angelId }) => {
        builds.push(angelId);
        return { artifact, outDir: `/build/${angelId}` };
      },
      output: (line) => output.push(line),
      env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
    });

    expect(builds).toEqual(["golden-assistant"]);
    expect(api.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /v1/accounts/acct_demo/connections",
      "PUT /v1/accounts/acct_demo/angels/golden-assistant",
      "POST /v1/angels/ang_golden/versions",
      "POST /v1/angels/ang_golden/environments/staging/deployments",
    ]);
    expect(await bodies(api.requests)).toEqual([
      undefined,
      {},
      { artifact, expectedDigest: artifact.digest },
      {
        versionId: "ver_golden_1",
        expectedDigest: artifact.digest,
        bindings: {
          "gdocs-read": ["con_personal"],
          "gmail-read-and-draft": ["con_personal", "con_work"],
        },
      },
    ]);
    for (const request of api.requests) {
      expect(request.headers.get("authorization")).toBe("Bearer management-secret");
    }
    for (const request of api.requests.filter((request) => request.method !== "GET")) {
      const body = await request.clone().json();
      expect(request.headers.get("idempotency-key")).toBe(await expectedIdempotencyKey(request, body));
    }
    expect(output.join("\n")).toContain("ak_staging_once");
    expect(output.join("\n")).toContain("ak_production_once");
  });

  test("does not print Angel keys when ensure does not return them", async () => {
    const artifact = versionArtifact();
    const api = fakeApi([
      jsonResponse(connections()),
      jsonResponse({ angel: managementAngel() }),
      jsonResponse(publishedVersion(artifact)),
      jsonResponse(stagingDeployment(artifact)),
    ]);
    const output: string[] = [];

    await runAngelCommand(["publish", "golden-assistant"], {
      repoRoot: commandRepo(),
      fetch: api.fetch,
      build: async () => ({ artifact, outDir: "/build/golden-assistant" }),
      output: (line) => output.push(line),
      env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
    });

    expect(output.join("\n")).not.toMatch(/key/i);
  });

  test("promotes the exact active staged deployment without building or publishing a Version", async () => {
    const artifact = versionArtifact();
    const api = fakeApi([
      jsonResponse(managementAngel()),
      jsonResponse(stagingEnvironment(artifact.digest)),
      jsonResponse(connections()),
      jsonResponse(productionDeployment(artifact)),
    ]);
    let buildCalls = 0;

    await runAngelCommand(["deploy", "golden-assistant", "--prod"], {
      repoRoot: commandRepo(),
      fetch: api.fetch,
      build: async () => {
        buildCalls += 1;
        throw new Error("deploy --prod must not build");
      },
      output: () => {},
      env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
    });

    expect(buildCalls).toBe(0);
    expect(api.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /v1/accounts/acct_demo/angels/golden-assistant",
      "GET /v1/angels/ang_golden/environments/staging",
      "GET /v1/accounts/acct_demo/connections",
      "POST /v1/angels/ang_golden/environments/production/promotions",
    ]);
    expect(await bodies(api.requests)).toEqual([
      undefined,
      undefined,
      undefined,
      {
        stagedDeploymentId: "dep_stage_1",
        expectedDigest: artifact.digest,
        bindings: {
          "gdocs-read": ["con_personal"],
          "gmail-read-and-draft": ["con_personal", "con_work"],
        },
      },
    ]);
    expect(api.requests.some((request) => new URL(request.url).pathname.endsWith("/versions"))).toBe(false);
  });

  test("fails before mutation for a duplicate or missing Connection nickname", async () => {
    const artifact = versionArtifact();
    for (const listedConnections of [
      [...connections(), { ...connections()[0]!, id: "con_duplicate" }],
      connections().filter((connection) => connection.nickname !== "work-google"),
    ]) {
      const api = fakeApi([jsonResponse(listedConnections)]);
      await expect(runAngelCommand(["publish", "golden-assistant"], {
        repoRoot: commandRepo(),
        fetch: api.fetch,
        build: async () => ({ artifact, outDir: "/build/golden-assistant" }),
        output: () => {},
        env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
      })).rejects.toThrow(/Connection nickname/);
      expect(api.requests).toHaveLength(1);
    }
  });

  test("stops at the first HTTP, non-JSON, or response schema failure", async () => {
    const artifact = versionArtifact();
    for (const response of [
      jsonResponse({ error: "unavailable" }, 503),
      new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
      jsonResponse({ connections: [] }),
    ]) {
      const api = fakeApi([response, jsonResponse({ angel: managementAngel() })]);
      await expect(runAngelCommand(["publish", "golden-assistant"], {
        repoRoot: commandRepo(),
        fetch: api.fetch,
        build: async () => ({ artifact, outDir: "/build/golden-assistant" }),
        output: () => {},
        env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
      })).rejects.toThrow();
      expect(api.requests).toHaveLength(1);
    }
  });
});

const PACKAGE_ROOT = join(import.meta.dir, "..");

function commandRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "angel-core-cli-"));
  const angelDir = join(root, "angels", "golden-assistant");
  mkdirSync(angelDir, { recursive: true });
  writeFileSync(join(angelDir, "angel.json"), JSON.stringify({
    target: "https://self-hosted.example",
    account: "acct_demo",
    angel: "golden-assistant",
    bindings: {
      staging: {
        "gdocs-read": "personal-google",
        "gmail-read-and-draft": ["personal-google", "work-google"],
      },
      production: {
        "gdocs-read": "personal-google",
        "gmail-read-and-draft": ["personal-google", "work-google"],
      },
    },
  }, null, 2));
  return root;
}

function versionArtifact(): HostedVersionArtifact {
  const content = {
    format: "angel.version.v2" as const,
    name: "golden-assistant",
    charter: "Read mail and documents.",
    children: [
      { name: "gdocs-read", digest: "a".repeat(64) },
      { name: "gmail-read-and-draft", digest: "b".repeat(64) },
    ],
    providers: {
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
    },
    bindingRequirements: [
      {
        id: "gdocs-read",
        source: "gdocs-read",
        provider: "docs",
        credential: "google_oauth" as const,
        requiredScopes: ["https://www.googleapis.com/auth/documents.readonly"],
        tools: ["docs.documents.get"],
      },
      {
        id: "gmail-read-and-draft",
        source: "gmail-read-and-draft",
        provider: "gmail",
        credential: "google_oauth" as const,
        requiredScopes: ["https://www.googleapis.com/auth/gmail.modify"],
        tools: ["gmail.users.messages.list", "gmail.users.messages.get", "gmail.users.drafts.create"],
      },
    ],
    tools: [
      "docs.documents.get",
      "gmail.users.drafts.create",
      "gmail.users.messages.get",
      "gmail.users.messages.list",
    ].map((name) => {
      const provider = name.split(".", 1)[0]!;
      return {
        name,
        provider,
        operation: name,
        argGuards: [],
        request: GENERATED_ADAPTERS[provider]!.operations[name]!.request,
      };
    }),
  };
  const canonicalSource = canonicalJson(content);
  return { ...content, canonicalSource, digest: "d".repeat(64) };
}

function connections() {
  return [
    {
      id: "con_personal",
      accountId: "acct_demo",
      nickname: "personal-google",
      identityLabel: "Google personal@example.test",
      credential: "google_oauth",
      providers: ["gmail", "docs"],
      health: "healthy",
    },
    {
      id: "con_work",
      accountId: "acct_demo",
      nickname: "work-google",
      identityLabel: "Google work@example.test",
      credential: "google_oauth",
      providers: ["gmail"],
      health: "healthy",
    },
  ];
}

function environmentState(environment: "staging" | "production", activeDeploymentId: string | null) {
  return {
    environment,
    keyFingerprint: "k".repeat(12),
    activeDeployment: activeDeploymentId === null ? null : {
      id: activeDeploymentId,
      versionId: "ver_golden_1",
      digest: "d".repeat(64),
      bindings: {
        "gdocs-read": ["con_personal"],
        "gmail-read-and-draft": ["con_personal", "con_work"],
      },
    },
    pendingDeployment: null,
    repair: null,
    availability: {
      defaultEnabled: true,
      toolOverrides: {},
      connectionOverrides: {},
      revision: 0,
    },
    pendingAvailability: null,
  };
}

function managementAngel() {
  return {
    id: "ang_golden",
    accountId: "acct_demo",
    slug: "golden-assistant",
    environments: {
      staging: environmentState("staging", "dep_stage_1"),
      production: environmentState("production", null),
    },
  };
}

function publishedVersion(artifact: HostedVersionArtifact) {
  return { id: "ver_golden_1", angelId: "ang_golden", number: 1, digest: artifact.digest, artifact };
}

function stagingEnvironment(digest: string) {
  return {
    environment: "staging",
    keyFingerprint: "k".repeat(12),
    activeDeployment: {
      id: "dep_stage_1",
      versionId: "ver_golden_1",
      digest,
      bindings: {
        "gdocs-read": ["con_personal"],
        "gmail-read-and-draft": ["con_personal", "con_work"],
      },
    },
    pendingDeployment: null,
    repair: null,
    availability: {
      defaultEnabled: true,
      toolOverrides: {},
      connectionOverrides: {},
      revision: 0,
    },
    pendingAvailability: null,
  };
}

function stagingDeployment(artifact: HostedVersionArtifact) {
  return deployment("dep_stage_1", "staging", artifact);
}

function productionDeployment(artifact: HostedVersionArtifact) {
  return deployment("dep_prod_1", "production", artifact);
}

function deployment(id: string, environment: "staging" | "production", artifact: HostedVersionArtifact) {
  return {
    id,
    angelId: "ang_golden",
    environment,
    versionId: "ver_golden_1",
    version: 1,
    digest: artifact.digest,
    bindings: {
      "gdocs-read": ["con_personal"],
      "gmail-read-and-draft": ["con_personal", "con_work"],
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function fakeApi(responses: Response[]) {
  const requests: Request[] = [];
  return {
    requests,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    },
  };
}

async function bodies(requests: Request[]): Promise<unknown[]> {
  return Promise.all(requests.map(async (request) =>
    request.body === null ? undefined : request.clone().json()
  ));
}

async function expectedIdempotencyKey(request: Request, body: unknown): Promise<string> {
  return sha256Hex(canonicalJson({
    method: request.method,
    path: new URL(request.url).pathname,
    body,
  }));
}
