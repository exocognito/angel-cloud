#!/usr/bin/env bun

// Bundles the public CLI into one file so the published package installs
// without a second public core package and without a workspace link.

import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const REPO_ROOT = join(ROOT, "..", "..");
const OUT_DIR = join(ROOT, "dist");
const OUT_FILE = join(OUT_DIR, "angel.js");
const NOTICES_FILE = join(OUT_DIR, "THIRD-PARTY-NOTICES.txt");

const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

rmSync(OUT_DIR, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(ROOT, "src", "angel.ts")],
  outdir: OUT_DIR,
  target: "bun",
  format: "esm",
  minify: false,
  define: {
    ANGEL_CLI_VERSION: JSON.stringify(manifest.version),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("angel CLI bundle failed");
}

// The shebang has to be byte zero, and Bun's banner lands after its prelude.
const SHEBANG = "#!/usr/bin/env bun\n";
const bundled = readFileSync(OUT_FILE, "utf8").replace(/^#![^\n]*\n/, "");
writeFileSync(OUT_FILE, SHEBANG + bundled);
chmodSync(OUT_FILE, 0o755);

// Bundling copies third-party source into dist/angel.js, and those licences
// require their notices to travel with the copy. Derive them from what the
// bundle actually pulled in, not from a hand-kept list.
const VENDORED = [...new Set(
  bundled.match(/\.\.\/\.\.\/node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\//g) ?? [],
)].map((path) => path.replace(/^.*node_modules\//, "").replace(/\/$/, ""))
  .filter((name) => name !== "" && !name.startsWith("."))
  .sort();

// Deriving the list from bundler banners fails open: change the bundle options
// and the list silently empties while the code stays vendored. Cross-check it
// against what core actually declares at runtime.
// The transitive production closure, not core's direct dependencies: a
// dependency of a dependency is compiled in just the same.
const listed = Bun.spawnSync(
  ["pnpm", "--dir", join(REPO_ROOT, "packages", "core"), "list", "--prod", "--depth", "Infinity", "--json"],
  { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
);
if (listed.exitCode !== 0) {
  throw new Error(`could not resolve core's production closure:\n${listed.stderr.toString()}`);
}
type DepNode = { version?: string; dependencies?: Record<string, DepNode> };
const closure = new Set<string>();
const walk = (deps: Record<string, DepNode> | undefined) => {
  for (const [name, entry] of Object.entries(deps ?? {})) {
    // Workspace links are our own source, not vendored third-party code, but
    // their dependencies still get compiled in.
    const linked = entry.version?.startsWith("link:") || entry.version?.startsWith("file:");
    if (!linked) closure.add(name);
    walk(entry.dependencies);
  }
};
for (const project of JSON.parse(listed.stdout.toString()) as Array<{ dependencies?: Record<string, DepNode> }>) {
  walk(project.dependencies);
}
const expected = [...closure].sort();
const missing = expected.filter((name) => !VENDORED.includes(name));
if (missing.length > 0) {
  throw new Error(
    `third-party notice generation missed ${missing.join(", ")}. `
    + `The bundle still contains that code, so shipping without its licence is not an option.`,
  );
}

const notices = VENDORED.map((name) => {
  const packageDir = join(REPO_ROOT, "node_modules", name);
  const meta = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  let text = "";
  for (const candidate of ["LICENSE", "LICENSE.md", "LICENCE", "LICENSE.txt"]) {
    try {
      text = readFileSync(join(packageDir, candidate), "utf8").trim();
      break;
    } catch {
      continue;
    }
  }
  if (text === "") throw new Error(`no licence file found for bundled dependency ${name}`);
  return `${"=".repeat(72)}\n${name}@${meta.version} — ${meta.license ?? "see notice"}\n${"=".repeat(72)}\n\n${text}\n`;
});

writeFileSync(
  NOTICES_FILE,
  `@angelmcp/cli bundles the following third-party code into dist/angel.js.\n`
  + `Their licences and copyright notices are reproduced in full below.\n\n`
  + notices.join("\n"),
);

const bytes = readFileSync(OUT_FILE).byteLength;
console.log(
  `built ${OUT_FILE} (${bytes} bytes) for @angelmcp/cli@${manifest.version}`
  + `; bundled ${VENDORED.length ? VENDORED.join(", ") : "no third-party code"}`,
);
