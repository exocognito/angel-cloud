import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostedVersionArtifact } from "../src/domain";
import { GENERATED_ADAPTERS } from "../src/adapters.generated";
import { sha256Hex } from "../src/crypto";
import { canonicalJson } from "../src/canonical-json";
import { parseAngelDeploymentConfig } from "../src/cli/config";
import { ManagementClient } from "../src/cli/client";
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

  test("publishes tarball containing only runtime source, README, LICENSE, and package.json", () => {
    const proc = Bun.spawnSync(["pnpm", "pack", "--dry-run"], { cwd: PACKAGE_ROOT });
    const stdout = proc.stdout.toString();
    const lines = stdout.split("\n");
    const contentsStart = lines.indexOf("Tarball Contents");
    const contentsEnd = lines.indexOf("Tarball Details");
    expect(contentsStart).toBeGreaterThan(-1);
    expect(contentsEnd).toBeGreaterThan(contentsStart);

    const contents = lines.slice(contentsStart + 1, contentsEnd).map(l => l.trim()).filter(Boolean);

    const allowed = (entry: string) =>
      entry === "LICENSE" ||
      entry === "README.md" ||
      entry === "package.json" ||
      entry.startsWith("src/");

    for (const entry of contents) {
      expect(allowed(entry)).toBe(true);
    }

    expect(contents).toContain("package.json");
    expect(contents).toContain("README.md");
    expect(contents).toContain("LICENSE");
    expect(contents.some(f => f.startsWith("src/"))).toBe(true);
  });

  test("exports explicit root, build, and CLI modules without wildcard subpaths", () => {
    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
    expect(packageJson.exports).toEqual({
      ".": {
        types: "./src/index.ts",
        default: "./src/index.ts",
      },
      "./build": {
        types: "./src/build.ts",
        default: "./src/build.ts",
      },
      "./cli": {
        types: "./src/cli/index.ts",
        default: "./src/cli/index.ts",
      },
    });
  });

  test("bundles the root entry for a Worker without Node filesystem dependencies", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "angel-core-worker-bundle-"));
    const result = await Bun.build({
      entrypoints: [join(PACKAGE_ROOT, "src/index.ts")],
      target: "browser",
      outdir: outDir,
      format: "esm",
      sourcemap: "none",
    });

    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(1);
    const output = await result.outputs[0]!.text();
    expect(output).not.toContain("node:fs");
    expect(output).not.toContain("node:path");
  });

  test("provides explicit Node-side build and CLI entrypoints", async () => {
    const [build, cli] = await Promise.all([
      import("../src/build"),
      import("../src/cli"),
    ]);

    expect(typeof build.buildPortableAngel).toBe("function");
    expect(typeof cli.ManagementClient).toBe("function");
    expect(typeof cli.loadAngelDeploymentConfig).toBe("function");
    expect(typeof cli.runAngelCommand).toBe("function");
  });
});

