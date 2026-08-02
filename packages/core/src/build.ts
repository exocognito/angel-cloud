import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compileHostedAngel,
  type HostedVersionArtifact,
} from "./domain";

const OUTPUT_FILES = ["angel.version.json", "angel.version.sha256"] as const;

export interface PortableBuildResult {
  artifact: HostedVersionArtifact;
  outDir: string;
}

export async function buildPortableAngel(input: {
  repoRoot: string;
  angelId: string;
}): Promise<PortableBuildResult> {
  const angelDir = join(input.repoRoot, "angels", input.angelId);
  const raw = readFileSync(join(angelDir, "ANGEL.yaml"), "utf8");
  const artifact = await compileHostedAngel(raw, {
    loadAngel: (name) => readLocalAngel(input.repoRoot, name),
  });
  if (artifact.name !== input.angelId) {
    throw new Error(
      `ANGEL.yaml name ${artifact.name} does not match folder ${input.angelId}`,
    );
  }

  const outDir = join(angelDir, "build");
  mkdirSync(outDir, { recursive: true });
  const stale = readdirSync(outDir).filter(
    (file) => !OUTPUT_FILES.includes(file as (typeof OUTPUT_FILES)[number]),
  );
  if (stale.length > 0) {
    throw new Error(`stale files in ${outDir}: ${stale.sort().join(", ")}`);
  }
  writeFileSync(join(outDir, "angel.version.json"), `${artifact.canonicalSource}\n`);
  writeFileSync(join(outDir, "angel.version.sha256"), `${artifact.digest}\n`);
  return { artifact, outDir };
}

function readLocalAngel(repoRoot: string, name: string): string | undefined {
  try {
    return readFileSync(join(repoRoot, "angels", name, "ANGEL.yaml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
