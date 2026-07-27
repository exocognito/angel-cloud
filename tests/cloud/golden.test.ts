import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGoldenAssistantVersion,
  goldenOptionsFromEnv,
  loadGoldenAngelInput,
} from "../../src/golden-client";
import { parseAngelDeploymentConfig } from "@smcllns/angel-core/cli";

const repoRoot = join(import.meta.dir, "../..");
const accessToken = JSON.stringify({
  "cf-access-client-id": "access-client-id",
  "cf-access-client-secret": "access-client-secret",
});

describe("golden checked-in inputs", () => {
  test("requires explicit deployed Worker URLs and credentials for the executable journey", () => {
    expect(() => goldenOptionsFromEnv(repoRoot, {})).toThrow("GOLDEN_CONTROL_URL is required");
    expect(() => goldenOptionsFromEnv(repoRoot, {
      GOLDEN_CONTROL_URL: "https://control.example",
      GOLDEN_GATEWAY_URL: "https://gateway.example",
      GOLDEN_MANAGEMENT_TOKEN: "management",
      GOLDEN_ADMIN_TOKEN: "admin",
    })).toThrow("GOLDEN_ACCESS_TOKEN is required");
    expect(goldenOptionsFromEnv(repoRoot, {
      GOLDEN_CONTROL_URL: "https://control.example",
      GOLDEN_GATEWAY_URL: "https://gateway.example",
      GOLDEN_MANAGEMENT_TOKEN: "management",
      GOLDEN_ADMIN_TOKEN: "admin",
      GOLDEN_ACCESS_TOKEN: accessToken,
    })).toEqual({
      repoRoot,
      controlBaseUrl: "https://control.example",
      gatewayBaseUrl: "https://gateway.example",
      managementToken: "management",
      adminToken: "admin",
      accessToken,
    });
  });

  test("loads policy from ANGEL.yaml and deterministic deployment concerns from tracked examples", async () => {
    const inbox = await loadGoldenAngelInput(repoRoot, "gmail-inbox-zero", exampleDeploymentConfig);
    const assistant = await loadGoldenAngelInput(repoRoot, "golden-assistant", exampleDeploymentConfig);

    expect(inbox.artifact.name).toBe("gmail-inbox-zero");
    expect(inbox.artifact.tools).toHaveLength(21);
    expect(inbox.config).toMatchObject({
      account: "acct_demo",
      angel: "gmail-inbox-zero",
      bindings: {
        production: { gmail: "personal-google" },
      },
    });
    expect(assistant.artifact.name).toBe("golden-assistant");
    expect(assistant.artifact.bindingRequirements.map(({ id }) => id)).toEqual([
      "gdocs-read",
      "gmail-read-and-draft",
    ]);
    expect(assistant.config.bindings.production).toEqual({
      "gdocs-read": "personal-google",
      "gmail-read-and-draft": ["personal-google", "work-google"],
    });
    expect(assistant.artifact.canonicalSource).not.toContain("personal-google");
    expect(assistant.artifact.canonicalSource).not.toContain("work-google");
  });

  test("the default deployment loader fails on a clean copy without ignored angel.json", async () => {
    const cleanRoot = mkdtempSync(join(tmpdir(), "angel-cloud-clean-copy-"));
    const angelDir = join(cleanRoot, "angels", "gmail-inbox-zero");
    mkdirSync(angelDir, { recursive: true });
    writeFileSync(
      join(angelDir, "ANGEL.yaml"),
      readFileSync(join(repoRoot, "angels/gmail-inbox-zero/ANGEL.yaml"), "utf8"),
    );

    await expect(loadGoldenAngelInput(cleanRoot, "gmail-inbox-zero")).rejects.toThrow(/angel\.json/);
  });

  test("builds v2 by replacing only the checked-in Gmail child source", async () => {
    const v1 = await buildGoldenAssistantVersion(repoRoot, 1);
    const v2 = await buildGoldenAssistantVersion(repoRoot, 2);

    expect(v1.digest).not.toBe(v2.digest);
    expect(v1.tools.map(({ name }) => name)).toEqual([
      "docs.documents.get",
      "gmail.users.drafts.create",
      "gmail.users.messages.get",
      "gmail.users.messages.list",
    ]);
    expect(v2.tools.map(({ name }) => name)).toEqual([
      "docs.documents.get",
      "gmail.users.drafts.create",
      "gmail.users.labels.list",
      "gmail.users.messages.get",
      "gmail.users.messages.list",
    ]);
    expect(v2.children.find(({ name }) => name === "gmail-read-and-draft")?.digest)
      .not.toBe(v1.children.find(({ name }) => name === "gmail-read-and-draft")?.digest);
    expect(readFileSync(join(repoRoot, "angels/gmail-read-and-draft/ANGEL.v2.yaml"), "utf8"))
      .toContain("gmail.users.labels.list");
  });
});

function exampleDeploymentConfig(
  root: string,
  angelId: string,
) {
  return parseAngelDeploymentConfig(readFileSync(
    join(root, `angels/${angelId}/angel.example.json`),
    "utf8",
  ));
}
