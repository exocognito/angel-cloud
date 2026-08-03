#!/usr/bin/env bun

// WS2 install proof for the O1 package identity.
//
// Proves the exact Round-2 install contract from brief 1: a machine with only
// Bun installs the published tarball globally and gets a bare `angel` on PATH.
// It never touches the real registry, so it proves the package rather than the
// publication.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI_ROOT = join(REPO_ROOT, "packages", "cli");

const EXPECTED_NAME = "@angelmcp/cli";
const EXPECTED_VERSION = "0.1.0";
const EXPECTED_BIN = "angel";

// The floor the manifest declares. This proof runs on whatever Bun is installed,
// so it checks that the manifest agrees with this constant; it does not exercise
// the floor. Declared, not proven.
const DECLARED_BUN_RANGE = ">=1.3.0";

// The merged public starter's checked-in Angel. Its digest is read from the WS1
// record rather than copied, so the two cannot drift apart.
const GOLDEN_ANGEL = "gmail-read-and-draft";
const STARTER_PROOF = JSON.parse(
  readFileSync(join(REPO_ROOT, "docs", "evidence", "ws1-starter-proof.json"), "utf8"),
) as { artifactDigest?: string };
if (typeof STARTER_PROOF.artifactDigest !== "string" || STARTER_PROOF.artifactDigest === "") {
  console.error("WS2 CLI install proof failed: ws1-starter-proof.json has no artifactDigest to compare against");
  process.exit(1);
}
const GOLDEN_DIGEST = STARTER_PROOF.artifactDigest;

// Only reproducible facts are committed. A gzip digest and the runner's Bun
// build differ between machines, so committing them would make the comparison
// unpassable on CI; they are reported instead. The published artifact's real
// identity is npm's dist.integrity, which the release workflow records.
interface ProofRecord {
  package: string;
  version: string;
  bin: string;
  engines: string;
  files: string[];
  provedInstallCommand: string;
  registryInstallCommand: string;
  versionOutput: string;
  builtAngel: string;
  builtDigest: string;
}

function run(command: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function fail(message: string): never {
  console.error(`WS2 CLI install proof failed: ${message}`);
  process.exit(1);
}

// Setup steps fail loudly too; a silent mkdir or cp failure otherwise surfaces
// later as a confusing build error.
function mustRun(command: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const result = run(command, options);
  if (result.exitCode !== 0) fail(`${command.join(" ")} exited ${result.exitCode}:\n${result.stderr}`);
  return result;
}

const manifest = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8"));

if (manifest.name !== EXPECTED_NAME) fail(`package name is ${manifest.name}, expected ${EXPECTED_NAME}`);
if (manifest.version !== EXPECTED_VERSION) fail(`version is ${manifest.version}, expected ${EXPECTED_VERSION}`);
if (Object.keys(manifest.bin ?? {}).join(",") !== EXPECTED_BIN) {
  fail(`bin must be exactly { "${EXPECTED_BIN}": ... }, got ${JSON.stringify(manifest.bin)}`);
}

// Brief 1 execution gate: no lifecycle scripts, and no second public core install.
// Any npm lifecycle hook can mutate the artifact after this proof inspected it,
// so the public package carries none of them.
const LIFECYCLE_HOOKS = [
  "preinstall", "install", "postinstall",
  "preprepare", "prepare", "postprepare",
  "prepack", "postpack",
  "prepublish", "prepublishOnly", "publish", "postpublish",
  "preversion", "version", "postversion",
  "prerestart", "restart", "postrestart",
  "prestop", "stop", "poststop",
  "prestart", "start", "poststart",
];
for (const hook of LIFECYCLE_HOOKS) {
  if (manifest.scripts?.[hook]) fail(`lifecycle script "${hook}" is forbidden on the public package`);
}
for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
  const declared = Object.keys(manifest[field] ?? {});
  if (declared.length > 0) {
    fail(`the published CLI must bundle its code; found ${field} ${declared.join(", ")}`);
  }
}
if (manifest.engines?.bun !== DECLARED_BUN_RANGE) {
  fail(`engines.bun is ${manifest.engines?.bun}, expected the declared ${DECLARED_BUN_RANGE}`);
}

const build = run(["bun", "run", "build"], { cwd: CLI_ROOT });
if (build.exitCode !== 0) fail(`bundle build failed:\n${build.stderr}`);

