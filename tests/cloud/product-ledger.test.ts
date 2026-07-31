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

describe("Angel Product Ledger", () => {
  test("is the single plan of record while the APRD remains unapproved", () => {
    expect(roadmap).toContain("[Angel Product Ledger](docs/product-ledger.html)");
    expect(roadmap).toContain("proposed, not approved");
    expect(roadmap).not.toContain("This file is the canonical plan of record");
    expect(aprdReadme).toContain(
      "The [Angel Product Ledger](../product-ledger.html) owns the final goal, roadmap,",
    );
    expect(aprdReadme).toContain("**not approved for implementation**");
    expect(aprd).toContain("Do not build from this draft.");
    expect(aprd).toContain('href="../product-ledger.html"');
  });

  test("keeps the next milestone proposed and names its only current blocker", () => {
    expect(ledger).toContain('data-next-status="proposed-not-approved"');
    expect(ledger).toContain('data-next-milestone="P0"');
    expect(ledger).toContain("P0 — Monorepo and release integrity");
    expect(ledger).toContain("Blocking:</strong> O1");
    expect(ledger).toContain("No auth, OAuth, policy, runtime authorization, route, provider, or UX redesign.");
    expect(ledger).toContain("Correct stale docs or displayed commands only when they contradict shipped behavior");
  });

  test("defines the complete milestone path and fourteen lasting guarantees", () => {
    expect(values(/data-milestone-id="([^"]+)"/g)).toEqual([
      "FOUNDATION",
      "L0",
      "P0",
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "P6",
    ]);
    expect(values(/data-guarantee-id="([^"]+)"/g)).toEqual(
      Array.from({ length: 14 }, (_, index) => `G${String(index + 1).padStart(2, "0")}`),
    );
    expect(values(/data-surface-job="([^"]+)"/g)).toEqual([
      "learn",
      "create",
      "connect",
      "run-local",
      "publish-verify",
      "call-audit",
      "manage",
    ]);
    expect(ledger).toContain("exe.dev first, then untouched Neo Mac");

    for (const proof of [
      "verify:phase0",
      "angel-e2e local --clean",
      "angel-e2e cloud --clean",
      "Fresh-account browser and phone E2E",
      "Clean self-host deploy",
    ]) {
      expect(ledger).toContain(proof);
    }
  });

  test("reconciles every dogfood and post-report learning exactly once", () => {
    const ids = values(/data-learning-id="([^"]+)"/g);
    expect(ids).toHaveLength(96);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith("DF-"))).toEqual(
      Array.from({ length: 68 }, (_, index) => `DF-${String(index + 1).padStart(3, "0")}`),
    );
    expect(ids.filter((id) => id.startsWith("LR-"))).toEqual(
      Array.from({ length: 28 }, (_, index) => `LR-${String(index + 1).padStart(3, "0")}`),
    );
  });

  test("has zero orphans and only valid dispositions and destinations", () => {
    expect(ledger).toContain('data-orphan-count="0"');
    expect(ledger).not.toContain('data-disposition="orphan"');

    const rows = [...ledger.matchAll(
      /data-learning-id="([^"]+)" data-disposition="([^"]+)" data-destination="([^"]+)"/g,
    )];
    expect(rows).toHaveLength(96);

    const validDispositions = new Set(["included", "proposed", "deferred", "rejected", "unresolved"]);
    const validDestinations = new Set([
      "FOUNDATION", "L0", "P0", "P1", "P2", "P3", "P4", "P5", "P6", "NONE",
      "O1", "O2", "O3", "O4", "O5", "O6", "O7", "O8",
    ]);
    for (const row of rows) {
      const disposition = row[2] ?? "";
      const destination = row[3] ?? "";
      expect(validDispositions.has(disposition)).toBe(true);
      expect(validDestinations.has(destination)).toBe(true);
      if (disposition === "included") expect(["FOUNDATION", "L0"].includes(destination)).toBe(true);
      if (disposition === "proposed") expect(destination).toBe("P0");
      if (disposition === "deferred") expect(["P1", "P2", "P3", "P4", "P5", "P6"].includes(destination)).toBe(true);
      if (disposition === "rejected") expect(destination).toBe("NONE");
      if (disposition === "unresolved") expect(destination.startsWith("O")).toBe(true);
    }

    const dispositions = rows.map((row) => row[2]);
    expect(dispositions.filter((value) => value === "included")).toHaveLength(15);
    expect(dispositions.filter((value) => value === "proposed")).toHaveLength(8);
    expect(dispositions.filter((value) => value === "deferred")).toHaveLength(60);
    expect(dispositions.filter((value) => value === "rejected")).toHaveLength(6);
    expect(dispositions.filter((value) => value === "unresolved")).toHaveLength(7);
  });

  test("names every decision horizon and every contradiction", () => {
    expect(values(/data-decision-id="([^"]+)"/g)).toEqual(
      Array.from({ length: 8 }, (_, index) => `O${index + 1}`),
    );
    const contradictions = [...ledger.matchAll(
      /data-contradiction-id="(C\d+)" data-state="([^"]+)"/g,
    )];
    expect(contradictions).toHaveLength(15);
    expect(contradictions.filter((row) => row[2] === "Open")).toHaveLength(7);
    expect(ledger).toContain("A build milestone cannot start with an open decision or contradiction that affects that milestone.");
  });

  test("keeps reduced scope visible in named future milestones", () => {
    for (const text of [
      "The old all-in-one v2.1 is split into P1 local and P2 managed proofs.",
      "Browser/mobile authoring stays visible in P3.",
      "Provider breadth and hosted verified OAuth move to P4.",
      "Catalog/sharing/self-hosting move to P5.",
      "Multiplayer remains P6.",
    ]) {
      expect(ledger).toContain(text);
    }
  });
});
