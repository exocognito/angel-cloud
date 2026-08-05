import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { renderProductLedgerVnext, validateProductLedgerVnext } from "../../scripts/render-product-ledger-vnext";

const root = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const dataroomPath = "datarooms/angel-cloud-vnext.json";
const outputPath = "docs/proposals/product-ledger-vnext.html";

const dataroom = JSON.parse(read(dataroomPath));
const canonical = read("docs/product-ledger.html");
const output = read(outputPath);

describe("proposed Angel Product Ledger vNext", () => {
  test("is explicitly proposed and depends on the v0.2 skill PR", () => {
    expect(dataroom.$schema).toBe("product-ledger/proposed-v0.2-roadmap-bridge");
    expect(dataroom.contract.status).toBe("PROPOSED");
    expect(dataroom.contract.approved).toBe(false);
    expect(dataroom.contract.dependency).toBe("https://github.com/exocognito/dotfiles/pull/318");
    expect(output).toContain("PROPOSED · UNAPPROVED");
    expect(output).toContain("dotfiles PR #318");
  });

  test("uses one lossless central source for every approved v0.1 section and control", () => {
    expect(dataroom.canonicalSource.html).toBe(canonical);
    expect(dataroom.canonicalSource.sha256).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(dataroom.canonicalSource.sectionIds).toEqual([...canonical.matchAll(/<section id="([^"]+)"/g)].map((match) => match[1]));
    expect(Object.values(dataroom.canonicalSource.controlInventory).flat()).toHaveLength(219);
  });

  test("rejects a dataroom that drops a gate or confuses Feature and Task proof", () => {
    expect(() => validateProductLedgerVnext({ ...dataroom, roadmap: [{ ...dataroom.roadmap[0], gate: null }] }))
      .toThrow("needs its exact owner gate");
    const epic = structuredClone(dataroom.roadmap.find((row: any) => row.work.length > 0));
    epic.work[0].kind = "Task";
    expect(() => validateProductLedgerVnext({ ...dataroom, roadmap: [epic] }))
      .toThrow("needs the right proof type");
  });

  test("recuts WS2 into five owner-outcome Epics with a gate after each", () => {
    const active = dataroom.roadmap.filter((row: any) => row.key.startsWith("WS2."));
    expect(active.map((row: any) => row.key)).toEqual(["WS2.1", "WS2.2", "WS2.3", "WS2.4", "WS2.5"]);
    for (const epic of active) {
      expect(epic.role).toBe("Epic");
      expect(epic.mapsTo).toContain("WS2");
      expect(epic.gate.key).toBe(`GATE-${epic.key}`);
      expect(epic.gate.proof.toLowerCase()).toContain("dogfood");
      expect(epic.work.length).toBeGreaterThan(0);
      for (const work of epic.work) {
        expect(["Feature", "Task"]).toContain(work.kind);
        expect(work.proof).toContain(work.kind === "Feature" ? "Feature dogfood" : "Task smoke");
        expect(work.mapsTo.length).toBeGreaterThan(0);
      }
    }
  });

  test("preserves every canonical section and non-index product-control record", () => {
    const sectionIds = [...canonical.matchAll(/<section id="([^"]+)"/g)].map((match) => match[1]);
    for (const id of sectionIds) expect(output).toContain(`<section id="${id}"`);

    const attrs = [
      "data-deliverable-key", "data-scenario-key", "data-guarantee-key",
      "data-experience-key", "data-machinery-key", "data-interface-key",
      "data-command-key", "data-decision-key", "data-contradiction-key",
      "data-learning-id",
    ];
    for (const attr of attrs) {
      const keys = [...canonical.matchAll(new RegExp(`${attr}="([^"]+)"`, "g"))].map((match) => match[1]);
      expect(keys.length, attr).toBeGreaterThan(0);
      for (const key of keys) expect(output).toContain(`${attr}="${key}"`);
    }
  });

  test("renders the polished index with native controls and separate statuses", () => {
    expect(output).toContain("data-roadmap-list");
    expect(output).toContain("<details");
    expect(output).toContain("<summary");
    expect(output).not.toContain('role="button"');
    for (const attr of ["data-truth-state", "data-plan-state", "data-approval-state"]) {
      expect(output).toContain(attr);
    }
    expect(output).toContain("prefers-reduced-motion");
    expect(output).toContain("@media (max-width: 640px)");
    expect(output).toContain("document.querySelectorAll('#project-index details')");
  });

  test("preserves every canonical evidence link exactly, rebased only for the proposal directory", () => {
    const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!);
    const outputCounts = new Map<string, number>();
    for (const href of hrefs(output)) outputCounts.set(href, (outputCounts.get(href) ?? 0) + 1);
    const expectedCounts = new Map<string, number>();
    for (const href of hrefs(canonical)) {
      const expected = href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `../${href}`;
      expectedCounts.set(expected, (expectedCounts.get(expected) ?? 0) + 1);
    }
    for (const [href, count] of expectedCounts) expect(outputCounts.get(href) ?? 0, href).toBeGreaterThanOrEqual(count);
  });

  test("keeps every repository-relative evidence link valid from the proposal directory", () => {
    const relativeLinks = [...output.matchAll(/href="([^"]+)"/g)]
      .map((match) => match[1]!)
      .filter((href) => !href.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(href));
    expect(relativeLinks.length).toBeGreaterThan(0);
    for (const href of relativeLinks) {
      const path = href.split("#", 1)[0]!;
      expect(existsSync(resolve(root, dirname(outputPath), path)), href).toBe(true);
    }
  });

  test("embeds the exact dataroom and regenerates byte for byte", () => {
    const embedded = output.match(/<script id="vnext-dataroom" type="application\/json">\n([\s\S]*?)\n<\/script>/)?.[1];
    expect(embedded).toBeDefined();
    expect(JSON.parse(embedded ?? "")).toEqual(dataroom);
    expect(renderProductLedgerVnext(dataroom)).toBe(output);
  });
});
