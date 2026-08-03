#!/usr/bin/env bun

// Bundles the public CLI into one file so the published package installs
// without a second public core package and without a workspace link.

import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const OUT_DIR = join(ROOT, "dist");
const OUT_FILE = join(OUT_DIR, "angel.js");

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

const bytes = readFileSync(OUT_FILE).byteLength;
console.log(`built ${OUT_FILE} (${bytes} bytes) for @angelmcp/cli@${manifest.version}`);
