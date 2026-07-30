import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const html = readFileSync(
  new URL("../../docs/aprd/angel-cloud-aprd.html", import.meta.url),
  "utf8",
);

function count(pattern: RegExp): number {
  return [...html.matchAll(pattern)].length;
}

describe("APRD v2", () => {
  test("keeps the agreed structure and puts phasing last", () => {
    const headings = [
      "0 · Terminology",
      "1 · Flagship statement",
      "2 · Goals map",
      "3 · Demonstrable commitments",
      "4 · The stations, long form",
      "5 · System diagram",
      "6 · Non-goals and deliberately-not-verified",
      "7 · Open questions",
      "8 · Implementation phasing",
    ];
    let cursor = -1;
    for (const heading of headings) {
      const next = html.indexOf(heading);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }

    const phasing = html.indexOf("8 · Implementation phasing");
    expect(html.indexOf('<span class="phase-chip')).toBeGreaterThan(phasing);
    expect(html).toContain("The map in §2 is the complete design.");
    expect(html).toContain("Scope shrinks by choosing a subset to build — never by cutting the map");
  });

  test("maps ten linked stations across all three surfaces", () => {
    expect(count(/href="#s(?:10|[1-9])"/g)).toBe(10);
    expect(count(/id="s(?:10|[1-9])"/g)).toBe(10);
    expect(html).toContain("grid-template-columns: 118px 1fr 1fr 1fr");

    for (const target of html.matchAll(/href="#([^"]+)"/g)) {
      expect(html).toContain(`id="${target[1]}"`);
    }
  });

  test("grades commitments against the pinned branch commit", () => {
    expect(html).toContain("main@faf4beb");
    expect(html).toContain("● 20 green");
    expect(html).toContain("● 1 yellow");
    expect(html).toContain("● 6 orange");
    expect(html).toContain("● 2 red");
    expect(count(/class="card g"/g)).toBe(20);
    expect(count(/class="card y"/g)).toBe(1);
    expect(count(/class="card o"/g)).toBe(6);
    expect(count(/class="card r"/g)).toBe(2);
  });

  test("carries the four new trust commitments without breaking redaction", () => {
    for (const title of [
      "Anchored receipt tail",
      "Engine pinned per angel",
      "Behavior spot-checkable by replay",
      "The trust boundary is stated, not implied",
    ]) {
      expect(html).toContain(`<h4>${title}</h4>`);
    }
    expect(html).toContain("Receipt <code>sequence</code> and <code>hash</code> become agent-facing in v2");
    expect(html).not.toContain("chain hashes appear on no agent-facing surface");
    expect(html).toContain("execution is trusted, bounded by replay");
  });

  test("records the code-grounded map regrades", () => {
    expect(html).toContain('text-amber-600">angels:create → new:CharterEditor');
    expect(html).toContain('text-amber-600">[slug]:Publish → hero result');
    expect(html).toContain('text-amber-600">[slug]:PolicyEditor');
    expect(html).not.toContain('text-emerald-700">[slug]:ToolRow.toggle');
    expect(html).toContain('text-emerald-700">[slug]:KeysPanel.New → Revoke');
    expect(html).toContain('text-amber-600">angel keys new|revoke');
    expect(html).toContain("sends <span class=\"font-mono\">pause_tool</span> / <span class=\"font-mono\">resume_tool</span>");
  });

  test("keeps the CLI-first phase coherent with its human web steps", () => {
    expect(html).toContain('<span class="phase-chip p21">v2.1</span> MagicLinkForm + Better Auth (required by CLI login)');
    expect(html).toContain('<span class="phase-chip p22">v2.2</span> PolicyEditor: charter · tools · guards');
    expect(html).toContain('<span class="phase-chip pdone">done</span> KeysPanel New → Revoke');
    expect(html).not.toContain('<span class="phase-chip pdone">done</span> toggle');
  });

  test("pins the reproducible digest and explains the newline footgun", () => {
    expect(html).toContain("a004a3a3e1b06092…6eecdc5a");
    expect(html).toContain("canonical bytes <em>without</em> a trailing newline");
    expect(html).toContain("a naive <span class=\"font-mono text-sm\">shasum</span>");
  });

  test("marks only the actual system additions as future", () => {
    expect(html).toContain('BA["Better Auth<br/>D1 storage · email links"]');
    expect(html).toContain("class SRV,BA change");
    expect(html).not.toContain("class SRV,C change");
  });

  test("keeps the flagship wording visibly open", () => {
    expect(html).toContain("DRAFT — wording awaits Sam's sign-off");
    expect(html).toContain("The sentence is draft because “charter allows” is plain speech while the policy is the only authority");
    expect(html).toContain("Final flagship sentence wording — §1 is a draft until Sam approves it.");
  });
});
