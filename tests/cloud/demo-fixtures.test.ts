import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demoArtifact } from "../../src/demo-fixtures";
import { compileHostedAngel } from "../../src/domain";

const fixtureDirectory = join(import.meta.dir, "../../research/hosted-platform/example-configurations");
const documentId = "doc_golden_1";

describe("embedded comparison-demo artifacts", () => {
  for (const version of [1, 2] as const) {
    test(`v${version} exactly matches the canonical research fixture after materialization`, async () => {
      const source = readFileSync(
        join(fixtureDirectory, `golden-research-assistant.v${version}.hosted.yaml`),
        "utf8",
      ).replace("${GOLDEN_GOOGLE_DOC_ID}", documentId);

      expect(await demoArtifact(version)).toEqual(await compileHostedAngel(source));
    });
  }
});
