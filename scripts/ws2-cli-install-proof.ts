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

// The merged public starter's checked-in Angel, and the digest docs/evidence/
// ws1-starter-proof.json recorded for it.
const GOLDEN_ANGEL = "gmail-read-and-draft";
const GOLDEN_DIGEST = "11542429eff4698ac6f7a121b91bd5ce5d9284c13bf7fba8773c78eb361fd0d4";

interface ProofRecord {
  package: string;
  version: string;
  bin: string;
  tarballSha256: string;
  tarballBytes: number;
  files: string[];
  bunVersion: string;
  installCommand: string;
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

const manifest = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8"));

if (manifest.name !== EXPECTED_NAME) fail(`package name is ${manifest.name}, expected ${EXPECTED_NAME}`);
if (manifest.version !== EXPECTED_VERSION) fail(`version is ${manifest.version}, expected ${EXPECTED_VERSION}`);
if (Object.keys(manifest.bin ?? {}).join(",") !== EXPECTED_BIN) {
  fail(`bin must be exactly { "${EXPECTED_BIN}": ... }, got ${JSON.stringify(manifest.bin)}`);
}

// Brief 1 execution gate: no lifecycle scripts, and no second public core install.
for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]) {
  if (manifest.scripts?.[hook]) fail(`lifecycle script "${hook}" is forbidden on the public package`);
}
if (Object.keys(manifest.dependencies ?? {}).length > 0) {
  fail(`the published CLI must bundle its code; found dependencies ${JSON.stringify(manifest.dependencies)}`);
}
if (!manifest.engines?.bun) fail("package.json must declare the tested minimum engines.bun");

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
  if (strays.length > 0) fail(`unexpected files in the published tarball: ${strays.join(", ")}`);
  if (files.some((file) => file.endsWith(".ts"))) {
    fail("the published tarball must ship the bundle, not TypeScript sources");
  }

  // The clean consumer: an empty directory and an isolated Bun global prefix.
  const bunHome = join(workspace, "bun-home");
  const consumer = join(workspace, "consumer");
  run(["mkdir", "-p", bunHome, consumer]);

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

  const versionRun = run([binary, "--version"], { cwd: consumer, env: { BUN_INSTALL: bunHome } });
  if (versionRun.exitCode !== 0) fail(`angel --version exited ${versionRun.exitCode}:\n${versionRun.stderr}`);
  const versionOutput = versionRun.stdout.trim();
  if (versionOutput !== EXPECTED_VERSION) {
    fail(`angel --version printed "${versionOutput}", expected "${EXPECTED_VERSION}"`);
  }

  // A version string is not a working CLI. Build a real Angel from a directory
  // outside the repository and check the digest against the WS1 starter proof,
  // so the bundle is proved to carry the compiler and its adapters.
  const project = join(workspace, "project");
  run(["mkdir", "-p", project]);
  run(["cp", "-R", join(REPO_ROOT, "examples", "angels"), project]);
  const built = run([binary, "build", GOLDEN_ANGEL], { cwd: project, env: { BUN_INSTALL: bunHome } });
  if (built.exitCode !== 0) fail(`angel build ${GOLDEN_ANGEL} failed outside the workspace:\n${built.stderr}`);
  const digest = built.stdout.match(/\b([0-9a-f]{64})\b/)?.[1] ?? "";
  if (digest !== GOLDEN_DIGEST) {
    fail(`angel build ${GOLDEN_ANGEL} produced digest ${digest || "(none)"}, expected ${GOLDEN_DIGEST}`);
  }

  // The consumer must not need the workspace: nothing may resolve back into it.
  const bundle = readFileSync(join(CLI_ROOT, "dist", "angel.js"), "utf8");
  if (bundle.includes("@smcllns/angel-core")) {
    fail("the bundle still references @smcllns/angel-core; the public CLI must not install core twice");
  }
  if (bundle.includes(REPO_ROOT)) fail("the bundle embeds an absolute workspace path");

  const record: ProofRecord = {
    package: EXPECTED_NAME,
    version: EXPECTED_VERSION,
    bin: EXPECTED_BIN,
    tarballSha256,
    tarballBytes: tarballBytes.byteLength,
    files,
    bunVersion: Bun.version,
    installCommand: `bun add --global ${EXPECTED_NAME}@${EXPECTED_VERSION}`,
    versionOutput,
    builtAngel: GOLDEN_ANGEL,
    builtDigest: digest,
  };
  writeFileSync(
    join(REPO_ROOT, "docs", "evidence", "ws2-cli-install-proof.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );

  console.log(`WS2 CLI install proof passed: ${EXPECTED_NAME}@${versionOutput} installs a bare ${EXPECTED_BIN} under Bun ${Bun.version}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
