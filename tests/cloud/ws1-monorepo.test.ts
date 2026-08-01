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
    expect(ci).toContain("pnpm run check");
  });

  test("ships a release-integrity proof in the canonical check", () => {
    const scripts = rootPackage.scripts as Record<string, string>;
    expect(scripts["check:ws1"]).toBe("bun run scripts/ws1-release-integrity.ts");
    expect(scripts.check).toContain("pnpm run check:ws1");
    expect(existsSync(join(root, "scripts/ws1-release-integrity.ts"))).toBe(true);
  });

  test("supersedes split-repository ownership without changing product behavior", () => {
    expect(read("docs/adrs/0007-monorepo-source-and-release-integrity.md")).toContain(
      "supersedes ADR 0004 repository ownership",
    );
    expect(read("docs/adrs/0007-monorepo-source-and-release-integrity.md")).toContain(
      "No runtime, auth, OAuth, policy, route, provider, UX, binding, or secret change",
    );
    expect(read("docs/product-ledger.html")).toContain('data-index-key="WS1" data-index-plan="COMPLETE"');
  });
});
