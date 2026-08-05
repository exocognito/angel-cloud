import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { headingSlugs } from "./markdown-slugs";

const root = join(import.meta.dir, "../..");
const roadmap = readFileSync(join(root, "ROADMAP.md"), "utf8");

// The Ledger is generated from this dataroom, so WS-E's product truth is
// asserted against the source rather than against rendered HTML.
type Work = { id: string; status: string; description: string; exhibit?: string; serves?: string };
const releases: {
  id: string;
  status: string;
  commitments?: unknown[];
  unattachedWork?: Work[];
  gate?: { status: string; findings?: { text: string }[] };
}[] = JSON.parse(readFileSync(join(root, "datarooms/angel-cloud.json"), "utf8")).releases;

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
    expect(readdirSync(join(root, "docs/evidence/ws-e")).sort())
      .toEqual(briefs.map(([file]) => file).sort());
    expect(headingSlugs("```sh\n~~~\n# not-a-heading\n```\n## real-heading"))
      .toEqual(new Set(["real-heading"]));
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
        if (resolvedPath.endsWith(".md")) expect(headingSlugs(targetSource).has(fragment)).toBe(true);
        else if (resolvedPath.endsWith(".html")) expect(targetSource).toContain(`id="${fragment}"`);
      }
      if ((decisions as readonly string[]).includes("O1")) {
        expect(brief).toContain("Outcome: exact gap");
        expect(brief).not.toContain("enough evidence to close O1");
        expect(brief).not.toContain("O1 should close");
        expect(brief).toContain("pnpm and Bun global installs");
        expect(brief).toContain("Bun-global registry-tarball install passed");
        expect(brief).toContain("the first draft of this record recommended closing O1");
        expect(brief).not.toContain("the investigator recommended closing O1");
        const canonical = brief.split("## Evidence record")[0] ?? "";
        expect(canonical).not.toContain("- Control the `@angelmcp` npm scope");
      } else expect(brief).toContain("Outcome: close");
      expect(brief).toContain("Repository state: `evidence/ws-e-decision-briefs` at `6cc2ed5`");
      const fullRecord = brief.split("## Evidence record", 2)[1] ?? "";
      expect(fullRecord).toContain("full record");
      const fullRecordProse = fullRecord.replace(/(```|~~~)[\s\S]*?\1/g, "");
      expect(fullRecordProse).not.toMatch(/^# /m);
      for (const duplicate of ["Question", "Method", "Verified results", "Product implication"]) {
        expect(fullRecordProse).not.toMatch(new RegExp(`^#{2,6} ${duplicate}$`, "m"));
      }
    }
  });

  test("records WS-E complete and evidence-only in the dataroom", () => {
    // This test used to grep docs/product-ledger.html for the retired contract's
    // decision records (data-decision-key O1-O10), contradiction records
    // (data-contradiction-key C1-C16), Machinery/Interface window rows, and
    // per-record last-verified strings. ledger-roadmap/v0 renders none of those
    // surfaces, and the Ledger is now generated - see the retirement list at the
    // top of product-ledger.test.ts (R1, R3, R4, R6, R7, R8). What survives of
    // WS-E's product truth lives in the dataroom, and is asserted here.
    const wsE = releases.find((r) => r.id === "WS-E");
    expect(wsE?.status).toBe("shipped");
    // WS-E authorized no product implementation and built none.
    expect(wsE?.commitments ?? []).toHaveLength(0);
    expect(JSON.stringify(wsE)).toContain("no product behavior changed");

    const id05 = (wsE?.unattachedWork ?? []).find((w) => w.id === "ID-05");
    expect(id05?.status).toBe("done");
    expect(id05?.serves).toContain("decision evidence");
    expect(id05?.exhibit).toContain("docs/evidence/ws-e");
    // ID-05 describes the package O1 chose; WS2 built it, so "unbuilt" is stale.
    expect(id05?.description).toContain("@angelmcp/cli@0.1.0");
    expect(id05?.description).not.toContain("unbuilt");

    const gate = wsE?.gate;
    expect(gate?.status).toBe("passed");
    const findings = (gate?.findings ?? []).map((f) => f.text).join(" ");
    expect(findings).toContain("Seven decisions closed");
    // C16 was left open rather than argued shut, and must stay that way.
    expect(findings).toContain("C16");
    expect(findings).toContain("OAuth client");
    // The reconciled APRD stays unapproved as an implementation contract.
    expect(findings).toContain("unapproved for implementation");
  });

  test("keeps the evidence-only boundary across the briefs and pointer docs", () => {
    // The contradiction records C1-C16 with their Project Index links, and the
    // 33 repository-review learning rows, described the retired Decisions and
    // reconciliation surfaces (R7, R8 in product-ledger.test.ts). The one open
    // contradiction, C16, is asserted in the test above and in the Ledger test.
    // Everything below is about the briefs and pointer documents themselves and
    // is unaffected by the Ledger migration.
    expect(roadmap).toMatch(/Every decision is now closed;\s+what remains is execution proof\./);
    expect(roadmap.replace(/\s+/g, " ")).toContain("WS-E changed no product behavior, but corrected `docs/faq.md`, added authoring cross-references in `docs/user-manual.md` and `docs-site/public/SKILL.md`, recorded O7 in PD 0007, repaired stale plan-of-record pointers, blocked the target install contract on O1, applied LR-016's outside-candidate/internal-grader split to the eval draft, and reconciled the unapproved O2–O7 APRD, CLI, and eval contracts with the evidence decisions.");
    expect(roadmap.replace(/\s+/g, " ")).toContain("O10 approves **WS2 and Dogfood Round 2** as the seven WS-E briefs define them");
    for (const line of roadmap.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(roadmap).toMatch(/evidence-only approval covers WS-E, also complete\./);
    // WS-E's own Ledger row and its ID-05 detail are asserted from the dataroom
    // in the test above; the matching public-boundary warning is pinned on the
    // file that has to carry it.
    expect(readFileSync(join(root, "docs-site/public/SKILL.md"), "utf8"))
      .toContain("The public Angel page renders the charter verbatim and the guard field names and");
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const next = readFileSync(join(root, "NEXT.md"), "utf8");
    for (const document of [readme, next]) {
      expect(document).toContain("docs/product-ledger.html");
      expect(document).not.toContain("ROADMAP.md](ROADMAP.md) — plan of record");
      expect(document).not.toContain("The plan of record is [ROADMAP.md]");
      expect(document).not.toMatch(/roadmap owns\s+sequence and status/i);
      expect(document).not.toContain("sequence in ROADMAP.md");
    }
    expect(readme).toContain("[Roadmap](ROADMAP.md) — browsable pointer to milestone sequence and status");
    expect(readme).toContain("Product Ledger source: `docs/product-ledger.html` — canonical plan of record");
    expect(readme).not.toContain("[Product Ledger](docs/product-ledger.html)");
    expect(next.replace(/\s+/g, " ")).toContain("[ROADMAP.md](ROADMAP.md) is the browsable pointer");
    expect(next).not.toContain("[Angel Product Ledger](docs/product-ledger.html)");
    const engineeringView = readFileSync(join(root, "docs/aprd/views/engineering.html"), "utf8");
    expect(engineeringView).toContain("The Angel Product Ledger owns sequence/status");
    expect(engineeringView).not.toContain("ROADMAP.md owns sequence/status");
    expect(roadmap).toContain("evidence-only approval covers WS-E, also complete");
    expect(roadmap).toMatch(/O1 fixes the public package as\s+`@angelmcp\/cli@0\.1\.0`/);
    const syntaxBrief = readFileSync(join(root, "docs/evidence/ws-e/03-local-cloud-syntax.md"), "utf8");
    expect(syntaxBrief).not.toContain("pnpm add --global @smcllns/angel-core@v2.1");
    expect(syntaxBrief).toContain("bun add --global @angelmcp/cli@0.1.0 # pending O1");
    expect(syntaxBrief).toContain("`apps connect google --local\\|--cloud`");
    expect(syntaxBrief).toContain("Angel-owned encrypted vault");
    expect(syntaxBrief).not.toContain("machine credential store");
    expect(syntaxBrief).not.toContain("O2 must prove the supported Linux path");
    expect(syntaxBrief).toContain("--control https://api.angelmcp.ai");
    expect(syntaxBrief).not.toContain("--control https://control.angelmcp.ai");
    expect(syntaxBrief).toContain("Keep the reconciled target guide and APRD aligned");
    const linuxBrief = readFileSync(join(root, "docs/evidence/ws-e/02-linux-oauth-storage.md"), "utf8");
    expect(linuxBrief).toContain("callback half of LR-009, tracked as Ledger contradiction C16");
    expect(linuxBrief).not.toContain("callback half of LR-009/O3");
    expect(linuxBrief).toContain("VM suffix uses UTC date 2026-08-02; the evidence run began on 2026-08-01 in America/Los_Angeles");
    expect(linuxBrief).toContain("local grant profile");
    expect(linuxBrief).not.toContain("local Connection");
    const packageBrief = readFileSync(join(root, "docs/evidence/ws-e/01-package-install-identity.md"), "utf8");
    expect(packageBrief).toContain("an isolated Bun-global install of the current registry tarball exposed bare `angel`");
    expect(packageBrief).toContain("docs/user-manual.md#install-the-cli");
    expect(packageBrief).not.toContain("docs/user-manual.md:449-465");
    expect(packageBrief).toContain("registry-absent when tested");
    expect(packageBrief).not.toContain("unclaimed `@angelmcp/cli`");
    const deletionBrief = readFileSync(join(root, "docs/evidence/ws-e/06-account-deletion.md"), "utf8");
    expect(deletionBrief).toContain("O10 must accept the non-resolving permanent-handle tombstone");
    expect(deletionBrief).toContain("local provider OAuth tokens in the Angel-owned encrypted vault");
    expect(deletionBrief).toContain("local files and the local Angel-owned encrypted vault");
    expect(deletionBrief).not.toContain("local files/keychain entries");
    expect(deletionBrief).toContain("local files and the local Angel-owned encrypted vault remain untouched, as does provider content; name both to the owner");
    expect(deletionBrief).not.toContain("provider content remains untouched and are named");
    expect(deletionBrief).toContain("public-review commitment nonces");
    expect(deletionBrief).toContain("project/user grant");
    expect(deletionBrief).toContain("all client IDs in the same Google Cloud project");
    expect(deletionBrief).toContain("Test sibling client IDs within one Google Cloud project");
    expect(deletionBrief).not.toContain("client/user grant");
    expect(deletionBrief).toContain("O6 decision: closed");
    expect(deletionBrief).toContain("WS2/O10 implementation acceptance: unapproved");
    expect(deletionBrief).not.toContain("Physical O6 closure");
    expect(deletionBrief).not.toContain("local provider OAuth tokens in the OS keychain");
    const publicBrief = readFileSync(join(root, "docs/evidence/ws-e/07-public-review-and-self-hosting.md"), "utf8");
    expect(publicBrief).toContain('"commitment": "<64 lowercase hexadecimal SHA-256 characters>"');
    expect(publicBrief).toContain("32-byte owner-held random nonce");
    expect(publicBrief).toContain("one nonce per eligible published Version");
    expect(publicBrief).toContain("reuse it for every public summary response for that Version");
    expect(publicBrief.replace(/\s+/g, " ")).toContain("A Version whose raw digest was ever publicly observable remains permanently non-hiding");
    expect(publicBrief.replace(/\s+/g, " ")).toContain("replacement Version with different canonical bytes whose raw digest has never been public");
    expect(publicBrief).toContain("cached-digest adversary");
    expect(publicBrief).toContain("A separate owner-opted-in public-source surface is outside `angel.public-review.v1`");
    expect(publicBrief).toContain("never include intentionally disclosed source fields in the summary");
    expect(publicBrief).not.toContain('"digest": "<64 lowercase hexadecimal SHA-256 characters>"');
    expect(publicBrief).not.toContain("hard-private public bundle");
    expect(publicBrief).toContain("Exclude from the capability summary");
    const replayBrief = readFileSync(join(root, "docs/evidence/ws-e/05-replay-syntax.md"), "utf8");
    expect(replayBrief).toContain("#### O5 full record: Verification commands");
    expect(replayBrief).not.toContain("05-replay-syntax full record");
    expect(replayBrief).not.toContain(".agents/parallel-agents/");
    expect(replayBrief).toContain("Product Ledger command C11");
    expect(replayBrief).toContain("Product Ledger contradiction C13 and learning LR-018");
    expect(replayBrief.replace(/\s+/g, " ")).toContain("At `6cc2ed5`, before the WS-E reconciliation, these 38 passing tests proved the current parser and the saved target-document contradiction");
    expect(deletionBrief).toContain("decision O6, guarantee G10, and command C13");
    expect(deletionBrief).toContain("first fresh identity, then a second independent identity");
    expect(deletionBrief.replace(/\s+/g, " ")).toContain("WS-E recommends a new handle as the consequence of the permanent tombstone; O10 must accept that recommendation");
    expect(deletionBrief).toContain("issuecomment-5152622328");
    const manual = readFileSync(join(root, "docs/user-manual.md"), "utf8");
    expect(manual).toContain("Before writing `charter` or `argGuards`, read");
    expect(manual).toContain("faq.md#why-is-enforcement-not-done-by-the-model-or-a-prompt");
    expect(manual).not.toContain("renders charter text");
    const faq = readFileSync(join(root, "docs/faq.md"), "utf8");
    expect(faq).toMatch(/The public Angel page\s+currently renders the free-text `charter`/);
    expect(faq).toMatch(/raw digest was ever\s+public remains non-hiding/);
    const publicPageDecision = readFileSync(join(root, "docs/product-decisions/0002-public-angel-page.md"), "utf8");
    expect(publicPageDecision).toContain("- Status: Partly superseded by [0007](0007-capability-only-public-review.md)");
    expect(publicPageDecision.replace(/\s+/g, " ")).toContain("argument guards, Version number, policy digest, and the line that the artifact is immutable");
    expect(publicPageDecision).toContain("Invariants regardless, each pinned by a test");
    expect(publicPageDecision).not.toContain("Privacy requirement before the reduced summary");
    expect(publicPageDecision).not.toContain("angel.public-review.v1");
    const reducedSummaryDecision = readFileSync(join(root, "docs/product-decisions/0007-capability-only-public-review.md"), "utf8");
    expect(reducedSummaryDecision).toContain("Do not emit `angel.public-review.v1` with a hiding claim for that Version");
    expect(reducedSummaryDecision).toContain("[E16 in the APRD's Evidence contracts list](https://github.com/exocognito/angelmcp/blob/main/docs/aprd/angel-cloud-aprd.html)");
    expect(reducedSummaryDecision.replace(/\s+/g, " ")).toContain("The proof requirement stands however that draft contract changes, is renumbered, or is dropped");
    expect(reducedSummaryDecision).toContain('`schema: "angel.public-review.v1"`');
    expect(reducedSummaryDecision).toContain('`disclosure: "capability-summary-only"`');
    expect(reducedSummaryDecision.replace(/\s+/g, " ")).toContain("A Version whose raw digest was ever public is permanently ineligible for a hiding claim");
    expect(reducedSummaryDecision.replace(/\s+/g, " ")).toContain("different canonical bytes whose raw digest has never been public");
    expect(reducedSummaryDecision).not.toContain("the Version number and raw policy digest leave the public projection");
    expect(reducedSummaryDecision.replace(/\s+/g, " ")).toContain("operational metadata that can reveal publish and activity cadence");
    expect(reducedSummaryDecision.replace(/\s+/g, " ")).toContain("Fixed, non-Version-specific provenance and limitation copy may remain outside the strict payload");
    const decisionIndex = readFileSync(join(root, "docs/product-decisions/README.md"), "utf8");
    expect(decisionIndex).toContain("[0007](0007-capability-only-public-review.md)");
    expect(faq.replace(/\s+/g, " ")).toContain("public-summary decision (O7 in the");
    expect(faq.replace(/\s+/g, " ")).toContain("the owner settled the broader question (O10 in the");
    expect(faq.replace(/\s+/g, " ")).toContain("charter text and guard literals stay public");
    expect(faq).toContain("docs/product-ledger.html");
    expect(faq).toContain("[source-repository Product Ledger][product-ledger-source]");
    expect(faq).toContain("[product-ledger-source]: https://github.com/exocognito/angelmcp/blob/main/docs/product-ledger.html");
    expect(faq.replace(/\s+/g, " ")).toContain("A Version whose raw digest was ever public remains non-hiding because an observer can retain it");
    expect(faq.match(/github\.com\/exocognito\/angelmcp\/(?:blob|tree|raw)\//g) ?? []).toHaveLength(1);
    // This used to pin "(Product Ledger O7)". The Ledger no longer carries a
    // decision record, so the citation now names the decision and the
    // commitment that carries it.
    expect(reducedSummaryDecision.replace(/\s+/g, " "))
      .toContain("reduced public-summary decision (decision O7, closed 2026-08-03)");
    expect(reducedSummaryDecision).toContain("commitment G11");
    expect(reducedSummaryDecision).not.toContain("records O7, SI5, and O10");
    expect(reducedSummaryDecision.replace(/\s+/g, " ")).toContain("They stay public. The owner chose a documented boundary");
    for (const line of faq.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(faq).toMatch(/meant to stay public-safe\s+\(\[current public boundary\]\(#why-is-enforcement-not-done-by-the-model-or-a-prompt\)\)/);
    expect(faq).toContain("repository's canonical");
    expect(faq).toContain("[source-repository Product Ledger][product-ledger-source]");
    expect(faq.replace(/\s+/g, " ")).toContain("`ROADMAP.md` remains a stable pointer for old links");
    expect(faq).toContain("github.com/exocognito/angelmcp/blob/main/docs/product-ledger.html");
    expect(faq).not.toContain("plan-of-record `ROADMAP.md`");
    // LR-011 to LR-018 were Ledger learning rows, retired under R7. The strip
    // left their loop behind with an empty body, which read as coverage while
    // asserting nothing; the guide-side facts they described are pinned in
    // aprd-v2.test.ts.
    for (const file of ["02-linux-oauth-storage.md", "03-local-cloud-syntax.md", "04-auth-expiry.md", "05-replay-syntax.md"]) {
      expect(readFileSync(join(root, "docs/evidence/ws-e", file), "utf8"))
        .toContain("At `6cc2ed5`, before the WS-E reconciliation");
    }
    const custodyBrief = readFileSync(join(root, "docs/evidence/ws-e/03-local-cloud-syntax.md"), "utf8");
    expect(custodyBrief).toContain("angel serve <angel> ... [--connection <nickname>]");
    expect(custodyBrief.match(/angel serve[^\n]*--connection/g)).toHaveLength(1);
    expect(custodyBrief).toContain("WS-E reconciliation renamed that local selector to `--grant`");
    expect(custodyBrief).toContain("angel serve draft-check-7k2m --port 7423 --grant local-gmail-7k2m");
    const storageBrief = readFileSync(join(root, "docs/evidence/ws-e/02-linux-oauth-storage.md"), "utf8");
    expect(storageBrief)
      .toContain("At `6cc2ed5`, before the WS-E reconciliation, the target APRD and CLI guide said local tokens and Account management tokens lived in the OS keychain");
    expect(storageBrief).toContain("only cloud Connection nicknames");
    const authBrief = readFileSync(join(root, "docs/evidence/ws-e/04-auth-expiry.md"), "utf8");
    expect(authBrief).toContain("At `6cc2ed5`, before the WS-E reconciliation, the target login guide described a keychain token");
    expect(authBrief).toContain("At `6cc2ed5`, before the WS-E reconciliation, APRD §4.1 used days-long links and conflicted with the Ledger");
    expect(authBrief).toContain("At `6cc2ed5`, before the WS-E reconciliation, O4 was open because the APRD said days while the owner and Ledger said minutes");
    const replayEvidenceBrief = readFileSync(join(root, "docs/evidence/ws-e/05-replay-syntax.md"), "utf8");
    expect(replayEvidenceBrief).toContain("angel replay <angel> --receipts <path> [--receipts <path> ...] --bundle <path>");
    expect(replayEvidenceBrief).not.toContain("angel replay <angel> --receipts <path> --bundle <path>");
    expect(replayEvidenceBrief).toContain("Gateway records: 24 (128..151)");
    expect(replayEvidenceBrief).toContain("Broker records: 16 (93..108)");
    expect(replayEvidenceBrief).toContain("Product Ledger contradiction C13 and learning LR-018");
    expect(replayEvidenceBrief).toContain("At `6cc2ed5`, before the WS-E reconciliation, the APRD commitment matrix still said `angel serve --replay`");
    expect(replayEvidenceBrief).toContain("At `6cc2ed5`, before the WS-E reconciliation, the APRD therefore contradicted itself as well as the guide");
    expect(replayEvidenceBrief).not.toContain("Product Ledger contradiction C13/LR-018");
    expect(replayEvidenceBrief).toContain("--gate <gateway|broker>");
    expect(replayEvidenceBrief).toContain("--anchor <sequence>:<hash>");
    expect(replayEvidenceBrief).toContain("Gateway-only denial");
    expect(replayEvidenceBrief.replace(/\s+/g, " ")).toContain("Allowed pairs correlate by `requestId`");
    expect(custodyBrief).toContain("--gate <gateway|broker>");
    expect(custodyBrief).toContain("(--anchor <sequence>:<hash> | --bootstrap)");
    for (const [file, terms] of [
      ["01-package-install-identity.md", ["decision O1", "contradiction C7"]],
      ["02-linux-oauth-storage.md", ["decision O2", "contradiction C15"]],
      ["03-local-cloud-syntax.md", ["decision O3", "contradiction C6", "command C06"]],
      ["04-auth-expiry.md", ["decision O4", "contradiction C4", "command C02"]],
    ] as const) {
      const source = readFileSync(join(root, "docs/evidence/ws-e", file), "utf8");
      for (const term of terms) expect(source).toContain(term);
    }
    // The Experience and Machinery window rows that cited briefs 2 and 3 are
    // retired (R6). The briefs they cited still have to exist.
    for (const file of ["02-linux-oauth-storage.md", "03-local-cloud-syntax.md"]) {
      expect(existsSync(join(root, "docs/evidence/ws-e", file)), `${file} must exist`).toBe(true);
    }
    // Everything from here to the end of this test asserted the retired
    // reconciliation and Product Anatomy surfaces: the PROPOSED learning rows
    // with their per-row blocker text, the deliverable last-verified and
    // approval stamps, and the eight rows the 2026-08-04 multi-tenant run
    // restamped together (R1, R4, R6, R7 in product-ledger.test.ts). The
    // 2026-08-04 regrade itself survives as product truth on G07, G10, PD-01,
    // PD-03 and PD-05 in the dataroom, asserted in product-ledger.test.ts.
  });
});
