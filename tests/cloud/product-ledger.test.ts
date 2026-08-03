import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { headingSlugs } from "./markdown-slugs";

const ledgerUrl = new URL("../../docs/product-ledger.html", import.meta.url);
const ledger = readFileSync(ledgerUrl, "utf8");
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

const values = (pattern: RegExp): string[] =>
  [...ledger.matchAll(pattern)].map((match) => match[1] ?? "");

const count = (text: string): number => ledger.split(text).length - 1;
const htmlSection = (id: string): string => {
  const start = ledger.indexOf(`<section id="${id}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = ledger.indexOf("<section id=", start + 1);
  return end === -1 ? ledger.slice(start) : ledger.slice(start, end);
};
const recordBlocks = (tag: string, attribute: string): string[] =>
  [...ledger.matchAll(new RegExp(
    `<${tag}[^>]*${attribute}="[^"]+"[^>]*>[\\s\\S]*?</${tag}>`,
    "g",
  ))].map((match) => match[0]);

const truthStates = new Set(["LIVE", "PARTIAL", "BROKEN", "NOT BUILT"]);
const planStates = new Set(["COMPLETE", "ACTIVE", "NEXT", "BLOCKED", "LATER"]);

function expectAllAllowed(valuesToCheck: string[], allowed: Set<string>) {
  for (const value of valuesToCheck) expect(allowed.has(value)).toBe(true);
}

