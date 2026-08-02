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
      if ((decisions as readonly string[]).includes("O1")) {
        expect(brief).toContain("Outcome: exact gap");
        expect(brief).not.toContain("enough evidence to close O1");
        expect(brief).not.toContain("O1 should close");
        expect(brief).toContain("a pnpm global install");
        expect(brief).toContain("Bun-global remains documentation-backed and unproved");
        const canonical = brief.split("## Evidence record")[0] ?? "";
        expect(canonical).not.toContain("- Control the `@angelmcp` npm scope");
      } else expect(brief).toContain("Outcome: close");
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
    expect(ledger).toMatch(/data-decision-key="O1"[^>]+data-decision-linked="WS-E · ID-05 · WS2"/);
    expect(ledger).toContain('data-current-workstream="WS-E" data-current-workstream-status="ACTIVE"');
    expect(ledger).toMatch(/data-contradiction-key="C15" data-record-state="OPEN"/);
    expect(ledger).toContain("disposable real Google callback/client-type journey");
    expect(ledger).toContain("APRD assumes one OAuth client can serve hosted and headless consent");
    expect(ledger).toContain("WS-E is now active.");
  });

  test("links every brief from the Ledger and preserves the evidence-only boundary", () => {
    for (const [file] of briefs) expect(ledger).toContain(`evidence/ws-e/${file}`);
    expect(ledger).toContain("Seven briefs exist and WS-E changed no product behavior");
    expect(ledger).toContain("WS-E → O10 → WS2");
    expect(ledger).not.toContain("WS-E must finish before O10");
    expect(roadmap).toContain("WS-E is active");
    expect(roadmap).toContain("O1 blocks WS-E closure");
    expect(ledger).not.toContain("private-data-safe");
    expect(ledger).toContain("must treat charter and guard literals as public");
    expect(ledger).not.toContain("updates private binding config");
    expect(ledger).toContain("does not mutate a binding");
    expect(ledger).not.toContain("O5 blocks replay syntax");
    expect(ledger).toContain("no server, port, credential store, report file, or provider call");
    const syntaxBrief = readFileSync(join(root, "docs/evidence/ws-e/03-local-cloud-syntax.md"), "utf8");
    expect(syntaxBrief).not.toContain("pnpm add --global @smcllns/angel-core@v2.1");
    expect(syntaxBrief).toContain("bun add --global @angelmcp/cli@0.1.0 # pending O1");
    expect(syntaxBrief).toContain("`apps connect google --local\\|--cloud`");
    const packageBrief = readFileSync(join(root, "docs/evidence/ws-e/01-package-install-identity.md"), "utf8");
    expect(packageBrief).toContain("Bun is the proven runtime and documents global CLI installs; the Bun-global path is untested");
    const deletionBrief = readFileSync(join(root, "docs/evidence/ws-e/06-account-deletion.md"), "utf8");
    expect(deletionBrief).toContain("O10 must accept the non-resolving permanent-handle tombstone");
    expect(ledger).toContain("O10 must accept the permanent-handle tombstone contract");
    expect(ledger).not.toMatch(/review bundle/i);
    expect(ledger).toContain("Publish only the O7 capability summary");
    const replayBrief = readFileSync(join(root, "docs/evidence/ws-e/05-replay-syntax.md"), "utf8");
    expect(replayBrief).toContain("Product Ledger command C11");
    expect(deletionBrief).toContain("decision O6, guarantee G10, and command C13");
    expect(ledger).toMatch(/data-learning-id="DF-035"[^>]+data-learning-source="evidence\/ws-e\/07-public-review-and-self-hosting\.md"/);
    const lr006 = ledger.match(/<tr data-learning-id="LR-006"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(lr006).toContain('href="evidence/ws-e/01-package-install-identity.md"');
    expect(lr006).toContain('href="evidence/ws1-core-history.json"');
    expect(lr006).toContain('href="evidence/ws1-release-baseline.json"');
    const faq = readFileSync(join(root, "docs/faq.md"), "utf8");
    expect(faq).toContain("guard field names and literal values as public");
  });
});
