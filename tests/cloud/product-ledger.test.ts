import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const ledger = readFileSync(
  new URL("../../docs/product-ledger.html", import.meta.url),
  "utf8",
);
const roadmap = readFileSync(
  new URL("../../ROADMAP.md", import.meta.url),
  "utf8",
);
const aprdReadme = readFileSync(
  new URL("../../docs/aprd/README.md", import.meta.url),
  "utf8",
);
const aprd = readFileSync(
  new URL("../../docs/aprd/angel-cloud-aprd.html", import.meta.url),
  "utf8",
);

function values(pattern: RegExp): string[] {
  return [...ledger.matchAll(pattern)].map((match) => match[1] ?? "");
}

describe("Angel Product Ledger v2", () => {
  test("is the sole product-control source while build remains unapproved", () => {
    expect(roadmap).toContain("[Angel Product Ledger](docs/product-ledger.html)");
    expect(roadmap).toContain("proposed, not approved");
    expect(roadmap).not.toContain("This file is the canonical plan of record");
    expect(aprdReadme).toContain(
      "The [Angel Product Ledger](../product-ledger.html) owns the final goal, roadmap,",
    );
    expect(aprdReadme).toContain("**not approved for implementation**");
    expect(aprd).toContain("Do not build from this draft.");
    expect(ledger).toContain('data-next-milestone-status="unapproved"');
    expect(ledger).toContain("Dogfood Round 2 and its build workstream are <strong>not approved</strong>");
  });

  test("opens with a dashboard that reports progress without a fake percentage", () => {
    expect(ledger).toContain("0 · Progress dashboard");
    expect(ledger).toContain("Not yet</b><span>final goal demonstrated");
    expect(ledger).toContain("WS1</b><span>active: Get organized");
    expect(ledger).toContain("M2</b><span>next: Dogfood Round 2");
    expect(ledger).toContain("0 / 2</b><span>deploy paths proved: local + managed");
    expect(ledger).toContain("Current approval gates:");
    expect(ledger).toContain("O8 blocks approval of this path");
    expect(ledger).toContain('data-orphan-count="0"');
    expect(ledger).not.toMatch(/\b\d{1,3}%\b/);
  });

  test("uses the owner workstream and dogfood hierarchy", () => {
    expect(values(/data-workstream-id="([^"]+)"/g)).toEqual([
      "FOUNDATION",
      "WS0",
      "WS1",
      "WS2",
      "M2",
      "WS3",
      "LATER",
    ]);
    for (const text of [
      "Learn from Dogfood Round 1",
      "Get organized",
      "Build for Dogfood Round 2",
      "Dogfood Round 2",
      "Build for Dogfood Round 3",
      "shaped by M2",
    ]) {
      expect(ledger).toContain(text);
    }
    expect(ledger).not.toContain('data-workstream-id="P0"');
  });

  test("shows every planned internal, product, and milestone deliverable", () => {
    const ids = values(/data-deliverable-id="([^"]+)"/g);
    expect(ids).toEqual([
      "INT-01", "INT-02", "INT-03", "INT-04", "INT-05", "INT-06",
      "PD-01", "PD-02", "PD-03", "PD-04", "PD-05", "INT-07", "INT-08",
      "M2-01", "M2-02", "M2-03", "M2-04",
    ]);
    expect(ledger).toContain("Product Ledger v2");
    expect(ledger).toContain("Monorepo migration");
    expect(ledger).toContain("Local First Angel");
    expect(ledger).toContain("Managed Angel");
    expect(ledger).toContain("Max-agent journey");
    expect(ledger).toContain("Read-only www");
    expect(ledger).toContain("Dogfood guide and evidence package");
    expect(ledger).toContain("Needs O1 for package release");
    expect(ledger).toContain("public package name, npm provenance, and external registry-tarball proof wait on O1");
  });

  test("adds owner scenarios and a human meaning plus boundary to every guarantee", () => {
    expect(values(/data-scenario-id="([^"]+)"/g)).toEqual(["S1", "S2", "S3"]);
    expect(ledger).toContain("The fresh first Angel");
    expect(ledger).toContain("Draft, never send");
    expect(ledger).toContain("A useful multi-App assistant");
    expect(values(/data-guarantee-id="([^"]+)"/g)).toEqual(
      Array.from({ length: 14 }, (_, index) => `G${String(index + 1).padStart(2, "0")}`),
    );
    expect([...ledger.matchAll(/<strong>What this means to Sam<\/strong>/g)]).toHaveLength(14);
    expect([...ledger.matchAll(/<strong>Current evidence<\/strong>/g)]).toHaveLength(14);
    expect([...ledger.matchAll(/data-current-evidence=/g)]).toHaveLength(14);
    expect([...ledger.matchAll(/class="guarantee"/g)]).toHaveLength(14);
    expect(ledger).toContain("G01 · Angel is a toolbox, never an actor");
    expect(ledger).toContain("G14 · Source and deploy topology stay bounded");
    expect([...ledger.matchAll(/<strong>Destination<\/strong>/g)]).toHaveLength(3);
    expect([...ledger.matchAll(/<strong>Proof<\/strong>/g)]).toHaveLength(3);
    expect([...ledger.matchAll(/<strong>Guarantees<\/strong>/g)]).toHaveLength(3);
  });

  test("keeps Round 2 narrow across CLI, max-agent, read-only www, and human handoffs", () => {
    expect(values(/data-surface-job="([^"]+)"/g)).toEqual([
      "start", "create", "connect", "local", "managed", "recover",
    ]);
    expect(ledger).toContain("CLI user");
    expect(ledger).toContain("Max-agent user");
    expect(ledger).toContain("www</th><th>Human-only step");
    expect(ledger).toContain("View source/policy only");
    expect(ledger).toContain("Not this surface");
    expect(ledger).toContain("Human authentication, consent, and final inspection stay human");
  });

  test("reconciles dogfood, trust, and owner-feedback sources exactly once", () => {
    const ids = values(/data-learning-id="([^"]+)"/g);
    expect(ids).toHaveLength(108);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith("DF-"))).toEqual(
      Array.from({ length: 68 }, (_, index) => `DF-${String(index + 1).padStart(3, "0")}`),
    );
    expect(ids.filter((id) => id.startsWith("LR-"))).toEqual(
      Array.from({ length: 28 }, (_, index) => `LR-${String(index + 1).padStart(3, "0")}`),
    );
    expect(ids.filter((id) => id.startsWith("FB-"))).toEqual(
      Array.from({ length: 12 }, (_, index) => `FB-${String(index + 1).padStart(3, "0")}`),
    );
  });

  test("has zero orphans and valid workstream destinations", () => {
    expect(ledger).not.toContain('data-disposition="orphan"');
    const rows = [...ledger.matchAll(
      /data-learning-id="([^"]+)" data-disposition="([^"]+)" data-destination="([^"]+)"/g,
    )];
    expect(rows).toHaveLength(108);
    const validDispositions = new Set(["included", "proposed", "deferred", "rejected", "unresolved"]);
    const validDestinations = new Set([
      "FOUNDATION", "WS0", "WS1", "WS2", "M2", "WS3", "LATER", "NONE",
      "O1", "O2", "O3", "O4", "O5", "O6", "O7", "O8", "O9",
    ]);
    for (const row of rows) {
      const disposition = row[2] ?? "";
      const destination = row[3] ?? "";
      expect(validDispositions.has(disposition)).toBe(true);
      expect(validDestinations.has(destination)).toBe(true);
      if (disposition === "included") expect(["FOUNDATION", "WS0", "WS1"].includes(destination)).toBe(true);
      if (disposition === "proposed") expect(["WS1", "WS2", "M2"].includes(destination)).toBe(true);
      if (disposition === "deferred") expect(["WS3", "LATER"].includes(destination)).toBe(true);
      if (disposition === "rejected") expect(destination).toBe("NONE");
      if (disposition === "unresolved") expect(destination.startsWith("O")).toBe(true);
    }
    const dispositions = rows.map((row) => row[2] ?? "");
    expect(dispositions.filter((value) => value === "included")).toHaveLength(24);
    expect(dispositions.filter((value) => value === "proposed")).toHaveLength(47);
    expect(dispositions.filter((value) => value === "deferred")).toHaveLength(29);
    expect(dispositions.filter((value) => value === "rejected")).toHaveLength(0);
    expect(dispositions.filter((value) => value === "unresolved")).toHaveLength(8);
  });

  test("uses GitHub Issues for execution without creating a second roadmap", () => {
    expect(ledger).toContain("GitHub Issues</h3>");
    expect(ledger).toContain("Durable backlog, bugs, investigations, priority, assignee, and cross-session execution state");
    expect(ledger).toContain("An Issue may be product-significant; it is not allowed to become a second roadmap.");
    expect(ledger).toContain("update the Ledger in the same PR when an Issue changes");
    expect(ledger).toContain("adding Linear is unnecessary");
  });

  test("keeps self-hosting honest and asks for evidence before owner choices", () => {
    expect(ledger).toContain("currently unsupported and unproved");
    expect(ledger).toContain("no setup instructions without clean-room proof");
    expect(ledger).toContain("O1–O7 are evidence briefs, not questions Sam must answer from intuition");
    expect(values(/data-decision-id="([^"]+)"/g)).toEqual(
      Array.from({ length: 9 }, (_, index) => `O${index + 1}`),
    );
    const contradictions = [...ledger.matchAll(
      /data-contradiction-id="(C\d+)" data-state="([^"]+)"/g,
    )];
    expect(contradictions).toHaveLength(15);
    expect(contradictions.filter((row) => row[2] === "Open")).toHaveLength(7);
  });
});
