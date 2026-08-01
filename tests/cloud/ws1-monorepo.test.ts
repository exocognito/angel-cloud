import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const json = <T>(path: string): T => JSON.parse(read(path)) as T;

const rootPackage = json<Record<string, unknown>>("package.json");
const corePackage = existsSync(join(root, "packages/core/package.json"))
  ? json<Record<string, unknown>>("packages/core/package.json")
  : {};

describe("WS1 behavior-neutral monorepo", () => {
  test("has one private pnpm workspace and one canonical examples tree", () => {
    expect(rootPackage.name).toBe("@exocognito/angelmcp");
    expect(rootPackage.private).toBe(true);
    expect(rootPackage.packageManager).toBe("pnpm@11.7.0");
    expect(rootPackage.bin).toBeUndefined();
    expect(rootPackage.dependencies).toMatchObject({
      "@smcllns/angel-core": "workspace:0.3.0",
    });

    expect(existsSync(join(root, "pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(join(root, "bun.lock"))).toBe(false);
    expect(existsSync(join(root, "packages/core/pnpm-lock.yaml"))).toBe(false);
    expect(existsSync(join(root, "examples/angels"))).toBe(true);
    expect(existsSync(join(root, "angels"))).toBe(false);
    expect(existsSync(join(root, "docs/core/format-v2.md"))).toBe(true);
    expect(read(".gitignore")).toContain("examples/angels/*/angel.json");
    expect(read(".gitignore")).not.toContain("\nangels/*/angel.json");

    const workspace = read("pnpm-workspace.yaml");
    for (const packageName of ["esbuild", "sharp", "workerd"]) {
      expect(workspace).toContain(`${packageName}: true`);
    }
    expect(workspace).not.toContain("set this to true or false");
  });

  test("keeps the published 0.3.0 package contract intact at packages/core", () => {
    expect(corePackage).toMatchObject({
      name: "@smcllns/angel-core",
      version: "0.3.0",
      types: "src/index.ts",
      bin: { angel: "src/scripts/angel.ts" },
      files: ["src/", "README.md", "LICENSE"],
      repository: {
        type: "git",
        url: "https://github.com/exocognito/angelmcp.git",
        directory: "packages/core",
      },
    });
    expect(corePackage.exports).toEqual({
      ".": { types: "./src/index.ts", default: "./src/index.ts" },
      "./build": { types: "./src/build.ts", default: "./src/build.ts" },
      "./cli": { types: "./src/cli/index.ts", default: "./src/cli/index.ts" },
    });
    expect(corePackage.dependencies).toEqual({ yaml: "^2.4.5" });
    expect(corePackage.private).not.toBe(true);
    const coreReadme = read("packages/core/README.md");
    expect(coreReadme).toContain("`angel.version.v2` artifacts");
    expect(coreReadme).not.toContain("`angel.version.v1` artifacts");
    expect(coreReadme).toContain("pnpm run angel -- build <angel>");
    expect(coreReadme).not.toContain("pnpm --dir packages/core run angel");
    expect(coreReadme).toContain("../../docs/core/format-v2.md");
  });

  test("records rewritten core history without pretending commit ids stayed literal", () => {
    const history = json<{
      sourceRepository: string;
      sourceTip: string;
      archivedRepository: string;
      sourcePrefix: string;
      targetPrefix: string;
      splitTip: string;
      method: string;
      literalSourceHistory: string;
      secretAudit: { matches: number; trackedCredentialFiles: number };
    }>("docs/evidence/ws1-core-history.json");

    expect(history.sourceRepository).toBe("https://github.com/exocognito/angel-core");
    expect(history.sourceTip).toBe("8d08c42ff1fd47420f969d268d03ab0e0d7a3de9");
    expect(history.archivedRepository).toBe("https://github.com/exocognito/angel-core-history");
    expect(history.sourcePrefix).toBe("packages/angel-core");
    expect(history.targetPrefix).toBe("packages/core");
    expect(history.splitTip).toMatch(/^[0-9a-f]{40}$/);
    expect(history.method).toBe("git subtree split, path-prefix rewrite, then unsquashed merge");
    expect(history.literalSourceHistory).toContain("archived source repository");
    expect(history.secretAudit).toMatchObject({ matches: 0, trackedCredentialFiles: 0 });
  });

  test("keeps hosted imports on supported core exports and deployables separate", () => {
    const sourceFiles = [
      ...readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8")),
      ...readdirSync(join(root, "scripts"), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8")),
    ].join("\n");

    expect(sourceFiles).not.toMatch(/@smcllns\/angel-core\/src\//);
    for (const config of ["broker", "gateway", "control"]) {
      const wrangler = read(`wrangler.${config}.jsonc`);
      expect(wrangler).toContain(`src/workers/${config}.ts`);
    }
    expect(read("wrangler.gateway.jsonc")).toContain("angelmcp-broker-demo");
    expect(read("wrangler.control.jsonc")).toContain("angelmcp-gateway-demo");
    expect(read("wrangler.control.jsonc")).toContain("angelmcp-broker-demo");
  });

  test("runs both workflows from the pinned pnpm workspace", () => {
    const ci = read(".github/workflows/ci.yml");
    const acceptance = read(".github/workflows/google-read-proof.yml");
    for (const workflow of [ci, acceptance]) {
      expect(workflow).toContain("pnpm/action-setup@v4");
      expect(workflow).toContain("version: 11.7.0");
      expect(workflow).toContain("oven-sh/setup-bun@v2");
      expect(workflow).toContain("bun-version: 1.3.11");
      expect(workflow).toContain("pnpm install --frozen-lockfile --ignore-scripts");
      expect(workflow).not.toContain("bun install");
    }
    expect(ci).toContain("node-version: 26.0.0");
    expect(ci).toContain("fetch-depth: 0");
    expect(ci).toContain("pnpm run check");
  });

  test("runs repository Angel commands from the canonical examples tree", () => {
    const scripts = rootPackage.scripts as Record<string, string>;
    expect(scripts.angel).toBe("cd examples && pnpm exec angel");

    const result = Bun.spawnSync({
      cmd: ["bun", "run", "angel", "build", "ws1-path-check"],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(result.exitCode).toBe(1);
    expect(output).toContain(join(root, "examples/angels/ws1-path-check/ANGEL.yaml"));
    expect(output).not.toContain(join(root, "angels/ws1-path-check/ANGEL.yaml"));

    const documented = Bun.spawnSync({
      cmd: ["pnpm", "run", "angel", "--", "build", "ws1-doc-path-check"],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const documentedOutput = `${documented.stdout.toString()}${documented.stderr.toString()}`;
    expect(documented.exitCode).toBe(1);
    expect(documentedOutput).toContain(join(root, "examples/angels/ws1-doc-path-check/ANGEL.yaml"));
  });

  test("ships a release-integrity proof in the canonical check", () => {
    const scripts = rootPackage.scripts as Record<string, string>;
    expect(scripts["check:ws1"]).toBe("bun run scripts/ws1-release-integrity.ts");
    expect(scripts.check).toContain("pnpm run check:ws1");
    const proof = read("scripts/ws1-release-integrity.ts");
    expect(proof).toContain("pnpm\", \"view");
    expect(proof).toContain("sha512");
    expect(proof).toContain("git\", \"grep");
    expect(proof).toContain("rewrittenCommitCount");
    expect(proof).not.toContain("DOTFILES_REAL_");
    expect(proof).not.toContain("Library/pnpm/pnpm");
  });

  test("supersedes split-repository ownership without changing product behavior", () => {
    expect(read("docs/adrs/0007-monorepo-source-and-release-integrity.md")).toContain(
      "supersedes ADR 0004 repository ownership",
    );
    expect(read("docs/adrs/0007-monorepo-source-and-release-integrity.md")).toContain(
      "No runtime, auth, OAuth, policy, route, provider, product-flow, binding, or secret", 
    );
    expect(read("docs/adrs/0007-monorepo-source-and-release-integrity.md")).toContain(
      "missing `--preview` flag",
    );
    const ledger = read("docs/product-ledger.html");
    expect(ledger).toContain('data-index-key="WS1" data-index-plan="COMPLETE"');
    expect(ledger).toContain("exocognito/angels#1 must merge before this PR");
    expect(ledger).toContain("one-time external attestation");
    expect(ledger).toContain("npm SRI provenance");
    expect(ledger).toContain("last-registry-tarball parity proof");

    const ownershipAdr = read("docs/adrs/0005-spec-derived-execution-closure.md");
    expect(ownershipAdr).toContain("`packages/core/adapters/<provider>/`");
    expect(ownershipAdr).toContain("`docs/core/format-v2.md`");
    expect(ownershipAdr).not.toContain("`packages/angel-core/adapters/<provider>/`");
    expect(read("docs/adrs/README.md")).toContain("../core/format-v2.md");
    const researchExamples = read("research/hosted-platform/example-configurations/README.md");
    expect(researchExamples).toContain("../../../docs/faq.md#can-i-self-host-a-compatible-control-plane");
    expect(researchExamples).not.toContain("has not passed its clean-room proof");

    expect(json<{ allowedPackedDifferences: Record<string, string> }>("docs/evidence/ws1-release-baseline.json")
      .allowedPackedDifferences["README.md"]).toContain("format correction");

    const canonicalDocs = [
      "README.md",
      "packages/core/README.md",
      "docs/faq.md",
      "NEXT.md",
      "docs-site/public/SKILL.md",
      "docs-site/public/llms.txt",
      "examples/angels/FIXTURES.md",
      "docs/core/format-v2.md",
      "research/hosted-platform/example-configurations/README.md",
    ].map(read).join("\n");
    expect(canonicalDocs).not.toMatch(/exocognito\/angel-cloud(?!-history)/);
    expect(canonicalDocs).not.toContain("packages/angel-core");
    expect(canonicalDocs).not.toMatch(/(?<!examples\/)angels\/(gmail-inbox-zero|gdocs-read|golden-assistant)/);
  });
});
