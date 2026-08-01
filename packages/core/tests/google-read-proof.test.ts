import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileHostedAngel } from "../src/domain";

const repoRoot = join(import.meta.dir, "../../..");
const angelDir = join(repoRoot, "angels/google-read-proof");

describe("google-read-proof portable policy", () => {
  test("defines exactly the real two-operation multi-provider proof", async () => {
    const sourcePath = join(angelDir, "ANGEL.yaml");
    expect(existsSync(sourcePath)).toBe(true);
    const artifact = await compileHostedAngel(readFileSync(sourcePath, "utf8"));

    expect(artifact).toMatchObject({
      name: "google-read-proof",
      charter: "Read bounded Gmail search results and one requested Google Doc. Never create, edit, send, or delete.",
      children: [],
      tools: [
        {
          name: "docs.documents.get",
          provider: "docs",
          operation: "docs.documents.get",
          argGuards: [],
        },
        {
          name: "gmail.users.messages.list",
          provider: "gmail",
          operation: "gmail.users.messages.list",
          argGuards: [{ field: "maxResults", pin: "5" }],
        },
      ],
      bindingRequirements: [
        {
          id: "docs",
          source: "google-read-proof",
          provider: "docs",
          credential: "google_oauth",
          tools: ["docs.documents.get"],
        },
        {
          id: "gmail",
          source: "google-read-proof",
          provider: "gmail",
          credential: "google_oauth",
          tools: ["gmail.users.messages.list"],
        },
      ],
    });
    expect(artifact.tools.map(({ name }) => name)).toEqual([
      "docs.documents.get",
      "gmail.users.messages.list",
    ]);
    expect(artifact.canonicalSource).not.toMatch(/target|account|connection|nickname|secret/i);
  });

  test("builds the checked-in canonical artifact and digest", async () => {
    const sourcePath = join(angelDir, "ANGEL.yaml");
    const artifact = await compileHostedAngel(readFileSync(sourcePath, "utf8"));
    const buildDir = join(angelDir, "build");

    expect(readFileSync(join(buildDir, "angel.version.json"), "utf8")).toBe(
      `${artifact.canonicalSource}\n`
    );
    expect(readFileSync(join(buildDir, "angel.version.sha256"), "utf8")).toBe(
      `${artifact.digest}\n`
    );
  });
});
