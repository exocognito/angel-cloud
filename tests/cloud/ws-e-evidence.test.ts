import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = join(import.meta.dir, "../..");
const ledger = readFileSync(join(root, "docs/product-ledger.html"), "utf8");
const roadmap = readFileSync(join(root, "ROADMAP.md"), "utf8");

const markdownAnchors = (source: string) => {
  const seen = new Map<string, number>();
  return new Set([...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => {
    const base = (match[1] ?? "").trim().toLowerCase().replace(/[`*]/g, "")
      .replace(/[^\w\- ]+/g, "").replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  }));
};
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
      for (const match of brief.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1] ?? "";
        if (/^(?:https?:|#)/.test(target)) continue;
        const [relativePath, fragment] = target.split("#", 2);
        const resolvedPath = resolve(dirname(path), relativePath ?? "");
        expect(existsSync(resolvedPath), `${file}: ${target}`).toBe(true);
        if (!fragment) continue;
        expect(fragment).not.toMatch(/^L\d/);
        const targetSource = readFileSync(resolvedPath, "utf8");
        if (resolvedPath.endsWith(".md")) expect(markdownAnchors(targetSource).has(fragment)).toBe(true);
        else if (resolvedPath.endsWith(".html")) expect(targetSource).toContain(`id="${fragment}"`);
      }
      if ((decisions as readonly string[]).includes("O1")) {
        expect(brief).toContain("Outcome: exact gap");
        expect(brief).not.toContain("enough evidence to close O1");
        expect(brief).not.toContain("O1 should close");
        expect(brief).toContain("a pnpm global install");
        expect(brief).toContain("Bun-global remains documentation-backed and unproved");
        expect(brief).toContain("the first draft of this record recommended closing O1");
        expect(brief).not.toContain("the investigator recommended closing O1");
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
    expect(ledger).toMatch(/data-contradiction-key="C15" data-record-state="CLOSED"/);
    expect(ledger).toMatch(/data-contradiction-key="C16" data-record-state="OPEN"/);
    expect(ledger).toContain("disposable real Google callback/client-type journey");
    expect(ledger).toContain("APRD assumes an OS keychain on exe.dev Linux");
    expect(ledger).toContain("APRD assumes one OAuth client can serve hosted and headless consent");
    expect(ledger).toContain("The callback half of the original contradiction is carried by C16");
    expect(ledger).toMatch(/data-contradiction-key="C15"[\s\S]*?<dt>Linked Project Index rows<\/dt><dd>O2 · WS-E · WS2 · PD-02<\/dd>/);
    expect(ledger).toMatch(/data-contradiction-key="C16"[\s\S]*?<dt>Linked Project Index rows<\/dt><dd>O2 · WS2 · PD-02<\/dd>/);
    expect(ledger).toContain("Blocked by O1, O10, and every required WS2 proof");
    expect(ledger).toContain("O6 settled the deletion-cascade and non-resolving-handle-tombstone contract");
    expect(ledger).toContain("Seven decisions closed across six briefs");
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
    expect(syntaxBrief).toContain("Angel-owned encrypted vault");
    expect(syntaxBrief).not.toContain("machine credential store");
    expect(syntaxBrief).not.toContain("O2 must prove the supported Linux path");
    const packageBrief = readFileSync(join(root, "docs/evidence/ws-e/01-package-install-identity.md"), "utf8");
    expect(packageBrief).toContain("Bun is the proven runtime and documents global CLI installs; the Bun-global path is untested");
    const deletionBrief = readFileSync(join(root, "docs/evidence/ws-e/06-account-deletion.md"), "utf8");
    expect(deletionBrief).toContain("O10 must accept the non-resolving permanent-handle tombstone");
    expect(deletionBrief).toContain("local provider OAuth tokens in the Angel-owned encrypted vault");
    expect(deletionBrief).not.toContain("local provider OAuth tokens in the OS keychain");
    expect(ledger).toContain("O10 must accept the permanent-handle tombstone contract");
    const o7 = ledger.match(/<details id="decision-O7"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(o7).toContain("What does the public review bundle contain?");
    expect(ledger.replace(o7, "")).not.toMatch(/review bundle/i);
    expect(ledger).not.toMatch(/public bundle/i);
    expect(ledger).toContain("Publish only the O7 capability summary");
    expect(ledger).toContain("hiding artifact commitment");
    const publicBrief = readFileSync(join(root, "docs/evidence/ws-e/07-public-review-and-self-hosting.md"), "utf8");
    expect(publicBrief).toContain('"commitment": "<64 lowercase hexadecimal SHA-256 characters>"');
    expect(publicBrief).toContain("32-byte owner-held random nonce");
    expect(publicBrief).not.toContain('"digest": "<64 lowercase hexadecimal SHA-256 characters>"');
    const replayBrief = readFileSync(join(root, "docs/evidence/ws-e/05-replay-syntax.md"), "utf8");
    expect(replayBrief).toContain("Product Ledger command C11");
    expect(replayBrief).toContain("Product Ledger contradiction C13/LR-018");
    expect(deletionBrief).toContain("decision O6, guarantee G10, and command C13");
    expect(ledger).toMatch(/data-learning-id="DF-035"[^>]+data-learning-source="evidence\/ws-e\/07-public-review-and-self-hosting\.md"/);
    const df048 = ledger.match(/<tr data-learning-id="DF-048"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(df048).toContain("Round 2 defers curl; no installer enters WS2");
    expect(df048).not.toContain("if it reduces clean-room failure");
    const lr006 = ledger.match(/<tr data-learning-id="LR-006"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(lr006).toContain('href="evidence/ws-e/01-package-install-identity.md"');
    expect(lr006).toContain('href="evidence/ws1-core-history.json"');
    expect(lr006).toContain('href="evidence/ws1-release-baseline.json"');
    const faq = readFileSync(join(root, "docs/faq.md"), "utf8");
    expect(faq).toMatch(/guard field\s+names and literal values as public/);
    expect(ledger).toMatch(/data-deliverable-key="PD-00B"[^>]+data-deliverable-parent="WS0"/);
    expect(ledger).toMatch(/data-index-key="WS1"[^>]+data-index-last-verified="2026-08-01 · Pi release proof"/);
    const c10 = ledger.match(/<details class="command" data-command-key="C10"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(c10).toContain("owner-only mode-0600 NDJSON");
    expect(c10).toContain('href="evidence/ws-e/05-replay-syntax.md"');
    expect(ledger).toContain("WS-E decision evidence briefs 1–7");
    expect(ledger).not.toMatch(/proposed (?:Product Ledger )?contract v0\.1/i);
    expect(ledger).toContain("Approved Product Ledger · approved contract v0.1");
    const restamped = {
      index: ["WS2", "M-DF2"],
      experience: ["EW1", "EW2", "EW3", "EW4", "EW5", "EW6"],
      command: ["C02", "C03", "C04", "C05", "C06", "C07", "C09", "C10", "C11", "C13"],
      guarantee: ["G08", "G10", "G11", "G13", "G14"],
      deliverable: ["ID-06", "ID-07", "ID-08", "PD-01", "PD-02", "PD-03", "PD-04"],
      interface: ["SI5"],
    } as const;
    for (const [kind, keys] of Object.entries(restamped)) {
      for (const key of keys) expect(ledger).toMatch(new RegExp(
        `data-${kind}-key="${key}"[^>]+data-${kind}-last-verified="2026-08-01 · WS-E evidence"`,
      ));
    }
  });
});