describe("angel.json", () => {
  test("parses the exact portable deployment shape with scalar and repeated bindings", () => {
    expect(parseAngelDeploymentConfig(JSON.stringify({
      target: "https://cloud.example/",
      account: "acct_personal",
      angel: "golden-assistant",
      bindings: {
        preview: {
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
        preview: {
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
      bindings: { preview: { gmail: "personal-google" }, production: { gmail: "personal-google" } },
    };
    for (const candidate of [
      { ...valid, credentials: "must-not-exist" },
      { ...valid, bindings: { preview: valid.bindings.preview } },
      { ...valid, target: "http://cloud.example" },
      { ...valid, target: "https://token@cloud.example" },
      { ...valid, target: "https://cloud.example?account=private" },
      { ...valid, target: "https://cloud.example#private" },
      { ...valid, bindings: { ...valid.bindings, preview: { gmail: [] } } },
    ]) {
      expect(() => parseAngelDeploymentConfig(JSON.stringify(candidate))).toThrow();
    }
  });

  test("names the staging → preview rename for a legacy bindings key", () => {
    expect(() => parseAngelDeploymentConfig(JSON.stringify({
      target: "https://cloud.example",
      account: "acct_personal",
      angel: "gmail-inbox-zero",
      bindings: { staging: { gmail: "personal-google" }, production: { gmail: "personal-google" } },
    }))).toThrow("angel.json bindings.staging is now bindings.preview: rename the key");
  });
});

describe("Angel management commands", () => {
  test("parses the opaque Access token into standard Cloudflare Access headers", async () => {
    const api = fakeApi([jsonResponse([])]);

    await new ManagementClient({
      target: "https://cloud.example",
      token: "management-secret",
      accessToken: JSON.stringify({
        "cf-access-client-id": "access-client-id",
        "cf-access-client-secret": "access-client-secret",
      }),
      fetch: api.fetch,
    }).listConnections("acct_demo");

    expect(api.requests[0]?.headers.get("authorization")).toBe("Bearer management-secret");
    expect(api.requests[0]?.headers.get("cf-access-client-id")).toBe("access-client-id");
    expect(api.requests[0]?.headers.get("cf-access-client-secret")).toBe("access-client-secret");
    expect(api.requests[0]?.headers.has("x-angel-access")).toBe(false);
  });

  test("omits an unset optional Access token", async () => {
    const api = fakeApi([jsonResponse([])]);

    await new ManagementClient({
      target: "https://cloud.example",
      token: "management-secret",
      fetch: api.fetch,
    }).listConnections("acct_demo");

    expect(api.requests[0]?.headers.has("cf-access-client-id")).toBe(false);
    expect(api.requests[0]?.headers.has("cf-access-client-secret")).toBe(false);
    expect(api.requests[0]?.headers.has("x-angel-access")).toBe(false);
  });

  test("rejects malformed Access service-token JSON before sending a request", async () => {
    for (const accessToken of [
      "",
      "not-json",
      JSON.stringify({ "cf-access-client-id": "client-id" }),
      JSON.stringify({
        "cf-access-client-id": "client-id",
        "cf-access-client-secret": "client-secret",
        extra: "not-allowed",
      }),
      JSON.stringify({
        "cf-access-client-id": 123,
        "cf-access-client-secret": "client-secret",
      }),
      JSON.stringify({
        "cf-access-client-id": " client-id",
        "cf-access-client-secret": "client-secret",
      }),
    ]) {
      const api = fakeApi([jsonResponse([])]);
      await expect(new ManagementClient({
        target: "https://cloud.example",
        token: "management-secret",
        accessToken,
        fetch: api.fetch,
      }).listConnections("acct_demo")).rejects.toThrow(/Access token/);
      expect(api.requests).toHaveLength(0);
    }
  });

  test("publishes straight to production in one step with production's bindings", async () => {
    const artifact = versionArtifact();
    const api = fakeApi([
      jsonResponse(connections()),
      jsonResponse({
        angel: managementAngel("staging"),
        keys: { staging: "ak_preview_once", production: "ak_production_once" },
      }),
      jsonResponse(publishedVersion(artifact)),
      jsonResponse(productionDeployment(artifact)),
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
      "POST /v1/angels/ang_golden/environments/production/deployments",
    ]);
    expect(await bodies(api.requests)).toEqual([
      undefined,
      {},
      { artifact, expectedDigest: artifact.digest },
      {
        versionId: "ver_golden_1",
        expectedDigest: artifact.digest,
        bindings: PRODUCTION_BINDINGS,
      },
    ]);
    for (const request of api.requests) {
      expect(request.headers.get("authorization")).toBe("Bearer management-secret");
    }
    for (const request of api.requests.filter((request) => request.method !== "GET")) {
      const body = await request.clone().json();
      expect(request.headers.get("idempotency-key")).toBe(await expectedIdempotencyKey(request, body));
    }
    expect(output.join("\n")).toContain("preview key: ak_preview_once");
    expect(output.join("\n")).toContain("production key: ak_production_once");
    expect(output.join("\n")).toContain("published golden-assistant Version 1 to production");
  });

  test("accepts a preview-spelled ensure response once the server drops the legacy dialect", async () => {
    const artifact = versionArtifact();
    const api = fakeApi([
      jsonResponse(connections()),
      jsonResponse({
        angel: managementAngel("preview"),
        keys: { preview: "ak_preview_once", production: "ak_production_once" },
      }),
      jsonResponse(publishedVersion(artifact)),
      jsonResponse(productionDeployment(artifact)),
    ]);
    const output: string[] = [];

    await runAngelCommand(["publish", "golden-assistant"], {
      repoRoot: commandRepo(),
      fetch: api.fetch,
      build: async () => ({ artifact, outDir: "/build/golden-assistant" }),
      output: (line) => output.push(line),
      env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
    });

    expect(output.join("\n")).toContain("preview key: ak_preview_once");
  });

  test("deploys to preview with preview's own bindings under --preview", async () => {
    const artifact = versionArtifact();
    const api = fakeApi([
      jsonResponse(connections()),
      jsonResponse({ angel: managementAngel("staging") }),
      jsonResponse(publishedVersion(artifact)),
      jsonResponse(previewDeployment(artifact)),
    ]);
    const output: string[] = [];

    await runAngelCommand(["publish", "golden-assistant", "--preview"], {
      repoRoot: commandRepo(),
      fetch: api.fetch,
      build: async () => ({ artifact, outDir: "/build/golden-assistant" }),
      output: (line) => output.push(line),
      env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
    });

    expect(api.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /v1/accounts/acct_demo/connections",
      "PUT /v1/accounts/acct_demo/angels/golden-assistant",
      "POST /v1/angels/ang_golden/versions",
      "POST /v1/angels/ang_golden/environments/preview/deployments",
    ]);
    expect(await api.requests[3]!.clone().json()).toEqual({
      versionId: "ver_golden_1",
      expectedDigest: artifact.digest,
      bindings: PREVIEW_BINDINGS,
    });
    expect(output.join("\n")).toContain("published golden-assistant Version 1 to preview");
  });

  test("sends production's bindings to preview under --share-production-credentials", async () => {
    const artifact = versionArtifact();
    const api = fakeApi([
      jsonResponse(connections()),
      jsonResponse({ angel: managementAngel("staging") }),
      jsonResponse(publishedVersion(artifact)),
      jsonResponse(previewDeployment(artifact)),
    ]);

    await runAngelCommand(
      ["publish", "golden-assistant", "--preview", "--share-production-credentials"],
      {
        repoRoot: commandRepo(),
        fetch: api.fetch,
        build: async () => ({ artifact, outDir: "/build/golden-assistant" }),
        output: () => {},
        env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
      },
    );

    expect(new URL(api.requests[3]!.url).pathname)
      .toBe("/v1/angels/ang_golden/environments/preview/deployments");
    expect(await api.requests[3]!.clone().json()).toEqual({
      versionId: "ver_golden_1",
      expectedDigest: artifact.digest,
      bindings: PRODUCTION_BINDINGS,
    });
  });

  test("rejects --share-production-credentials without --preview and unknown publish flags", async () => {
    for (const flags of [
      ["--share-production-credentials"],
      ["--preview", "--preview"],
      ["--prod"],
      ["--preview", "--share-production-bindings"],
    ]) {
      const api = fakeApi([]);
      await expect(runAngelCommand(["publish", "golden-assistant", ...flags], {
        repoRoot: commandRepo(),
        fetch: api.fetch,
        build: async () => ({ artifact: versionArtifact(), outDir: "/build/golden-assistant" }),
        output: () => {},
        env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
      })).rejects.toThrow(/usage: angel/);
      expect(api.requests).toHaveLength(0);
    }
  });

  test("surfaces the preview no-bindings 400 with the API's guidance", async () => {
    const artifact = versionArtifact();
    const api = fakeApi([
      jsonResponse(connections()),
      jsonResponse({ angel: managementAngel("staging") }),
      jsonResponse(publishedVersion(artifact)),
      jsonResponse({
        error: "preview has no Connection bindings: bind a Connection to preview, or pass production's bindings explicitly to share its credentials",
      }, 400),
    ]);

    await expect(runAngelCommand(["publish", "golden-assistant", "--preview"], {
      repoRoot: commandRepo(),
      fetch: api.fetch,
      build: async () => ({ artifact, outDir: "/build/golden-assistant" }),
      output: () => {},
      env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
    })).rejects.toThrow(
      "POST /v1/angels/ang_golden/environments/preview/deployments failed (HTTP 400): "
      + "preview has no Connection bindings: bind a Connection to preview, "
      + "or pass production's bindings explicitly to share its credentials",
    );
  });

  test("rejects a staging-spelled deployment response from the preview route", async () => {
    const artifact = versionArtifact();
    const api = fakeApi([
      jsonResponse(connections()),
      jsonResponse({ angel: managementAngel("staging") }),
      jsonResponse(publishedVersion(artifact)),
      jsonResponse(deployment("dep_preview_1", "staging", artifact)),
    ]);

    await expect(runAngelCommand(["publish", "golden-assistant", "--preview"], {
      repoRoot: commandRepo(),
      fetch: api.fetch,
      build: async () => ({ artifact, outDir: "/build/golden-assistant" }),
      output: () => {},
      env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
    })).rejects.toThrow(/response schema error: deployment\.environment is invalid/);
  });

  test("does not print Angel keys when ensure does not return them", async () => {
    const artifact = versionArtifact();
    const api = fakeApi([
      jsonResponse(connections()),
      jsonResponse({ angel: managementAngel("staging") }),
      jsonResponse(publishedVersion(artifact)),
      jsonResponse(productionDeployment(artifact)),
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

  test("promotes the exact active preview deployment without building or publishing a Version", async () => {
    const artifact = versionArtifact();
    const api = fakeApi([
      jsonResponse(managementAngel("staging")),
      jsonResponse(previewEnvironment(artifact.digest)),
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
      "GET /v1/angels/ang_golden/environments/preview",
      "GET /v1/accounts/acct_demo/connections",
      "POST /v1/angels/ang_golden/environments/production/promotions",
    ]);
    expect(await bodies(api.requests)).toEqual([
      undefined,
      undefined,
      undefined,
      {
        stagedDeploymentId: "dep_preview_1",
        expectedDigest: artifact.digest,
        bindings: PRODUCTION_BINDINGS,
      },
    ]);
    expect(api.requests.some((request) => new URL(request.url).pathname.endsWith("/versions"))).toBe(false);
  });

  test("stops promotion when preview has no active deployment", async () => {
    const api = fakeApi([
      jsonResponse(managementAngel("staging")),
      jsonResponse(previewEnvironment(null)),
    ]);

    await expect(runAngelCommand(["deploy", "golden-assistant", "--prod"], {
      repoRoot: commandRepo(),
      fetch: api.fetch,
      build: async () => ({ artifact: versionArtifact(), outDir: "/build/golden-assistant" }),
      output: () => {},
      env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
    })).rejects.toThrow("no active preview deployment to promote");
    expect(api.requests).toHaveLength(2);
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

  test("rejects an unhealthy historical nickname when no healthy match exists", async () => {
    const tombstone = { ...connections()[0]!, id: "con_removed", health: "error" as const };
    const api = fakeApi([jsonResponse([tombstone, connections()[1]!])]);
    await expect(runAngelCommand(["publish", "golden-assistant"], {
      repoRoot: commandRepo(),
      fetch: api.fetch,
      build: async () => ({ artifact: versionArtifact(), outDir: "/build/golden-assistant" }),
      output: () => {},
      env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
    })).rejects.toThrow("Connection nickname personal-google exists but is not healthy");
    expect(api.requests).toHaveLength(1);
  });

  test("resolves a healthy replacement despite a same-nickname tombstone", async () => {
    const artifact = versionArtifact();
    const tombstone = { ...connections()[0]!, id: "con_removed", health: "error" as const };
    const replacement = { ...connections()[0]!, id: "con_replacement", health: "healthy" as const };
    const api = fakeApi([
      jsonResponse([tombstone, replacement, connections()[1]!]),
      jsonResponse({
        angel: managementAngel("staging"),
        keys: { staging: "ak_preview_once", production: "ak_production_once" },
      }),
      jsonResponse(publishedVersion(artifact)),
      jsonResponse(productionDeployment(artifact)),
    ]);
    await runAngelCommand(["publish", "golden-assistant"], {
      repoRoot: commandRepo(),
      fetch: api.fetch,
      build: async () => ({ artifact, outDir: "/build/golden-assistant" }),
      output: () => {},
      env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
    });
    const deployment = await api.requests[3]!.clone().json() as { bindings: Record<string, string[]> };
    expect(deployment.bindings["gdocs-read"]).toEqual(["con_replacement"]);
  });

  test("stops at the first HTTP, non-JSON, or response schema failure", async () => {
    const artifact = versionArtifact();
    for (const response of [
      jsonResponse({ error: "unavailable" }, 503),
      new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
      jsonResponse({ connections: [] }),
    ]) {
      const api = fakeApi([response, jsonResponse({ angel: managementAngel("staging") })]);
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

  test("uses an explicit injected deployment-config loader without weakening the file-backed default", async () => {
    const artifact = versionArtifact();
    const api = fakeApi([
      jsonResponse(connections()),
      jsonResponse({ angel: managementAngel("staging") }),
      jsonResponse(publishedVersion(artifact)),
      jsonResponse(productionDeployment(artifact)),
    ]);
    const cleanRoot = mkdtempSync(join(tmpdir(), "angel-core-clean-cli-"));

    await runAngelCommand(["publish", "golden-assistant"], {
      repoRoot: cleanRoot,
      fetch: api.fetch,
      build: async () => ({ artifact, outDir: "/build/golden-assistant" }),
      loadDeploymentConfig: () => ({
        target: "https://self-hosted.example",
        account: "acct_demo",
        angel: "golden-assistant",
        bindings: {
          preview: {
            "gdocs-read": "personal-google",
            "gmail-read-and-draft": ["work-google"],
          },
          production: {
            "gdocs-read": "personal-google",
            "gmail-read-and-draft": ["personal-google", "work-google"],
          },
        },
      }),
      output: () => {},
      env: { ANGEL_MANAGEMENT_TOKEN: "management-secret" },
    });

    expect(api.requests[0]?.url).toBe("https://self-hosted.example/v1/accounts/acct_demo/connections");
  });
});

const PACKAGE_ROOT = join(import.meta.dir, "..");

const PREVIEW_BINDINGS = {
  "gdocs-read": ["con_personal"],
  "gmail-read-and-draft": ["con_work"],
};

const PRODUCTION_BINDINGS = {
  "gdocs-read": ["con_personal"],
  "gmail-read-and-draft": ["con_personal", "con_work"],
};

function commandRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "angel-core-cli-"));
  const angelDir = join(root, "angels", "golden-assistant");
  mkdirSync(angelDir, { recursive: true });
  writeFileSync(join(angelDir, "angel.json"), JSON.stringify({
    target: "https://self-hosted.example",
    account: "acct_demo",
    angel: "golden-assistant",
    bindings: {
      preview: {
        "gdocs-read": "personal-google",
        "gmail-read-and-draft": ["work-google"],
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
        requiredScopes: [
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/gmail.readonly",
        ],
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
      providers: ["gmail", "docs"],
      health: "healthy",
    },
  ];
}

function environmentState(
  environment: "staging" | "preview" | "production",
  activeDeploymentId: string | null,
) {
  return {
    environment,
    keyFingerprint: "k".repeat(12),
    activeDeployment: activeDeploymentId === null ? null : {
      id: activeDeploymentId,
      versionId: "ver_golden_1",
      digest: "d".repeat(64),
      bindings: PREVIEW_BINDINGS,
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

/**
 * The cloud's spelling-neutral angel routes translate responses to the
 * pinned legacy dialect ("staging") with no way to ask for the canonical
 * spelling, so the fake serves both dialects.
 */
function managementAngel(spelling: "staging" | "preview") {
  return {
    id: "ang_golden",
    accountId: "acct_demo",
    slug: "golden-assistant",
    environments: {
      [spelling]: environmentState(spelling, "dep_preview_1"),
      production: environmentState("production", null),
    },
  };
}

function publishedVersion(artifact: HostedVersionArtifact) {
  return { id: "ver_golden_1", angelId: "ang_golden", number: 1, digest: artifact.digest, artifact };
}

function previewEnvironment(digest: string | null) {
  return {
    ...environmentState("preview", digest === null ? null : "dep_preview_1"),
    activeDeployment: digest === null ? null : {
      id: "dep_preview_1",
      versionId: "ver_golden_1",
      digest,
      bindings: PREVIEW_BINDINGS,
    },
  };
}

function previewDeployment(artifact: HostedVersionArtifact) {
  return deployment("dep_preview_1", "preview", artifact);
}

function productionDeployment(artifact: HostedVersionArtifact) {
  return deployment("dep_prod_1", "production", artifact);
}

function deployment(
  id: string,
  environment: "staging" | "preview" | "production",
  artifact: HostedVersionArtifact,
) {
  return {
    id,
    angelId: "ang_golden",
    environment,
    versionId: "ver_golden_1",
    version: 1,
    digest: artifact.digest,
    bindings: PRODUCTION_BINDINGS,
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
