import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const core = join(root, "packages/core");
const baseline = JSON.parse(readFileSync(join(root, "docs/evidence/ws1-release-baseline.json"), "utf8")) as {
  corePackage: string;
  registryIntegrity: string;
  toolchain: { pnpm: string; bun: string; node: string; wrangler: string };
  packedFiles: Record<string, { sha256: string; size: number; mode: string }>;
  allowedPackedDifferences: Record<string, string>;
  workerNormalizedJsSha256: Record<string, string>;
};

function spawn(command: string[], cwd = root, env: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: command,
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function run(command: string[], cwd = root, env: Record<string, string> = {}): string {
  const result = spawn(command, cwd, env);
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${result.exitCode})\n${stdout}${stderr}`);
  }
  return stdout;
}

function runExpectedFailure(command: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = spawn(command, cwd, env);
  if (result.exitCode === 0) throw new Error(`${command.join(" ")} unexpectedly succeeded`);
  return `${result.stdout.toString()}${result.stderr.toString()}`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function digest(algorithm: "sha256" | "sha512", bytes: Uint8Array): string {
  return createHash(algorithm).update(bytes).digest(algorithm === "sha512" ? "base64" : "hex");
}

function sha256(path: string): string {
  return digest("sha256", readFileSync(path));
}

function normalizedWorkerSha256(path: string): string {
  const normalized = readFileSync(path, "utf8").replace(
    /^\/\/ (?:node_modules\/\.pnpm\/@smcllns\+angel-core@0\.3\.0\/node_modules\/@smcllns\/angel-core|packages\/core)\//gm,
    "// @smcllns/angel-core/",
  );
  return digest("sha256", Buffer.from(normalized));
}

function normalizedMode(path: string): string {
  return `0o${(statSync(path).mode & 0o777).toString(8)}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function sameJson(actual: unknown, expected: unknown, label: string): void {
  assert(JSON.stringify(stable(actual)) === JSON.stringify(stable(expected)), `${label} changed`);
}

function checkToolVersion(label: string, command: string[], expected: string): void {
  const actual = run(command).trim();
  assert(
    actual === expected,
    `WS1 toolchain mismatch: ${label} must be ${expected}, received ${actual}. Install the pinned toolchain before running this proof.`,
  );
}

checkToolVersion("pnpm", ["pnpm", "--version"], baseline.toolchain.pnpm);
checkToolVersion("Bun", ["bun", "--version"], baseline.toolchain.bun);
checkToolVersion("Node", ["node", "--version"], baseline.toolchain.node);
checkToolVersion("Wrangler", ["pnpm", "exec", "wrangler", "--version"], baseline.toolchain.wrangler);

const workspace = JSON.parse(run(["pnpm", "-r", "list", "--depth", "-1", "--json"])) as Array<{
  name: string;
  private?: boolean;
}>;
sameJson(workspace.map(({ name }) => name).sort(), ["@exocognito/angelmcp", "@smcllns/angel-core"], "workspace package set");
assert(workspace.find(({ name }) => name === "@exocognito/angelmcp")?.private === true, "workspace root must stay private");
assert(workspace.find(({ name }) => name === "@smcllns/angel-core")?.private !== true, "only core may be packed");

const temp = mkdtempSync(join(tmpdir(), "angelmcp-ws1-release-"));
const packDirectory = join(temp, "pack");
const candidateDirectory = join(temp, "candidate");
const registryDirectory = join(temp, "registry");
const consumerDirectory = join(temp, "consumer");
for (const directory of [packDirectory, candidateDirectory, registryDirectory, consumerDirectory]) mkdirSync(directory);

const pack = JSON.parse(run(["pnpm", "pack", "--json", "--pack-destination", packDirectory], core)) as {
  filename: string;
  files: Array<{ path: string }>;
};
const expectedPaths = Object.keys(baseline.packedFiles).sort();
sameJson(pack.files.map(({ path }) => path).sort(), expectedPaths, "packed file list");
run(["tar", "-xzpf", pack.filename, "-C", candidateDirectory]);

const registryMetadata = JSON.parse(run([
  "pnpm", "view", baseline.corePackage, "dist.tarball", "dist.integrity", "--json",
])) as { "dist.tarball": string; "dist.integrity": string };
assert(registryMetadata["dist.integrity"] === baseline.registryIntegrity, "published registry integrity changed");
const registryResponse = await fetch(registryMetadata["dist.tarball"]);
assert(registryResponse.ok, `registry tarball download failed (${registryResponse.status})`);
const registryBytes = new Uint8Array(await registryResponse.arrayBuffer());
assert(`sha512-${digest("sha512", registryBytes)}` === baseline.registryIntegrity, "registry tarball failed SRI verification");
const registryTarball = join(temp, "registry.tgz");
writeFileSync(registryTarball, registryBytes);
run(["tar", "-xzpf", registryTarball, "-C", registryDirectory]);
const registryPaths = run(["tar", "-tzf", registryTarball]).trim().split("\n")
  .filter((path) => path.startsWith("package/") && !path.endsWith("/"))
  .map((path) => path.slice("package/".length))
  .sort();
sameJson(registryPaths, expectedPaths, "published registry file list");
sameJson(
  Object.keys(baseline.allowedPackedDifferences).sort(),
  ["README.md", "package.json"],
  "allowed packed differences",
);

for (const path of expectedPaths) {
  const candidate = join(candidateDirectory, "package", path);
  const published = join(registryDirectory, "package", path);
  const recorded = baseline.packedFiles[path]!;
  assert(normalizedMode(published) === recorded.mode, `${path} recorded registry mode drifted`);
  assert(statSync(published).size === recorded.size, `${path} recorded registry size drifted`);
  assert(sha256(published) === recorded.sha256, `${path} recorded registry bytes drifted`);
  assert(normalizedMode(candidate) === normalizedMode(published), `${path} mode changed`);
  if (baseline.allowedPackedDifferences[path]) continue;
  assert(statSync(candidate).size === statSync(published).size, `${path} size changed`);
  assert(sha256(candidate) === sha256(published), `${path} bytes changed`);
}

const packedReadme = readFileSync(join(candidateDirectory, "package/README.md"), "utf8");
assert(
  packedReadme.includes("https://github.com/exocognito/angelmcp/blob/main/docs/core/format-v2.md"),
  "packed README must link the canonical format contract",
);
const manifest = JSON.parse(readFileSync(join(candidateDirectory, "package/package.json"), "utf8")) as Record<string, unknown>;
const publishedManifest = JSON.parse(readFileSync(join(registryDirectory, "package/package.json"), "utf8")) as Record<string, unknown>;
const normalizedManifest = structuredClone(manifest);
normalizedManifest.repository = publishedManifest.repository;
sameJson(normalizedManifest, publishedManifest, "package manifest outside canonical repository metadata");
assert(!JSON.stringify(manifest).includes("workspace:"), "workspace protocol leaked into public tarball");
const lifecycleScripts = new Set([
  "preinstall", "install", "postinstall", "prepack", "prepare", "postpack",
  "prepublish", "prepublishOnly", "publish", "postpublish",
]);
for (const script of Object.keys((manifest.scripts ?? {}) as Record<string, string>)) {
  assert(!lifecycleScripts.has(script), `public package gained lifecycle script: ${script}`);
}

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
const isolatedEnv = { XDG_CONFIG_HOME: join(temp, "config"), CI: "1" };
run(["pnpm", "install", "--ignore-scripts", "--store-dir", join(temp, "pnpm-store")], consumerDirectory, isolatedEnv);
assert(run(["bun", "imports.ts"], consumerDirectory, isolatedEnv).trim() === "imports ok", "packed imports failed");
const packedUsage = runExpectedFailure(["pnpm", "exec", "angel"], consumerDirectory, isolatedEnv);
assert(packedUsage.includes("usage: angel build <angel>"), "packed CLI did not expose the 0.3.0 usage contract");
const workspaceUsage = runExpectedFailure(["pnpm", "exec", "angel"], root);
assert(workspaceUsage.includes("usage: angel build <angel>"), "workspace CLI did not expose the 0.3.0 usage contract");

const history = JSON.parse(readFileSync(join(root, "docs/evidence/ws1-core-history.json"), "utf8")) as {
  splitTip: string;
  rewrittenCommitCount: number;
  secretAudit: { matches: number; trackedCredentialFiles: number };
};
run(["git", "cat-file", "-e", `${history.splitTip}^{commit}`]);
run(["git", "merge-base", "--is-ancestor", history.splitTip, "HEAD"]);
const rewrittenCommitCount = Number(run(["git", "rev-list", "--count", history.splitTip]).trim());
assert(rewrittenCommitCount === history.rewrittenCommitCount, "rewritten core commit count changed");

const secretPattern = "(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[0-9A-Za-z]{36,}|sk-[A-Za-z0-9]{32,}|client_secret[[:space:]]*[:=][[:space:]]*[^<]?[A-Za-z0-9_-]{16,}|CLOUDFLARE_API_TOKEN[[:space:]]*[:=])";
let secretMatches = 0;
for (const commit of run(["git", "rev-list", history.splitTip]).trim().split("\n")) {
  const result = spawn(["git", "grep", "-nI", "-E", secretPattern, commit, "--", "."]);
  if (result.exitCode === 0) secretMatches += result.stdout.toString().trim().split("\n").filter(Boolean).length;
  else if (result.exitCode !== 1) throw new Error(`secret scan failed for ${commit}: ${result.stderr.toString()}`);
}
assert(secretMatches === history.secretAudit.matches, "rewritten history secret scan result changed");
const historyNames = run(["git", "log", "--format=", "--name-only", history.splitTip]);
const credentialFiles = historyNames.split("\n").filter((path) =>
  /(^|\/)(\.env(?:\..*)?|angel\.json|[^/]+\.(?:pem|key|p12|pfx))$/i.test(path)
);
assert(credentialFiles.length === history.secretAudit.trackedCredentialFiles, "rewritten history gained a credential file");

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

console.log(`WS1 release integrity passed; network-verified evidence workspace: ${temp}`);
