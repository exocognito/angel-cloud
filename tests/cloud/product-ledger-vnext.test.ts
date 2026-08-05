import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
    const committed = execFileSync("git", ["show", `${dataroom.canonicalSource.commit}:docs/product-ledger.html`], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    expect(createHash("sha256").update(committed).digest("hex")).toBe(dataroom.canonicalSource.sha256);
  });

  test("rejects malformed gates, proof types, states, duplicate work, and unsafe evidence", () => {
    expect(() => validateProductLedgerVnext({ ...dataroom, roadmap: [{ ...dataroom.roadmap[0], gate: null }] }))
      .toThrow("needs its exact owner gate");
    const wrongProof = structuredClone(dataroom);
    wrongProof.roadmap.find((row: any) => row.work.length > 0).work[0].kind = "Task";
    expect(() => validateProductLedgerVnext(wrongProof)).toThrow("needs the right proof type");
    const unaccepted = structuredClone(dataroom);
    unaccepted.roadmap.find((row: any) => row.plan === "COMPLETE").gate.accepted = false;
    expect(() => validateProductLedgerVnext(unaccepted)).toThrow("completed approved gate must be accepted");
    const invalidState = structuredClone(dataroom);
    invalidState.roadmap[0].plan = "COMPLETED";
    expect(() => validateProductLedgerVnext(invalidState)).toThrow("invalid state");
    const duplicate = structuredClone(dataroom);
    const rows = duplicate.roadmap.flatMap((row: any) => row.work);
    rows[1].key = rows[0].key;
    expect(() => validateProductLedgerVnext(duplicate)).toThrow("work key must be unique");
    const unsafe = structuredClone(dataroom);
    unsafe.roadmap[0].gate.evidence.href = "javascript:alert(1)";
    expect(() => validateProductLedgerVnext(unsafe)).toThrow("needs safe evidence");
  });

  test("recuts WS2 into five owner-outcome Epics with a gate after each", () => {
    const active = dataroom.roadmap.filter((row: any) => row.key.startsWith("WS2."));
    expect(active.map((row: any) => row.key)).toEqual(["WS2.1", "WS2.2", "WS2.3", "WS2.4", "WS2.5"]);
    const ws2Deliverables = ["ID-06", "PD-01", "PD-02", "PD-03", "PD-04", "PD-05", "ID-07", "ID-08"];
    const mappedWork = new Set(active.flatMap((epic: any) => epic.work.flatMap((work: any) => work.mapsTo)));
    for (const key of ws2Deliverables) expect(mappedWork.has(key), key).toBe(true);
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
        expect(work.mapsTo.every((key: string) => epic.mapsTo.includes(key))).toBe(true);
        expect(work.claim).not.toBe(work.title);
        expect(work.blockers).not.toBe("Named by the owning Epic gate.");
        expect(work.evidence.href).not.toContain("docs/product-ledger.html");
        expect(canonical).toContain(work.verified);
      }
    }
    for (const epic of dataroom.roadmap.filter((row: any) => row.plan === "COMPLETE")) expect(epic.gate.accepted).toBe(true);
    for (const commitment of dataroom.roadmap.flatMap((row: any) => row.commitments)) {
      expect(canonical.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain(commitment.limit);
      expect(canonical).toContain(commitment.verified);
      expect(commitment.evidence.href).not.toContain("docs/product-ledger.html");
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
    expect(output).toContain("<title>Angel Product Ledger — proposed vNext</title>");
    expect(output).toContain('data-proposal-contract-version="proposed-v0.2"');
    const rendered = output.slice(0, output.indexOf('<script id="vnext-dataroom"'));
    const roadmapKeys = [...rendered.matchAll(/data-roadmap-key="([^"]+)"/g)].map((match) => match[1]);
    const legacyKeys = [...rendered.matchAll(/data-index-key="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(roadmapKeys).size).toBe(roadmapKeys.length);
    expect(new Set(legacyKeys).size).toBe(legacyKeys.length);
    for (const href of new Set([...canonical.matchAll(/href="#(index-[^"]+)"/g)].map((match) => match[1]))) {
      expect(rendered).toContain(`<details id="${href}" class="vnext-epic"`);
    }
    expect([...rendered.matchAll(/id="index-[^"]+"/g)]).toHaveLength(dataroom.roadmap.length);
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

  test("escapes mixed-case script terminators in the embedded dataroom", () => {
    const unsafe = structuredClone(dataroom);
    unsafe.product.name = "Angel </SCRIPT><img src=x>";
    const rendered = renderProductLedgerVnext(unsafe);
    const embedded = rendered.match(/<script id="vnext-dataroom" type="application\/json">\n([\s\S]*?)\n<\/script>/)?.[1];
    expect(embedded).toContain("<\\/SCRIPT>");
    expect(JSON.parse(embedded ?? "").product.name).toBe(unsafe.product.name);
  });

  test("embeds the exact dataroom and regenerates byte for byte", () => {
    const embedded = output.match(/<script id="vnext-dataroom" type="application\/json">\n([\s\S]*?)\n<\/script>/)?.[1];
    expect(embedded).toBeDefined();
    expect(JSON.parse(embedded ?? "")).toEqual(dataroom);
    expect(renderProductLedgerVnext(dataroom)).toBe(output);
  });
});