const workspace = mkdtempSync(join(tmpdir(), "angelmcp-cli-proof-"));
try {
  // pnpm owns this workspace, so it packs the tarball a consumer would install
  // and resolves the workspace protocol the way publication does.
  const packed = run(["pnpm", "pack", "--pack-destination", workspace], { cwd: CLI_ROOT });
  if (packed.exitCode !== 0) fail(`pnpm pack failed:\n${packed.stderr}`);

  const tarball = packed.stdout.trim().split("\n").at(-1) ?? "";
  if (!tarball.startsWith(workspace)) fail(`pnpm pack wrote an unexpected path: ${tarball}`);
  const tarballBytes = readFileSync(tarball);
  const tarballSha256 = createHash("sha256").update(tarballBytes).digest("hex");

  const listed = run(["tar", "-tzf", tarball]);
  if (listed.exitCode !== 0) fail(`could not list the tarball:\n${listed.stderr}`);
  const files = listed.stdout.split("\n").filter(Boolean).map((entry) => entry.replace(/^package\//, "")).sort();
  const strays = files.filter((file) =>
    !file.startsWith("dist/") && !["README.md", "LICENSE", "package.json", ""].includes(file)
  );
  for (const required of ["dist/angel.js", "dist/THIRD-PARTY-NOTICES.txt"]) {
    if (!files.includes(required)) fail(`the published tarball is missing ${required}`);
  }
  if (strays.length > 0) fail(`unexpected files in the published tarball: ${strays.join(", ")}`);
  if (files.some((file) => file.endsWith(".ts"))) {
    fail("the published tarball must ship the bundle, not TypeScript sources");
  }

  // The clean consumer: an empty directory and an isolated Bun global prefix.
  const bunHome = join(workspace, "bun-home");
  const consumer = join(workspace, "consumer");
  mustRun(["mkdir", "-p", bunHome, consumer]);

  const installed = run(["bun", "add", "--global", `file:${tarball}`], {
    cwd: consumer,
    env: { BUN_INSTALL: bunHome },
  });
  if (installed.exitCode !== 0) fail(`isolated global install failed:\n${installed.stderr}`);

  const binary = join(bunHome, "bin", EXPECTED_BIN);
  try {
    statSync(binary);
  } catch {
    fail(`global install did not expose a bare ${EXPECTED_BIN} at ${binary}`);
  }

  // A user runs a bare `angel` found on PATH, so prove that, not an absolute path.
  const consumerEnv = {
    BUN_INSTALL: bunHome,
    PATH: `${join(bunHome, "bin")}:${process.env.PATH ?? ""}`,
  };
  const versionRun = run([EXPECTED_BIN, "--version"], { cwd: consumer, env: consumerEnv });
  if (versionRun.exitCode !== 0) fail(`angel --version exited ${versionRun.exitCode}:\n${versionRun.stderr}`);
  const versionOutput = versionRun.stdout.trim();
  if (versionOutput !== EXPECTED_VERSION) {
    fail(`angel --version printed "${versionOutput}", expected "${EXPECTED_VERSION}"`);
  }

  for (const flag of ["--version", "-v"]) {
    const out = run([EXPECTED_BIN, flag], { cwd: consumer, env: consumerEnv });
    if (out.exitCode !== 0 || out.stdout.trim() !== EXPECTED_VERSION) {
      fail(`angel ${flag} printed "${out.stdout.trim()}" (exit ${out.exitCode}), expected ${EXPECTED_VERSION}`);
    }
  }
  for (const args of [[], ["--help"], ["-h"]]) {
    const out = run([EXPECTED_BIN, ...args], { cwd: consumer, env: consumerEnv });
    if (out.exitCode !== 0) fail(`angel ${args.join(" ") || "(no arguments)"} exited ${out.exitCode}`);
    if (!out.stdout.includes("usage:") || !out.stdout.includes(`angel ${EXPECTED_VERSION}`)) {
      fail(`angel ${args.join(" ") || "(no arguments)"} did not print usage with its version`);
    }
  }
  // A bad command explains itself instead of dumping a bundled stack trace.
  const bogus = run([EXPECTED_BIN, "definitely-not-a-command"], { cwd: consumer, env: consumerEnv });
  if (bogus.exitCode === 0) fail("an unknown command must exit non-zero");
  if (/\bat .*\.js:\d+/.test(bogus.stderr)) fail(`an unknown command printed a stack trace:\n${bogus.stderr}`);

  // A version string is not a working CLI. Build a real Angel from a directory
  // outside the repository and check the digest against the WS1 starter proof,
  // so the bundle is proved to carry the compiler and its adapters.
  const project = join(workspace, "project");
  mustRun(["mkdir", "-p", project]);
  mustRun(["cp", "-R", join(REPO_ROOT, "examples", "angels"), project]);
  const built = run([EXPECTED_BIN, "build", GOLDEN_ANGEL], { cwd: project, env: consumerEnv });
  if (built.exitCode !== 0) fail(`angel build ${GOLDEN_ANGEL} failed outside the workspace:\n${built.stderr}`);
  const digest = built.stdout.match(/\b([0-9a-f]{64})\b/)?.[1] ?? "";
  if (digest !== GOLDEN_DIGEST) {
    fail(`angel build ${GOLDEN_ANGEL} produced digest ${digest || "(none)"}, expected ${GOLDEN_DIGEST}`);
  }

  // Inspect what a consumer actually received, not the local build output.
  const installedRoot = join(bunHome, "install", "global", "node_modules", EXPECTED_NAME);
  const bundle = readFileSync(join(installedRoot, "dist", "angel.js"), "utf8");
  if (bundle.includes("@smcllns/angel-core")) {
    fail("the installed bundle references @smcllns/angel-core; the public CLI must not install core twice");
  }
  if (bundle.includes(REPO_ROOT)) fail("the installed bundle embeds an absolute workspace path");
  const notices = readFileSync(join(installedRoot, "dist", "THIRD-PARTY-NOTICES.txt"), "utf8");
  // The same transitive closure build.ts derives, so the two cannot disagree.
  const closureListing = mustRun([
    "pnpm", "--dir", join(REPO_ROOT, "packages", "core"), "list", "--prod", "--depth", "Infinity", "--json",
  ]);
  type DepNode = { version?: string; dependencies?: Record<string, DepNode> };
  const vendored = new Set<string>();
  const walk = (deps: Record<string, DepNode> | undefined) => {
    for (const [name, entry] of Object.entries(deps ?? {})) {
      const linked = entry.version?.startsWith("link:") || entry.version?.startsWith("file:");
      if (!linked) vendored.add(name);
      walk(entry.dependencies);
    }
  };
  for (const project of JSON.parse(closureListing.stdout) as Array<{ dependencies?: Record<string, DepNode> }>) {
    walk(project.dependencies);
  }
  for (const dependency of vendored) {
    if (!notices.includes(`${dependency}@`)) {
      fail(`the shipped third-party notices do not name ${dependency}, whose code the bundle contains`);
    }
  }

  const shipped = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
  // pnpm rewrites workspace: on pack and npm does not understand it at all, so
  // the two packers only agree while no manifest field uses the protocol.
  const shippedManifest = JSON.stringify(shipped);
  if (shippedManifest.includes("workspace:")) {
    fail("the published manifest still uses the workspace: protocol, which npm publish cannot resolve");
  }
  if (shipped.version !== EXPECTED_VERSION) fail(`installed manifest says ${shipped.version}`);

  const record: ProofRecord = {
    package: EXPECTED_NAME,
    version: EXPECTED_VERSION,
    bin: EXPECTED_BIN,
    engines: DECLARED_BUN_RANGE,
    files,
    provedInstallCommand: "bun add --global file:<packed-tarball>",
    registryInstallCommand: `bun add --global ${EXPECTED_NAME}@${EXPECTED_VERSION}`,
    versionOutput,
    builtAngel: GOLDEN_ANGEL,
    builtDigest: digest,
  };
  // Recording a fresh result every run would let the committed evidence drift
  // from what the proof actually produced. Compare by default; rewrite only when
  // asked, so a real change is a deliberate commit.
  const evidencePath = join(REPO_ROOT, "docs", "evidence", "ws2-cli-install-proof.json");
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (process.argv.includes("--update")) {
    writeFileSync(evidencePath, serialized);
  } else {
    let committed = "";
    try {
      committed = readFileSync(evidencePath, "utf8");
    } catch {
      fail(`${evidencePath} is missing; re-run with --update to record it`);
    }
    if (committed !== serialized) {
      fail(
        `the committed install proof disagrees with this run. Re-run with --update and commit the change if it is intended.\n`
        + `committed:\n${committed}\nproduced:\n${serialized}`,
      );
    }
  }

  console.log(
    `WS2 CLI install proof passed: ${EXPECTED_NAME}@${versionOutput} installs a bare ${EXPECTED_BIN}`
    + ` under Bun ${Bun.version}; this run packed ${tarballBytes.byteLength} bytes, sha256 ${tarballSha256}`,
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
