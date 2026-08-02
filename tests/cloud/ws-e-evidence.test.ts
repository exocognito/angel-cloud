import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const ledger = readFileSync(join(root, "docs/product-ledger.html"), "utf8");
const roadmap = readFileSync(join(root, "ROADMAP.md"), "utf8");
const briefs = [
  ["01-package-install-identity.md", ["O1"]],
  ["02-linux-oauth-storage.md", ["O2"]],
  ["03-local-cloud-syntax.md", ["O3"]],
  ["04-auth-expiry.md", ["O4"]],
  ["05-replay-syntax.md", ["O5"]],
  ["06-account-deletion.md", ["O6"]],
  ["07-public-review-and-self-hosting.md", ["O7", "O9"]],
] as const;

describe("WS-E evidence-only decision closure", () => {
  test("ships exactly seven decision-grade evidence briefs", () => {
    for (const [file, decisions] of briefs) {
      const path = join(root, "docs/evidence/ws-e", file);
      expect(existsSync(path), `${file} must exist`).toBe(true);
      const brief = readFileSync(path, "utf8");
      for (const decision of decisions) expect(brief).toContain(`Decision: ${decision}`);
      for (const heading of [
        "## Question", "## Method", "## Verified results", "## Decision outcome",
        "## Product implication", "## Execution gates", "## Evidence record",
      ]) expect(brief).toContain(heading);
      expect(brief).toContain("Evidence status: complete");
      expect(brief).toContain("Product implementation: none");
      if ((decisions as readonly string[]).includes("O1")) expect(brief).toContain("Outcome: exact gap");
      else expect(brief).toContain("Outcome: close");
    }
  });

  test("keeps WS-E active on the exact O1 namespace-control gap", () => {
    expect(ledger).toMatch(/data-index-key="WS-E"[^>]+data-index-plan="ACTIVE"/);
    expect(ledger).toMatch(/data-deliverable-key="ID-05"[^>]+data-deliverable-truth="PARTIAL"[^>]+data-deliverable-plan="ACTIVE"/);
    for (const decision of ["O1", "O10"]) {
      expect(ledger).toMatch(new RegExp(`data-decision-key="${decision}"[^>]+data-decision-state="OPEN"`));
    }
    for (const decision of ["O2", "O3", "O4", "O5", "O6", "O7", "O9"]) {
      expect(ledger).toMatch(new RegExp(`data-decision-key="${decision}"[^>]+data-decision-state="CLOSED"`));
    }
    expect(ledger).toContain("Control of the `@angelmcp` npm scope is unverified");
    expect(ledger).toContain('data-current-workstream="WS-E" data-current-workstream-status="ACTIVE"');
  });

  test("links every brief from the Ledger and preserves the evidence-only boundary", () => {
    for (const [file] of briefs) expect(ledger).toContain(`evidence/ws-e/${file}`);
    expect(ledger).toContain("Seven briefs exist and WS-E changed no product behavior");
    expect(ledger).toContain("WS-E → O10 → WS2");
    expect(ledger).not.toContain("WS-E must finish before O10");
    expect(roadmap).toContain("WS-E is active");
    expect(roadmap).toContain("O1 blocks WS-E closure");
  });
});
