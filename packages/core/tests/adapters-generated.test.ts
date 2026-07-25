import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { deriveAdapter } from "../src/adapter-derive";
import { GENERATED_ADAPTERS } from "../src/adapters.generated";

const adaptersDir = join(import.meta.dir, "..", "adapters");

describe("generated adapter registry", () => {
  test("matches a fresh derivation of every adapter source directory", async () => {
    const providers = readdirSync(adaptersDir).sort();
    expect(Object.keys(GENERATED_ADAPTERS).sort()).toEqual(providers);
    for (const provider of providers) {
      const fresh = await deriveAdapter({
        provider,
        adapterYaml: readFileSync(join(adaptersDir, provider, "adapter.yaml"), "utf8"),
        specYaml: readFileSync(join(adaptersDir, provider, "openapi.angel.yaml"), "utf8"),
      });
      // A mismatch means adapters/ changed without `bun run generate:adapters`.
      expect(GENERATED_ADAPTERS[provider]).toEqual(fresh);
    }
  });
});
