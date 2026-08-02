import { describe, expect, test } from "bun:test";
import { compileHostedAngel } from "../src/domain";
import { evaluateToolCall, compileRules } from "../src/decision";
import { parseAngelDeploymentConfig } from "../src/cli/config";

describe("portable core", () => {
  test("compiles a policy without deployment identity", async () => {
    const artifact = await compileHostedAngel(`
name: mail
charter: Read bounded mail.
tools:
  - tool: gmail.users.messages.list
`);

    expect(artifact.format).toBe("angel.version.v2");
    expect(artifact.bindingRequirements[0]?.id).toBe("gmail");
    expect(artifact.canonicalSource).not.toMatch(/account|connection|target|secret/i);
  });

  test("enforces portable argument guards independently of a target", () => {
    const rules = compileRules([{ tool: "mail.modify", argGuards: [{ field: "label", forbid: true }] }]);
    expect(evaluateToolCall({ rules, tool: "mail.modify", bodyText: '{"label":"TRASH"}' })).toEqual({
      ok: false,
      denied: "argGuard: label is forbidden",
    });
  });

  test("accepts hosted and self-hosted HTTPS origins without interpreting them", () => {
    for (const target of ["https://angel-cloud.example", "https://self-hosted.example"]) {
      expect(parseAngelDeploymentConfig(JSON.stringify({
        target,
        account: "acct",
        angel: "mail",
        bindings: { preview: {}, production: {} },
      })).target).toBe(target);
    }
  });
});
