import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const core = join(root, "packages/core");
const baseline = JSON.parse(readFileSync(join(root, "docs/evidence/ws1-release-baseline.json"), "utf8")) as {
  toolchain: Record<string, string>;
  packedFiles: Record<string, { sha256: string; size: number; mode: string }>;
  allowedPackedDifferences: Record<string, string>;
  workerNormalizedJsSha256: Record<string, string>;
};

function run(command: string[], cwd = root, env: Record<string, string> = {}): string {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${result.exitCode})\n${stdout}${stderr}`);
  }
  return stdout;
}

function runExpectedFailure(command: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode === 0) {
    throw new Error(`${command.join(" ")} unexpectedly succeeded`);
  }
  return `${result.stdout.toString()}${result.stderr.toString()}`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizedWorkerSha256(path: string): string {
  const normalized = readFileSync(path, "utf8").replace(
    /^\/\/ (?:node_modules\/\.pnpm\/@smcllns\+angel-core@0\.3\.0\/node_modules\/@smcllns\/angel-core|packages\/core)\//gm,
    "// @smcllns/angel-core/",
  );
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizedMode(path: string): string {
  return `0o${(statSync(path).mode & 0o777).toString(8)}`;
}

function sameJson(actual: unknown, expected: unknown, label: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} changed`);
}

assert(run(["pnpm", "--version"]).trim() === baseline.toolchain.pnpm, "pnpm version changed");
assert(run(["bun", "--version"]).trim() === baseline.toolchain.bun, "Bun version changed");
assert(run(["node", "--version"]).trim() === baseline.toolchain.node, "Node version changed");
assert(run(["pnpm", "exec", "wrangler", "--version"]).trim() === baseline.toolchain.wrangler, "Wrangler version changed");

const workspace = JSON.parse(run(["pnpm", "-r", "list", "--depth", "-1", "--json"])) as Array<{
  name: string;
  private?: boolean;
}>;
sameJson(workspace.map(({ name }) => name).sort(), ["@exocognito/angelmcp", "@smcllns/angel-core"], "workspace package set");
assert(workspace.find(({ name }) => name === "@exocognito/angelmcp")?.private === true, "workspace root must stay private");
assert(workspace.find(({ name }) => name === "@smcllns/angel-core")?.private !== true, "only core may be packed");

const temp = mkdtempSync(join(tmpdir(), "angelmcp-ws1-release-"));
const packDirectory = join(temp, "pack");
const extractDirectory = join(temp, "extract");
const consumerDirectory = join(temp, "consumer");
mkdirSync(packDirectory);
mkdirSync(extractDirectory);
mkdirSync(consumerDirectory);

const pack = JSON.parse(run(["pnpm", "pack", "--json", "--pack-destination", packDirectory], core)) as {
  filename: string;
  files: Array<{ path: string }>;
};
const expectedPaths = Object.keys(baseline.packedFiles).sort();
sameJson(pack.files.map(({ path }) => path).sort(), expectedPaths, "packed file list");
run(["tar", "-xzf", pack.filename, "-C", extractDirectory]);

for (const path of expectedPaths) {
  const candidate = join(extractDirectory, "package", path);
  const expected = baseline.packedFiles[path]!;
  assert(normalizedMode(candidate) === expected.mode, `${path} mode changed`);
  if (baseline.allowedPackedDifferences[path]) continue;
  assert(statSync(candidate).size === expected.size, `${path} size changed`);
  assert(sha256(candidate) === expected.sha256, `${path} bytes changed`);
}

const manifest = JSON.parse(readFileSync(join(extractDirectory, "package/package.json"), "utf8")) as Record<string, unknown>;
sameJson(manifest.name, "@smcllns/angel-core", "package name");
sameJson(manifest.version, "0.3.0", "package version");
sameJson(manifest.types, "src/index.ts", "types entry");
sameJson(manifest.bin, { angel: "src/scripts/angel.ts" }, "CLI bin");
sameJson(manifest.files, ["src/", "README.md", "LICENSE"], "published files contract");
sameJson(manifest.exports, {
  ".": { types: "./src/index.ts", default: "./src/index.ts" },
  "./build": { types: "./src/build.ts", default: "./src/build.ts" },
  "./cli": { types: "./src/cli/index.ts", default: "./src/cli/index.ts" },
}, "package exports");
sameJson(manifest.dependencies, { yaml: "^2.4.5" }, "runtime dependencies");
assert(!JSON.stringify(manifest).includes("workspace:"), "workspace protocol leaked into public tarball");

const consumerPackage = {
  private: true,
  type: "module",
  dependencies: { "@smcllns/angel-core": `file:${pack.filename}` },
};
writeFileSync(join(consumerDirectory, "package.json"), `${JSON.stringify(consumerPackage, null, 2)}\n`);
writeFileSync(join(consumerDirectory, "imports.ts"), [
  'await import("@smcllns/angel-core");',
  'await import("@smcllns/angel-core/build");',
  'await import("@smcllns/angel-core/cli");',
  'console.log("imports ok");',
].join("\n"));
const isolatedHome = join(temp, "home");
mkdirSync(isolatedHome);
const originalHome = process.env.HOME;
assert(originalHome, "HOME is required to locate policy-wrapped tool binaries");
const isolatedEnv: Record<string, string> = {
  HOME: isolatedHome,
  XDG_CONFIG_HOME: join(isolatedHome, ".config"),
  DOTFILES_REAL_BUN: process.execPath,
  CI: "1",
};
const realPnpm = join(originalHome, "Library/pnpm/pnpm");
if (existsSync(realPnpm)) isolatedEnv.DOTFILES_REAL_PNPM = realPnpm;
run(["pnpm", "install", "--ignore-scripts"], consumerDirectory, isolatedEnv);
assert(run(["bun", "imports.ts"], consumerDirectory, isolatedEnv).trim() === "imports ok", "packed imports failed");
const packedUsage = runExpectedFailure(["pnpm", "exec", "angel"], consumerDirectory, isolatedEnv);
assert(packedUsage.includes("usage: angel build <angel>"), "packed CLI did not expose the 0.3.0 usage contract");
const workspaceUsage = runExpectedFailure(["pnpm", "exec", "angel"], root);
assert(workspaceUsage.includes("usage: angel build <angel>"), "workspace CLI did not expose the 0.3.0 usage contract");

const history = JSON.parse(readFileSync(join(root, "docs/evidence/ws1-core-history.json"), "utf8")) as { splitTip: string };
run(["git", "cat-file", "-e", `${history.splitTip}^{commit}`]);
assert(run(["git", "merge-base", "--is-ancestor", history.splitTip, "HEAD"]).trim() === "", "split history is not an ancestor");

for (const worker of ["broker", "gateway", "control"]) {
  const outDirectory = join(temp, `worker-${worker}`);
  mkdirSync(outDirectory);
  run(["pnpm", "exec", "wrangler", "deploy", "--dry-run", "--config", `wrangler.${worker}.jsonc`, "--outdir", outDirectory]);
  const bundle = join(outDirectory, `${worker}.js`);
  assert(
    normalizedWorkerSha256(bundle) === baseline.workerNormalizedJsSha256[worker],
    `${worker} Worker JavaScript changed beyond source-path comments`,
  );
  const source = readFileSync(bundle, "utf8");
  assert(!source.includes("node:fs"), `${worker} Worker bundled Node filesystem code`);
  assert(!source.includes("packages/core/src/cli"), `${worker} Worker bundled CLI code`);
}

console.log(`WS1 release integrity passed; evidence workspace: ${temp}`);
