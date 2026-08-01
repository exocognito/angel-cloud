import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");

describe("publication hygiene", () => {
  test("example angel.json files contain no environment-specific deployment targets", () => {
    const examples = ["gmail-inbox-zero", "golden-assistant"];
    const environmentSpecificTarget = "https://angelmcp-control-demo.sam-633.workers.dev";

    for (const angelId of examples) {
      const examplePath = join(repoRoot, `examples/angels/${angelId}/angel.example.json`);
      const example = JSON.parse(readFileSync(examplePath, "utf8"));

      expect(example.target).not.toBe(environmentSpecificTarget);
      expect(example.target).toMatch(/^https:\/\/[a-z-]+\.example\b/);
    }
  });
});
