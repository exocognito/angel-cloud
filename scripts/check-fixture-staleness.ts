import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileHostedAngel } from "@smcllns/angel-core";

const repoRoot = resolve(import.meta.dir, "..");

async function checkAngelBuildArtifacts(): Promise<string[]> {
  const issues: string[] = [];
  const angels = ["gmail-inbox-zero", "gmail-read-and-draft", "gdocs-read", "golden-assistant"];

  for (const angelId of angels) {
    try {
      const angelDir = join(repoRoot, `examples/angels/${angelId}`);
      const buildDir = join(angelDir, "build");
      const buildArtifactPath = join(buildDir, "angel.version.json");
      const buildHashPath = join(buildDir, "angel.version.sha256");

      if (!existsSync(buildArtifactPath)) {
        issues.push(`${angelId}: missing angel.version.json. Run: bun run angel build ${angelId}`);
        continue;
      }
      if (!existsSync(buildHashPath)) {
        issues.push(`${angelId}: missing angel.version.sha256. Run: bun run angel build ${angelId}`);
        continue;
      }

      const trackedArtifactText = readFileSync(buildArtifactPath, "utf8");
      const trackedHashText = readFileSync(buildHashPath, "utf8");

      const angelYamlPath = join(angelDir, "ANGEL.yaml");
      const source = readFileSync(angelYamlPath, "utf8");

      const recompiled = await compileHostedAngel(source, {
        loadAngel: (name) => {
          const childPath = join(repoRoot, `examples/angels/${name}/ANGEL.yaml`);
          if (!existsSync(childPath)) {
            throw new Error(`Missing child angel policy: ${name}`);
          }
          return readFileSync(childPath, "utf8");
        },
      });

      const recompiledCanonicalSource = `${recompiled.canonicalSource}\n`;
      if (recompiledCanonicalSource !== trackedArtifactText) {
        issues.push(`${angelId}: artifact mismatch. Run: bun run angel build ${angelId}`);
      }

      const recompiledDigestText = `${recompiled.digest}\n`;
      if (recompiledDigestText !== trackedHashText) {
        issues.push(`${angelId}: digest mismatch. Run: bun run angel build ${angelId}`);
      }
    } catch (error) {
      issues.push(`${angelId}: ${String(error)}`);
    }
  }

  return issues;
}

const issues = await checkAngelBuildArtifacts();
for (const issue of issues) {
  console.error(issue);
}
process.exit(issues.length > 0 ? 1 : 0);