describe("Angel Product Ledger contract v0.1 application", () => {
  test("records approval of contract v0.1, this Ledger, and WS1 only", () => {
    expect(roadmap).toContain("[Angel Product Ledger](docs/product-ledger.html)");
    expect(roadmap).toContain("WS-E is active");
    expect(roadmap).toContain("evidence-only approval covers WS-E");
    expect(roadmap).toContain("**WS2 and Dogfood Round 2**");
    expect(roadmap).toContain("remain proposed and unapproved");
    expect(aprdReadme).toContain(
      "The [Angel Product Ledger](../product-ledger.html) owns the final goal, roadmap,",
    );
    expect(aprdReadme).toContain("**not approved for implementation**");
    expect(aprd).toContain("Do not build from this draft.");
    expect(ledger).toContain('data-contract-version="approved-v0.1"');
    expect(ledger).toContain('data-ledger-approval="APPROVED"');
    expect(ledger).toContain('data-current-workstream="WS-E"');
    expect(ledger).toContain('data-current-workstream-status="ACTIVE"');
    expect(ledger).toContain('data-product-work-approval="WS1"');
    expect(ledger).toContain('data-evidence-work-approval="WS-E"');
    expect(ledger).toContain('data-approved-sequence="WS1&gt;WS-E&gt;O10&gt;WS2&gt;M-DF2"');
    expect(ledger).toContain('data-mobile-qa-width="390"');
    expect(ledger).toContain('data-mobile-qa-scroll-width="390"');
    expect(ledger).toContain('data-next-milestone-status="unapproved"');
    expect(ledger).toContain("Approved 2026-08-01");
    expect(ledger).toContain("https://github.com/exocognito/angelmcp/pull/43#issuecomment-5152622328");
    expect(ledger).toContain("Product/repository approval: WS1, now complete. Evidence-only approval: WS-E, now active. O1 is the exact closure gap; O10 waits.");
    expect(ledger).toContain("WS2 and M-DF2 remain proposed and blocked by O10");
    expect(ledger).not.toContain("No Angel product build is approved");
  });

  test("opens with one compact expandable path instead of dashboard cards", () => {
    const keys = values(/data-index-key="([^"]+)"/g);
    expect(keys).toEqual([
      "M0", "M1", "WS0", "M-DF1", "WS1", "WS-E", "WS2", "M-DF2", "WS3", "WS4",
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(values(/data-index-plan="(ACTIVE|NEXT)"/g)).toEqual(["ACTIVE"]);
    expect(ledger).toMatch(
      /data-index-key="WS1" data-index-plan="COMPLETE" data-index-approval="APPROVED"/,
    );
    expect(ledger).toMatch(
      /data-index-key="WS-E" data-index-plan="ACTIVE" data-index-approval="APPROVED"/,
    );
    expect(ledger).toContain("Seven briefs exist. WS-E changed no product behavior");
    expect(ledger).toContain("WS-E authorizes no product implementation");
    const ws2 = recordBlocks("details", "data-index-key")
      .find((block) => block.includes('data-index-key="WS2"')) ?? "";
    expect(ws2).toContain('href="https://github.com/exocognito/angelmcp/blob/main/docs/aprd/v2.1-generative-evals.md"');
    expect(ws2).toContain(">Generative eval draft</a>");
    expect(count('<details id="index-')).toBe(keys.length);
    const validProjectKeys = new Set([...keys, ...values(/data-deliverable-key="([^"]+)"/g)]);
    for (const block of recordBlocks("details", "data-index-key")) {
      const linked = block.match(/<strong>Linked rows<\/strong><div>(.*?)<\/div>/)?.[1] ?? "";
      if (linked.startsWith("N/A —")) continue;
      for (const key of linked.split(/\s*→\s*/)) expect(validProjectKeys.has(key)).toBe(true);
    }
    expect(ledger).toContain("Project Index");
    expect(ledger).toContain("Expand all");
    expect(ledger).toContain("Collapse all");
    const index = htmlSection("project-index");
    for (const field of [
      "Measurable goal",
      "Essential deliverables",
      "Blocking evals",
      "Dependencies and open decisions",
      "Artifact links",
      "Completion evidence",
      "Linked rows",
      "Last verified",
    ]) {
      expect(index.split(`<strong>${field}</strong>`).length - 1).toBe(keys.length);
    }
    expect(ledger).not.toContain("Progress dashboard");
    expect(ledger).not.toContain('class="summary"');
    expect(ledger).not.toContain('class="progress-path"');
    expect(ledger).not.toMatch(/\b\d{1,3}%\b/);
  });

  test("shows every essential product and internal deliverable with the data spine", () => {
    const ids = values(/data-deliverable-key="([^"]+)"/g);
    expect(ids).toEqual([
      "PD-00A", "PD-00B",
      "ID-01", "ID-02", "ID-03", "ID-04",
      "ID-05", "ID-06", "PD-01", "PD-02", "PD-03", "PD-04", "PD-05", "ID-07", "ID-08",
      "ID-09", "PD-06", "PD-07", "ID-10",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["ID-01", "ID-02", "ID-03", "ID-04"]) {
      expect(ledger).toMatch(new RegExp(
        `data-deliverable-key="${id}" data-deliverable-truth="LIVE" data-deliverable-plan="COMPLETE"`,
      ));
    }
    expect(ledger).toMatch(
      /data-deliverable-key="ID-05" data-deliverable-truth="PARTIAL" data-deliverable-plan="ACTIVE"/,
    );
    expectAllAllowed(values(/data-deliverable-truth="([^"]+)"/g), truthStates);
    expectAllAllowed(values(/data-deliverable-plan="([^"]+)"/g), planStates);
    expect(values(/data-deliverable-plan="(ACTIVE|NEXT)"/g)).toEqual(["ACTIVE"]);
    expect(ledger).toMatch(
      /data-deliverable-key="ID-05"[^>]+data-deliverable-plan="ACTIVE"[^>]+data-deliverable-approval="APPROVED"[^>]+data-deliverable-parent="WS-E"/,
    );
    expect(ledger).toContain("Brief 7 · public/self-hosting");
    const id09 = recordBlocks("details", "data-deliverable-key")
      .find((block) => block.includes('data-deliverable-key="ID-09"')) ?? "";
    expect(id09).toContain("No approved or published Round-2 guide and no runnable candidate exist");
    expect(id09).toContain('href="aprd/v2.1-cli-user-guide.md"');
    expect(id09).not.toContain("No Round-2 candidate or guide exists");
    expect(count('data-deliverable-approval="')).toBe(ids.length);
    expect(count('data-deliverable-parent="')).toBe(ids.length);
    expect(count('data-deliverable-last-verified="')).toBe(ids.length);
    for (const block of recordBlocks("details", "data-deliverable-key")) {
      const parent = block.match(/data-deliverable-parent="([^"]+)"/)?.[1];
      const rendered = block.match(/<dt>Linked Project Index rows<\/dt><dd>(.*?)<\/dd>/)?.[1];
      expect(rendered).toBe(parent);
    }
    for (const field of [
      "Claim or goal", "Evidence", "Linked Project Index rows",
      "Decisions or blockers", "Source artifacts", "Last verified",
    ]) {
      expect(count(`<dt>${field}</dt>`)).toBeGreaterThanOrEqual(ids.length);
    }
  });

  test("keeps vivid owner scenarios honest and fully linked", () => {
    expect(values(/data-scenario-key="([^"]+)"/g)).toEqual(["S1", "S2", "S3"]);
    expectAllAllowed(values(/data-scenario-truth="([^"]+)"/g), truthStates);
    expect(count('data-scenario-approval="APPROVED"')).toBe(3);
    expect(count('data-scenario-approval="PROPOSED"')).toBe(0);
    expect(ledger).toContain("Owner-approved target journeys");
    expect(ledger).toContain("The fresh first Angel");
    expect(ledger).toContain("Draft, never send");
    expect(ledger).toContain("A useful multi-App assistant");
    for (const field of [
      "Evidence", "Linked Project Index rows", "Decisions or blockers",
      "Source artifacts", "Last verified",
    ]) {
      expect(count(`<strong>${field}</strong>`)).toBeGreaterThanOrEqual(3);
    }
  });

  test("states fourteen target laws without confusing them with shipped truth", () => {
    expect(values(/data-guarantee-key="([^"]+)"/g)).toEqual(
      Array.from({ length: 14 }, (_, index) => `G${String(index + 1).padStart(2, "0")}`),
    );
    expectAllAllowed(values(/data-guarantee-truth="([^"]+)"/g), truthStates);
    expect(ledger).toMatch(/data-guarantee-key="G08" data-guarantee-truth="NOT BUILT"/);
    expect(count("What this means to Sam")).toBe(14);
    expect(count("Current truth state")).toBeGreaterThanOrEqual(14);
    expect(count("Boundary")).toBeGreaterThanOrEqual(17);
    expect(count('data-guarantee-last-verified="')).toBe(14);
    expect(ledger).toContain("G01 · Angel is a toolbox, never an actor");
    expect(ledger).toContain("G14 · Source and deploy topology stay bounded");
    const g07 = recordBlocks("article", "data-guarantee-key")
      .find((block) => block.includes('data-guarantee-key="G07"')) ?? "";
    expect(g07).toContain("second real identity waits for M-DF2");
    expect(g07).not.toContain("waits for M2");
  });

  test("adds the Experience Window with embedded current product evidence", () => {
    expect(values(/data-experience-key="([^"]+)"/g)).toEqual([
      "EW1", "EW2", "EW3", "EW4", "EW5", "EW6",
    ]);
    expectAllAllowed(values(/data-experience-truth="([^"]+)"/g), truthStates);
    expect(values(/data-experience-plan="(ACTIVE|NEXT)"/g)).toEqual([]);
    expect(count('class="experience-shot" src="data:image/png;base64,')).toBe(6);
    expect(count('data-experience-last-verified="')).toBe(6);
    for (const key of ["EW1", "EW2", "EW3", "EW4", "EW5", "EW6"]) {
      expect(ledger).toMatch(new RegExp(`data-experience-key="${key}"[^>]+data-experience-blockers="[^"]*O10`));
    }
    expect(ledger).toContain("Experience Window — the skin");
    expect(ledger).toContain("wp4-zero-guide-light.png");
    expect(ledger).toContain("wpb-decision-combined-light.png");
  });

  test("adds the Machinery Window with key objects, owners, and trust boundaries", () => {
    expect(values(/data-machinery-key="([^"]+)"/g)).toEqual([
      "MW1", "MW2", "MW3", "MW4", "MW5", "MW6", "MW7", "MW8", "MW9",
    ]);
    expectAllAllowed(values(/data-machinery-truth="([^"]+)"/g), truthStates);
    expect(count('data-machinery-last-verified="')).toBe(9);
    expect(ledger).toContain("Machinery Window — under the hood");
    for (const object of [
      "Account", "Angel source and bundle", "Provider App", "Connection",
      "Version", "Deployment", "Angel key", "Gateway and Broker gates", "Gate receipt",
    ]) {
      expect(ledger).toContain(object);
    }
  });

  test("adds the Surface Window with the exact current and next CLI map", () => {
    expect(values(/data-command-key="([^"]+)"/g)).toEqual([
      "C01", "C02", "C03", "C04", "C05", "C06", "C07",
      "C08", "C09", "C10", "C11", "C12", "C13",
    ]);
    expectAllAllowed(values(/data-command-truth="([^"]+)"/g), truthStates);
    expectAllAllowed(values(/data-command-plan="([^"]+)"/g), planStates);
    expect(values(/data-command-plan="(ACTIVE|NEXT)"/g)).toEqual([]);
    expect(count('data-command-last-verified="')).toBe(13);
    const commandLinks: Record<string, string> = {
      C01: "WS1 · ID-04", C02: "WS2 · PD-01", C03: "WS2 · PD-02",
      C04: "WS2 · PD-02 · PD-03", C05: "M0 · WS1 · PD-02", C06: "WS2 · PD-02",
      C07: "M1 · WS2 · PD-03", C08: "M1", C09: "WS2 · PD-03",
      C10: "WS2 · PD-03", C11: "WS2 · PD-03", C12: "M1 · WS1",
      C13: "WS2 · PD-01 · M-DF2",
    };
    for (const [key, linked] of Object.entries(commandLinks)) {
      expect(ledger).toMatch(new RegExp(`data-command-key="${key}"[^>]+data-command-linked="${linked}"`));
    }
    for (const key of ["C02", "C03", "C04", "C06", "C07", "C09", "C10", "C11", "C13"]) {
      expect(ledger).toMatch(new RegExp(`data-command-key="${key}"[^>]+data-command-blockers="[^"]*O10`));
    }
    expect(ledger).toMatch(/data-command-key="C01"[^>]+data-command-blockers="O1"/);
    expect(ledger).not.toMatch(/data-command-key="C01"[^>]+data-command-blockers="[^"]*O8/);
    expect(ledger).toContain("Surface Window — control surfaces");
    for (const command of [
      "Install", "angel account login", "angel create", "angel apps connect",
      "angel build", "angel serve", "angel publish", "angel deploy --prod",
      "angel verify", "angel receipts pull", "angel replay", "angel delete",
      "Account delete/reset",
    ]) {
      expect(ledger).toContain(command);
    }
    expect(ledger).toContain("Require exactly one of <code>--local</code> or <code>--cloud</code>");
    expect(ledger).toContain("Use one-shot top-level <code>angel replay</code>");
  });

  test("reconciles all dogfood, trust, and owner-feedback learnings once", () => {
    const ids = values(/data-learning-id="([^"]+)"/g);
    expect(ids).toHaveLength(113);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith("DF-"))).toEqual(
      Array.from({ length: 68 }, (_, index) => `DF-${String(index + 1).padStart(3, "0")}`),
    );
    expect(ids.filter((id) => id.startsWith("LR-"))).toEqual(
      Array.from({ length: 28 }, (_, index) => `LR-${String(index + 1).padStart(3, "0")}`),
    );
    expect(ids.filter((id) => id.startsWith("FB-"))).toEqual(
      Array.from({ length: 17 }, (_, index) => `FB-${String(index + 1).padStart(3, "0")}`),
    );
    expect(count('data-learning-last-verified="')).toBe(113);
    expect(count('data-learning-blocker="')).toBe(113);
    expect(count('data-learning-source="')).toBe(113);
    const fb014 = ledger.match(/<tr data-learning-id="FB-014"[\s\S]*?<\/tr>/)?.[0] ?? "";
    const indexCount = values(/data-index-key="([^"]+)"/g).length;
    expect(fb014).toContain(`${indexCount} expandable index rows in this Ledger.`);
    expect(fb014).not.toContain("Nine expandable index rows");
  });

  test("keeps zero orphans with valid dispositions and destinations", () => {
    const rows = [...ledger.matchAll(
      /data-learning-id="([^"]+)" data-disposition="([^"]+)" data-destination="([^"]+)"/g,
    )];
    expect(rows).toHaveLength(113);
    const validDispositions = new Set(["INCLUDED", "PROPOSED", "DEFERRED", "UNRESOLVED"]);
    const validDestinations = new Set([
      "M1", "WS0", "M-DF1", "WS1", "WS-E", "WS2", "M-DF2", "WS3", "WS4",
      "O1", "O2", "O3", "O4", "O5", "O6", "O7", "O8", "O9", "O10",
    ]);
    for (const row of rows) {
      const disposition = row[2] ?? "";
      const destination = row[3] ?? "";
      expect(validDispositions.has(disposition)).toBe(true);
      expect(validDestinations.has(destination)).toBe(true);
      if (disposition === "UNRESOLVED") expect(destination.startsWith("O")).toBe(true);
    }
    const dispositions = rows.map((row) => row[2] ?? "");
    expect(dispositions.filter((value) => value === "INCLUDED")).toHaveLength(35);
    expect(dispositions.filter((value) => value === "PROPOSED")).toHaveLength(44);
    expect(dispositions.filter((value) => value === "DEFERRED")).toHaveLength(29);
    expect(dispositions.filter((value) => value === "UNRESOLVED")).toHaveLength(5);
    expect(ledger).toContain(`data-learning-count="${rows.length}"`);
    expect(ledger).toContain(`<span class="metric"><b>${rows.length}</b>reconciled</span>`);
    for (const disposition of validDispositions) {
      const count = dispositions.filter((value) => value === disposition).length;
      expect(ledger).toContain(`<span class="metric"><b>${count}</b>${disposition.toLowerCase()}</span>`);
    }
    const orphanCount = ledger.match(/data-orphan-count="(\d+)"/)?.[1];
    expect(orphanCount).toBe("0");
    expect(ledger).toContain(`<span class="metric"><b>${orphanCount}</b>orphans</span>`);
  });

  test("keeps decisions and contradictions inspectable on the data spine", () => {
    expect(values(/data-decision-key="([^"]+)"/g)).toEqual(
      Array.from({ length: 10 }, (_, index) => `O${index + 1}`),
    );
    expect(count('data-decision-state="OPEN"')).toBe(2);
    expect(count('data-decision-state="CLOSED"')).toBe(8);
    expect(count('data-decision-last-verified="')).toBe(10);
    expect(ledger).toMatch(
      /data-decision-key="O8"[^>]+data-decision-state="CLOSED"[^>]+data-decision-linked="WS1"/,
    );
    expect(ledger).toMatch(/data-decision-key="O10"[^>]+data-decision-linked="WS2 · M-DF2"/);
    expect(ledger).toContain("O8 is closed: Sam approved contract v0.1, this Ledger, and WS1 only");
    expect(ledger).toContain("O2–O7 and O9 are closed as decisions");
    expect(ledger).toContain("O1 still needs namespace-control proof");
    expect(ledger).toContain("Approve WS2 and M-DF2 after WS-E closes O1–O7 and O9?");
    expect(ledger).toContain("O1 blocks WS-E evidence closure");
    expect(ledger).toContain("<code>@angelmcp/cli@0.1.0</code>");
    expect(ledger).not.toContain("Blocks WS1 completion at ID-04");
    const g14 = ledger.slice(
      ledger.indexOf('id="guarantee-G14"'),
      ledger.indexOf("</article>", ledger.indexOf('id="guarantee-G14"')),
    );
    expect(g14).not.toContain("O8");
    const contradictions = [...ledger.matchAll(
      /data-contradiction-key="(C\d+)" data-record-state="([^"]+)"/g,
    )];
    expect(contradictions).toHaveLength(16);
    expect(contradictions.filter((row) => row[2] === "OPEN")).toHaveLength(2);
    expect(contradictions.filter((row) => row[2] === "CLOSED")).toHaveLength(14);
    expect(count('data-contradiction-last-verified="')).toBe(16);
    const c1 = recordBlocks("details", "data-contradiction-key")
      .find((block) => block.includes('data-contradiction-key="C1"')) ?? "";
    expect(c1).toContain("ID-03 and ID-04 deliverables");
    expect(c1).not.toContain("INT deliverables");
    expect(ledger).toMatch(/data-contradiction-key="C15" data-record-state="CLOSED"/);
    expect(ledger).toMatch(/data-contradiction-key="C16" data-record-state="OPEN"/);
  });

  test("shows the optional-module chooser without silently adopting modules", () => {
    expect(ledger).toContain('data-contract-module-registry="none-v0.1"');
    expect(ledger).toContain("The approved registry is empty in approved v0.1");
    expect(ledger).toContain("Seven contract candidates pinned to approved v0.1");
    expect(ledger).not.toContain("proposed v0.1");
    expect(ledger).toContain('data-adopted-module-count="0"');
    expect(ledger).toContain('data-available-module-count="0"');
    expect(ledger).toContain('data-project-candidate-count="0"');
    expect(values(/data-candidate-module-key="([^"]+)"/g)).toEqual([]);
    expect(count("#appendix-candidate-modules")).toBe(7);
    expect(ledger).toContain("Project-specific candidates — none");
    expect(ledger).not.toContain("Angel trigger observed");
    expect(ledger).toContain("Optional modules — none adopted");
    const visibleChooser = htmlSection("optional-modules");
    for (const name of [
      "Reliability and Operations Window",
      "Security, Privacy, and Compliance Window",
      "Customer and Market Evidence Window",
      "Commercial and Cost Window",
      "Ecosystem and Compatibility Window",
      "Rollout and Migration Window",
      "AI and Data Quality Window",
    ]) {
      expect(visibleChooser).toContain(name);
    }
    expect(ledger).toContain("Contract candidates are discussion prompts, not approved scope");
  });

  test("keeps execution subordinate to product truth", () => {
    expect(ledger).toContain("GitHub Issues");
    expect(ledger).toContain("must not become a second roadmap");
    expect(ledger).toContain("same PR");
    expect(ledger).toContain("Ledger intent PR");
    expect(ledger).toContain("Ledger truth PR");
    expect(ledger).toContain("adding Linear is unnecessary");
  });

  test("proves native expansion, internal links, evidence links, and approved-milestone closure", () => {
    const indexBlocks = recordBlocks("details", "data-index-key");
    expect(indexBlocks).toHaveLength(10);
    for (const block of indexBlocks) {
      expect(block).toContain("<summary>");
      for (const field of [
        "Measurable goal", "Essential deliverables", "Blocking evals",
        "Dependencies and open decisions", "Artifact links",
        "Completion evidence", "Linked rows", "Last verified",
      ]) expect(block).toContain(`<strong>${field}</strong>`);
    }

    for (const match of ledger.matchAll(/href="#([^"]+)"/g)) {
      expect(ledger).toContain(`id="${match[1]}"`);
    }

    const completeIndex = indexBlocks.filter((block) =>
      block.includes('data-index-plan="COMPLETE"')
    );
    for (const block of completeIndex) {
      expect(block).toContain("<a href=");
      expect(block).not.toMatch(/Dependencies and open decisions<\/strong><div>[^<]*\bO\d+/);
    }

    for (const attribute of [
      "data-guarantee-key", "data-machinery-key", "data-command-key",
      "data-deliverable-key",
    ]) {
      for (const block of recordBlocks(attribute === "data-command-key" || attribute === "data-deliverable-key" ? "details" : "article", attribute)) {
        if (block.includes('="LIVE"') || block.includes('plan="COMPLETE"')) {
          expect(block).toContain("<a href=");
        }
      }
    }
  });

  test("enforces the Data spine on every record rather than aggregate counts", () => {
    const expectFields = (blocks: string[], labels: string[]) => {
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        for (const label of labels) expect(block).toContain(label);
      }
    };

    expectFields(recordBlocks("details", "data-deliverable-key"), [
      "Claim or goal", "Evidence", "Linked Project Index rows",
      "Decisions or blockers", "Source artifacts", "Last verified",
    ]);
    expectFields(recordBlocks("article", "data-scenario-key"), [
      "Claim or goal", "Boundary", "Evidence", "Linked Project Index rows",
      "Decisions or blockers", "Source artifacts", "Last verified",
    ]);
    expectFields(recordBlocks("article", "data-guarantee-key"), [
      'class="law"', "Current truth state", "Boundary", "Linked Project Index rows",
      "Decisions or blockers", "Source artifacts", "Last verified",
    ]);
    expectFields(recordBlocks("article", "data-experience-key"), [
      "Claim or goal", "Evidence", "Linked Project Index rows",
      "Decisions or blockers", "Source artifacts", "Last verified",
    ]);
    expectFields(recordBlocks("article", "data-interface-key"), [
      "Claim or goal", "Evidence", "Linked Project Index rows", "Decisions or blockers",
      "Source artifacts", "Last verified",
    ]);
    expectFields(recordBlocks("article", "data-machinery-key"), [
      "Claim or goal", "Owner", "Relationships", "Source of truth",
      "Evidence and gap", "Linked Project Index rows", "Decisions or blockers",
      "Source artifacts", "Last verified",
    ]);
    expectFields(recordBlocks("details", "data-command-key"), [
      "Claim or goal", "Side effect", "Human handoff", "Evidence",
      "Linked Project Index rows", "Decisions or blockers", "Source artifacts",
      "Last verified",
    ]);
    expectFields(recordBlocks("details", "data-decision-key"), [
      "Claim or goal", "Evidence", "Linked Project Index rows",
      "Decisions or blockers", "Source artifacts", "Last verified",
    ]);
    expectFields(recordBlocks("details", "data-contradiction-key"), [
      "Claim or goal", "Evidence", "Linked Project Index rows",
      "Decisions or blockers", "Source artifacts", "Last verified",
    ]);
    const lastVerifiedBlocks = [
      ...recordBlocks("details", "data-index-key"),
      ...recordBlocks("details", "data-deliverable-key"),
      ...recordBlocks("article", "data-scenario-key"),
      ...recordBlocks("article", "data-guarantee-key"),
      ...recordBlocks("article", "data-experience-key"),
      ...recordBlocks("article", "data-machinery-key"),
      ...recordBlocks("article", "data-interface-key"),
      ...recordBlocks("details", "data-command-key"),
      ...recordBlocks("details", "data-decision-key"),
      ...recordBlocks("details", "data-contradiction-key"),
    ];
    for (const block of lastVerifiedBlocks) {
      const machine = block.match(/data-[\w-]+-last-verified="([^"]+)"/)?.[1];
      const rendered = block.match(/(?:<dt>Last verified<\/dt><dd>|<strong>Last verified<\/strong><div>)(.*?)(?:<\/dd>|<\/div>)/)?.[1];
      expect(rendered).toBe(machine);
      const machineBlockers = block.match(/data-[\w-]+-blockers="([^"]+)"/)?.[1];
      if (machineBlockers !== undefined) {
        const renderedBlockers = block.match(/(?:<dt>Decisions or blockers<\/dt><dd>|<strong>Decisions or blockers<\/strong><div>)(.*?)(?:<\/dd>|<\/div>)/)?.[1];
        expect(renderedBlockers).toBe(machineBlockers);
      }
    }
    const learningRows = recordBlocks("tr", "data-learning-id");
    expectFields(learningRows, [
      "data-disposition=", "data-destination=", "data-learning-blocker=",
      "data-learning-source=", "Evidence", "Decisions or blockers",
      "Source artifacts", "Last verified",
    ]);
    for (const row of learningRows) {
      expect(row.match(/<td(?:\s|>)/g) ?? []).toHaveLength(5);
      const disposition = row.match(/data-disposition="([^"]+)"/)?.[1];
      expect(disposition).toBeDefined();
      expect(row).toContain(`>${disposition}</span>`);
      const source = row.match(/data-learning-source="([^"]+)"/)?.[1];
      expect(source).toBeDefined();
      const renderedEvidence = row.match(/href="(evidence\/ws-e\/[^"]+)"/)?.[1];
      if (renderedEvidence) expect(source).toBe(renderedEvidence);
      if (source !== "#sources") {
        expect(source).not.toMatch(/^(?:[a-z]+:|\/|\.\.)/i);
        const sourceUrl = new URL(source ?? "", ledgerUrl);
        expect(sourceUrl.protocol).toBe("file:");
        expect(existsSync(fileURLToPath(sourceUrl))).toBe(true);
        expect(row).toContain(`href="${source}"`);
      }
    }
    expect(ledger).not.toMatch(/N\/A —\s*(?:<|&lt;)/);
  });

  test("resolves every repository-relative evidence link from the Ledger file", () => {
    for (const href of values(/<a\s[^>]*href="([^"]+)"/g)) {
      const githubDoc = href.match(/^https:\/\/github\.com\/exocognito\/angelmcp\/blob\/([^/]+)\/([^#]+)(?:#(.+))?$/);
      if (githubDoc?.[2]) {
        expect(githubDoc[1], `Ledger evidence must use the canonical main ref: ${href}`).toBe("main");
        const target = new URL(`../../${githubDoc[2]}`, import.meta.url);
        expect(existsSync(fileURLToPath(target)), `Ledger link does not resolve: ${href}`).toBe(true);
        if (githubDoc[3]) {
          const markdown = readFileSync(target, "utf8");
          expect(headingSlugs(markdown).has(decodeURIComponent(githubDoc[3])), `Ledger heading does not resolve: ${href}`).toBe(true);
        }
        continue;
      }
      if (href.startsWith("#")) {
        const targetId = decodeURIComponent(href.slice(1));
        expect(ledger).toContain(`id="${targetId}"`);
        continue;
      }
      if (/^(?:https?:|mailto:)/.test(href)) continue;
      const [relativePath, fragment] = href.split("#", 2);
      const target = new URL(relativePath ?? "", ledgerUrl);
      expect(existsSync(fileURLToPath(target)), `Ledger link does not resolve: ${href}`).toBe(true);
      if (fragment && target.pathname.endsWith(".md")) {
        const markdown = readFileSync(target, "utf8");
        expect(headingSlugs(markdown).has(decodeURIComponent(fragment)), `Ledger heading does not resolve: ${href}`).toBe(true);
      }
    }
  });

  test("is self-contained and uses visible status text", () => {
    expect(ledger.split("<script>", 1)[0]).not.toMatch(/`[^`]+`/);
    expect(ledger).not.toContain('<script src=');
    expect(ledger).not.toContain('<link rel="stylesheet"');
    expect(ledger).not.toMatch(/<img[^>]+src="https?:/);
    expect(ledger).not.toContain("cdn.jsdelivr.net");
    expect(ledger).toContain("<script>");
    expect(ledger).toContain("prefers-reduced-motion");
    for (const state of [
      "LIVE", "PARTIAL", "BROKEN", "NOT BUILT",
      "COMPLETE", "ACTIVE", "NEXT", "BLOCKED", "LATER",
      "PROPOSED", "APPROVED", "OPEN", "CLOSED",
    ]) {
      expect(ledger).toContain(state);
    }
  });
});
