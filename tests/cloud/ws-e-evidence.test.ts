import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { headingSlugs } from "./markdown-slugs";

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

  test("records WS-E complete with every decision closed", () => {
    expect(ledger).toMatch(/data-index-key="WS-E"[^>]+data-index-plan="COMPLETE"/);
    expect(ledger).toMatch(/data-deliverable-key="ID-05"[^>]+data-deliverable-truth="LIVE"[^>]+data-deliverable-plan="COMPLETE"/);
    // ID-05 describes the package O1 chose; WS2 built it, so "unbuilt" is stale.
    expect(ledger).toContain("WS2 has since built that package and proved its clean install; it is unpublished.");
    expect(ledger).not.toContain("the package itself is still unbuilt");
    for (const decision of ["O1", "O10"]) {
      expect(ledger).toMatch(new RegExp(`data-decision-key="${decision}"[^>]+data-decision-state="CLOSED"`));
    }
    for (const decision of ["O2", "O3", "O4", "O5", "O6", "O7", "O9"]) {
      expect(ledger).toMatch(new RegExp(`data-decision-key="${decision}"[^>]+data-decision-state="CLOSED"`));
    }
    expect(ledger).toContain("The owner created the <code>@angelmcp</code> npm org on 2026-08-03");
    expect(ledger).not.toContain("npm scope is unverified");
    expect(ledger).toMatch(/data-decision-key="O1"[^>]+data-decision-linked="WS-E · ID-05 · WS2"/);
    expect(ledger).toContain('data-current-workstream="WS2" data-current-workstream-status="ACTIVE"');
    for (const key of ["C4", "C6", "C13", "C15"]) {
      expect(ledger).toMatch(new RegExp(`data-contradiction-key="${key}" data-record-state="CLOSED"`));
    }
    expect(ledger).toMatch(/data-contradiction-key="C16" data-record-state="OPEN"/);
    expect(ledger).toContain("disposable real Google callback/client-type journey");
    expect(ledger).toContain("APRD assumes an OS keychain on exe.dev Linux; no storage/callback path is proved.");
    expect(ledger).toContain("APRD assumes one OAuth client can serve hosted and headless consent");
    expect(ledger).toMatch(/data-contradiction-key="C15"[\s\S]*?<dt>Linked Project Index rows<\/dt><dd>WS-E · WS2 · PD-02<\/dd>/);
    expect(ledger).toMatch(/data-contradiction-key="C16"[\s\S]*?<dt>Linked Project Index rows<\/dt><dd>WS2 · PD-02<\/dd>/);
    const c16 = ledger.match(/data-contradiction-key="C16"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(c16).toContain("C16 / WS2 callback execution gate");
    expect(c16).not.toContain("O2 callback execution gate");
    const ws2 = ledger.match(/data-index-key="WS2"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(ws2).toContain("O10 approved WS2 on 2026-08-03 as defined by the seven WS-E briefs");
    expect(ws2).toContain("permanent non-resolving tombstone");
    expect(ws2).toContain("stay public with a documented boundary");
    const o7 = ledger.match(/data-decision-key="O7"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(o7).toContain('data-decision-linked="WS0 · PD-00B · WS2 · PD-03 · PD-05"');
    expect(o7).toContain("<dt>Linked Project Index rows</dt><dd>WS0 · PD-00B · WS2 · PD-03 · PD-05</dd>");
    const c7 = ledger.match(/data-contradiction-key="C7"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(c7).toContain("CLI guide installs the core package; owner requires one public product package with separate internal core.");
    expect(c7).toContain("N/A — O1 closed on 2026-08-03. Publishing @angelmcp/cli@0.1.0 is an execution gate, not a decision.");
    for (const [key, label] of [
      ["O1", "Brief 1 · package/install"], ["O2", "Brief 2 · Linux storage"],
      ["O3", "Brief 3 · custody syntax"], ["O4", "Brief 4 · auth expiry"],
      ["O5", "Brief 5 · replay"], ["O6", "Brief 6 · deletion"],
      ["O7", "Brief 7 · public/self-hosting"], ["O9", "Brief 7 · public/self-hosting"],
    ] as const) {
      const decision = ledger.match(new RegExp(`data-decision-key="${key}"[\\s\\S]*?<\\/details>`))?.[0] ?? "";
      expect(decision).toContain(`>${label}</a>`);
    }
    const c06 = ledger.match(/data-command-key="C06"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(c06).toContain("Consent already occurred through <code>angel apps connect --local</code>");
    expect(c06).toContain("Human unlocks the vault and inspects the final provider side effect");
    expect(ledger).toContain("Blocked by every required WS2 proof. O10 approved M-DF2 on 2026-08-03");
    expect(ledger).toContain("O6 settled the deletion-cascade and non-resolving-handle-tombstone contract");
    expect(ledger).toContain("Seven decisions closed across six briefs");
    expect(ledger).toContain("Bun-global install proved against the current registry tarball");
    expect(ledger).toContain("N/A — O9 closed and O10 approved WS2 on 2026-08-03.");
    for (const [attribute, key] of [
      ...["MW1", "MW3", "MW4", "MW5", "MW7", "MW9"].map((key) => ["data-machinery-key", key]),
      ["data-interface-key", "SI2"],
    ]) {
      const record = ledger.match(new RegExp(`${attribute}="${key}"[\\s\\S]*?<\\/article>`))?.[0] ?? "";
      expect(record).toContain("N/A — O10 approved WS2 on 2026-08-03; linked execution proof remains incomplete.");
      expect(record).not.toContain("N/A — WS-E closed the decision");
    }
    expect(ledger).toContain("N/A — O6 closed and O10 approved WS2 on 2026-08-03.");
    for (const key of ["C4", "C6", "C13", "C15"]) {
      const contradiction = ledger.match(new RegExp(`<details class="contradiction" data-contradiction-key="${key}"[\\s\\S]*?<\\/details>`))?.[0] ?? "";
      expect(contradiction).toContain("source contracts reconciled by WS-E");
      expect(contradiction).not.toContain("WS2 execution gate");
    }
    const c6 = ledger.match(/data-contradiction-key="C6"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(c6).toContain("APRD and target CLI custody/host text now agrees");
    for (const contradiction of ledger.matchAll(/<details class="contradiction"[^>]+data-record-state="OPEN"[\s\S]*?<\/details>/g)) {
      expect(contradiction[0]).not.toContain("resolved this contradiction");
    }
    expect(ledger).toContain("WS-E followed and is complete.");
  });

  test("links every brief from the Ledger and preserves the evidence-only boundary", () => {
    for (const [file] of briefs) expect(ledger).toContain(`evidence/ws-e/${file}`);
    expect(ledger).toContain("Seven briefs exist. WS-E changed no product behavior");
    expect(ledger).not.toContain(">Open source</a>");
    expect(ledger).not.toContain("oscodev@");
    expect(ledger).not.toContain("oscollins@");
    expect(ledger).toContain("first fresh identity, then a second independent identity");
    expect(ledger).toContain("All ten decisions are closed: O2–O7 and O9 from the briefs on 2026-08-01, then O1 and O10 by owner decision on 2026-08-03");
    expect(ledger).toContain("WS-E authorized no product implementation and built none");
    const c9 = ledger.match(/data-contradiction-key="C9"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(c9).toContain("Brief 7 excludes provenance, adapter origin, and the source digest");
    expect(c9).toContain("stay in owner review and outside the capability summary");
    expect(c9).not.toContain("keep provenance owner-only in the capability summary");
    const c11 = ledger.match(/data-contradiction-key="C11"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(c11).toContain("Account deletion is an asynchronous, retryable hard-delete");
    const contradictionLinks: Record<string, string> = {
      C4: "WS2 · PD-01",
      C6: "WS2 · PD-02 · PD-03",
      C7: "WS-E · WS2",
      C9: "WS2 · PD-00B",
      C11: "WS2 · PD-01",
      C13: "WS2 · PD-03",
      C15: "WS-E · WS2 · PD-02",
      C16: "WS2 · PD-02",
    };
    for (const [key, linked] of Object.entries(contradictionLinks)) {
      const record = ledger.match(new RegExp(`data-contradiction-key="${key}"[\\s\\S]*?<\\/details>`))?.[0] ?? "";
      expect(record).toContain(`<dt>Linked Project Index rows</dt><dd>${linked}</dd>`);
    }
    const contradictionRecords = [...ledger.matchAll(/<details class="contradiction"[\s\S]*?<\/details>/g)].map((match) => match[0]);
    expect(contradictionRecords).toHaveLength(16);
    for (const record of contradictionRecords) {
      expect(record).not.toMatch(/<dt>Linked Project Index rows<\/dt><dd>[^<]*\bO\d+/);
    }
    const df047 = ledger.match(/<tr data-learning-id="DF-047"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(df047).toContain("Registry check 2026-08-01: @angelmcp/cli and angelmcp absent");
    const repositoryReviewRows = [
      "DF-001", "DF-007", "DF-009", "DF-010", "DF-014", "DF-016", "DF-018",
      "DF-020", "DF-021", "DF-022", "DF-030", "DF-032", "DF-037", "DF-040",
      "DF-050", "DF-052", "DF-054", "DF-058", "DF-059", "DF-063", "FB-006",
      "FB-007", "LR-001", "LR-003", "LR-005", "LR-007", "LR-008", "LR-014",
      "LR-015", "LR-016", "LR-017", "LR-019", "LR-028",
    ];
    for (const key of repositoryReviewRows) {
      const row = ledger.match(new RegExp(`<tr data-learning-id="${key}"[\\s\\S]*?<\\/tr>`))?.[0] ?? "";
      expect(row).toContain('data-learning-last-verified="2026-08-01 · repository evidence + WS-E review"');
      expect(row).toContain("<strong>Last verified</strong><div>2026-08-01 · repository evidence + WS-E review</div>");
    }
    expect(ledger).toContain("WS-E authorizes no product implementation");
    expect(roadmap).toMatch(/Every decision is now closed;\s+what remains is execution proof\./);
    expect(ledger).toContain("WS-E changed no product behavior, but corrected <code>docs/faq.md</code>, added authoring cross-references in <code>docs/user-manual.md</code> and <code>docs-site/public/SKILL.md</code>, recorded O7 in PD 0007, repaired stale plan-of-record pointers, blocked the target install contract on O1, applied LR-016's outside-candidate/internal-grader split to the eval draft, and reconciled the unapproved O2–O7 APRD, CLI, and eval contracts with the evidence decisions");
    expect(roadmap.replace(/\s+/g, " ")).toContain("WS-E changed no product behavior, but corrected `docs/faq.md`, added authoring cross-references in `docs/user-manual.md` and `docs-site/public/SKILL.md`, recorded O7 in PD 0007, repaired stale plan-of-record pointers, blocked the target install contract on O1, applied LR-016's outside-candidate/internal-grader split to the eval draft, and reconciled the unapproved O2–O7 APRD, CLI, and eval contracts with the evidence decisions.");
    expect(roadmap.replace(/\s+/g, " ")).toContain("O10 approves **WS2 and Dogfood Round 2** as the seven WS-E briefs define them");
    for (const line of roadmap.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(roadmap).toMatch(/evidence-only approval covers WS-E, also complete\./);
    const wsEIndex = ledger.match(/data-index-key="WS-E"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(wsEIndex).toContain("<strong>Linked rows</strong><div>WS2</div>");
    expect(wsEIndex).not.toContain("<strong>Linked rows</strong><div>WS1 → WS-E → WS2</div>");
    const id05 = ledger.match(/data-deliverable-key="ID-05"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(id05).toContain("matching public-boundary warning to <code>docs-site/public/SKILL.md</code>");
    expect(ledger).toContain('</div></div><div class="field compact"><strong>Required owner gate</strong><div>Closed — the owner gate between WS-E and WS2 was answered on 2026-08-03</div></div>');
    expect(ledger).not.toContain("<strong>Linked rows</strong><div>WS1 → WS-E → O10 → WS2</div>");
    expect(ledger.split("https://github.com/exocognito/angelmcp/pull/43#issuecomment-5152675520").length - 1).toBe(5);
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
    expect(ledger).not.toContain("WS-E must finish before O10");
    expect(roadmap).toContain("evidence-only approval covers WS-E, also complete");
    expect(roadmap).toMatch(/O1 fixes the public package as\s+`@angelmcp\/cli@0\.1\.0`/);
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
    expect(ledger).toContain("O10 accepted the permanent non-resolving handle tombstone on 2026-08-03");
    const o7 = ledger.match(/<details id="decision-O7"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(o7).toContain("What does the public review bundle contain?");
    expect(ledger.replace(o7, "")).not.toMatch(/review bundle/i);
    expect(ledger).not.toMatch(/public bundle/i);
    expect(ledger).toContain("Publish only the O7 capability summary");
    expect(ledger).toContain("hiding artifact commitment");
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
    expect(o7).toContain('<code>schema: "angel.public-review.v1"</code>');
    expect(o7).toContain('<code>disclosure: "capability-summary-only"</code>');
    expect(o7).toContain("eligible only when its canonical bytes and raw digest have never been public");
    expect(o7).toContain("Any owner-opted-in public-source disclosure is separate from the summary");
    expect(ledger).toContain("A cached digest keeps a historically exposed Version permanently non-hiding");
    expect(ledger).toContain("all existing digest-exposed Versions remain non-hiding");
    const lr002 = ledger.match(/<tr data-learning-id="LR-002"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(lr002).toContain("eligible only when its canonical bytes and raw digest have never been public");
    expect(lr002).toContain("Any owner-opted-in public-source disclosure is separate from the summary");
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
    expect(ledger).toMatch(/data-learning-id="DF-035"[^>]+data-learning-source="evidence\/ws-e\/07-public-review-and-self-hosting\.md"/);
    const df002 = ledger.match(/<tr data-learning-id="DF-002"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(df002).toContain('data-learning-source="evidence/ws-e/06-account-deletion.md"');
    expect(df002).toContain('href="evidence/ws-e/06-account-deletion.md"');
    for (const key of ["DF-026", "LR-010"]) {
      const row = ledger.match(new RegExp(`<tr data-learning-id="${key}"[\\s\\S]*?<\\/tr>`))?.[0] ?? "";
      expect(row).toContain('data-learning-source="evidence/ws-e/06-account-deletion.md"');
      expect(row).toContain('href="evidence/ws-e/06-account-deletion.md"');
      expect(row).toContain("new handle");
      if (key === "LR-010") {
        expect(row).toContain("Owner-approved identity sequence + WS-E handle recommendation");
        expect(row).toContain("issuecomment-5152622328");
      }
    }
    expect(deletionBrief).toContain("first fresh identity, then a second independent identity");
    expect(deletionBrief.replace(/\s+/g, " ")).toContain("WS-E recommends a new handle as the consequence of the permanent tombstone; O10 must accept that recommendation");
    expect(deletionBrief).toContain("issuecomment-5152622328");
    const df048 = ledger.match(/<tr data-learning-id="DF-048"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(df048).toContain("Round 2 defers curl; no installer enters WS2");
    expect(df048).not.toContain("if it reduces clean-room failure");
    const lr006 = ledger.match(/<tr data-learning-id="LR-006"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(lr006).toContain('href="evidence/ws-e/01-package-install-identity.md"');
    expect(lr006).toContain('href="evidence/ws1-core-history.json"');
    expect(lr006).toContain('href="evidence/ws1-release-baseline.json"');
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
    expect(ledger).toContain("docs/product-decisions/0007-capability-only-public-review.md");
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
    expect(reducedSummaryDecision.replace(/\s+/g, " ")).toContain("reduced public-summary decision (Product Ledger O7)");
    expect(reducedSummaryDecision.replace(/\s+/g, " ")).toContain("They stay public. The owner chose a documented boundary");
    for (const line of faq.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(faq).toMatch(/meant to stay public-safe\s+\(\[current public boundary\]\(#why-is-enforcement-not-done-by-the-model-or-a-prompt\)\)/);
    expect(faq).toContain("repository's canonical");
    expect(faq).toContain("[source-repository Product Ledger][product-ledger-source]");
    expect(faq.replace(/\s+/g, " ")).toContain("`ROADMAP.md` remains a stable pointer for old links");
    expect(faq).toContain("github.com/exocognito/angelmcp/blob/main/docs/product-ledger.html");
    expect(faq).not.toContain("plan-of-record `ROADMAP.md`");
    expect(ledger).toContain("Today’s basic page still exposes the raw policy digest, charter, and guard literals");
    const df049 = ledger.match(/<tr data-learning-id="DF-049"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(df049).toContain("APRD and target CLI auth text now state the 600-second single-use rule");
    expect(df049).not.toContain("APRD says days");
    for (const [key, evidence] of [
      ["LR-011", "APRD and target CLI auth text now state the 600-second single-use rule"],
      ["LR-012", "The target CLI guide now names @angelmcp/cli@0.1.0"],
      ["LR-013", "target CLI guide now requires exactly one of <code>--local</code> or <code>--cloud</code>"],
      ["LR-016", "Target generative evals now separate an internal fixture-aware grader from a no-repo outside candidate"],
      ["LR-017", "APRD §8.1 and the target CLI guide now put the fresh local-independence journey before managed login"],
      ["LR-018", "APRD, target CLI, and eval replay text now agree on top-level <code>angel replay</code>"],
    ] as const) {
      const row = ledger.match(new RegExp(`<tr data-learning-id="${key}"[\\s\\S]*?<\\/tr>`))?.[0] ?? "";
      expect(row).toContain(evidence);
      expect(row).not.toMatch(/CLI guide line 14|Generative eval line 100|Raw notes line 111 vs APRD|APRD §4\.4 vs CLI guide/);
    }
    const lr016 = ledger.match(/<tr data-learning-id="LR-016"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(lr016).toContain('data-learning-source="aprd/v2.1-generative-evals.md#docs-only-fresh-machine-journey-with-a-newly-generated-angel"');
    expect(lr016).toContain('href="aprd/v2.1-generative-evals.md#docs-only-fresh-machine-journey-with-a-newly-generated-angel"');
    const lr017 = ledger.match(/<tr data-learning-id="LR-017"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(lr017).toContain('data-learning-source="aprd/v2.1-cli-user-guide.md#fresh-local-independence-journey"');
    expect(lr017).toContain('href="aprd/v2.1-cli-user-guide.md#fresh-local-independence-journey"');
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
    expect(ledger).toContain("Before connecting, I—or another agent—can see which operations an Angel exposes and whether they are guarded; only the owner can check the artifact behind it.");
    expect(ledger).toContain("only for an eligible Version whose canonical bytes and raw digest have never been public");
    expect(ledger).toMatch(/data-deliverable-key="PD-00B"[^>]+data-deliverable-parent="WS0"/);
    for (const [attribute, key] of [
      ["data-experience-key", "EW3"],
      ["data-machinery-key", "MW3"],
      ["data-machinery-key", "MW4"],
    ]) {
      const record = ledger.match(new RegExp(`${attribute}="${key}"[\\s\\S]*?<\\/article>`))?.[0] ?? "";
      expect(record).toContain("evidence/ws-e/02-linux-oauth-storage.md");
      expect(record).toContain("evidence/ws-e/03-local-cloud-syntax.md");
    }
    const pd00b = ledger.match(/data-deliverable-key="PD-00B"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(pd00b).toContain("product-decisions/0002-public-angel-page.md");
    const g13 = ledger.match(/data-guarantee-key="G13"[\s\S]*?<\/article>/)?.[0] ?? "";
    expect(g13).toContain("adrs/0001-portable-angel-source-and-deployment-separation.md");
    const c04 = ledger.match(/data-command-key="C04"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(c04).toContain("v2.1-cli-user-guide.md#angel-apps-connect");
    expect(c04).toContain("user-manual.md#add-google-custody");
    const c11Command = ledger.match(/data-command-key="C11"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(c11Command).toContain("v2.1-cli-user-guide.md#angel-replay");
    expect(c11Command).toContain('href="#decision-O5"');
    expect(ledger).toMatch(/data-index-key="WS1"[^>]+data-index-last-verified="2026-08-01 · Pi release proof"/);
    const c10 = ledger.match(/<details class="command" data-command-key="C10"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(c10).toContain("owner-only mode-0600 NDJSON");
    expect(c10).toContain('href="evidence/ws-e/05-replay-syntax.md"');
    expect(ledger).toContain("WS-E decision evidence briefs 1–7");
    expect(ledger).not.toMatch(/proposed (?:Product Ledger )?contract v0\.1/i);
    const proposed = [...ledger.matchAll(/<tr data-learning-id="[^"]+"[^>]+data-disposition="PROPOSED"[^>]+data-destination="([^"]+)"[^>]*>[\s\S]*?<\/tr>/g)];
    expect(proposed).toHaveLength(49);
    const o1Closure = "N/A — O1 closed on 2026-08-03; the @angelmcp scope is owner-controlled.";
    // Exactly the five learnings O1 used to hold carry its closure text.
    const reconciledByO1 = new Set(["DF-029", "DF-047", "DF-048", "LR-006", "LR-012"]);
    let seenO1 = 0;
    for (const match of proposed) {
      const id = match[0].match(/data-learning-id="([^"]+)"/)?.[1] ?? "";
      const destination = match[1] ?? "";
      const blocker = match[0].match(/data-learning-blocker="([^"]+)"/)?.[1] ?? "";
      const approval = `N/A — O10 approved ${destination} on 2026-08-03; delivery is an execution gate.`;
      if (reconciledByO1.has(id)) {
        expect(blocker).toBe(o1Closure);
        expect(destination).toBe("WS2");
        seenO1 += 1;
      } else {
        expect(blocker).toBe(approval);
      }
      expect(match[0]).toContain(`<strong>Decisions or blockers</strong><div>${blocker}</div>`);
    }
    expect(seenO1).toBe(reconciledByO1.size);
    expect(ledger).toContain("Approved Product Ledger · approved contract v0.1");
    for (const key of ["WS-E", "M-DF2"]) expect(ledger).toMatch(new RegExp(
      `data-index-key="${key}"[^>]+data-index-last-verified="2026-08-03 · Sam owner decision"`,
    ));
    expect(ledger).toMatch(/data-index-key="WS2"[^>]+data-index-last-verified="2026-08-03 · WS2 CLI install proof"/);
    for (const key of [
      "ID-05", "ID-06", "ID-07", "ID-08", "ID-10",
      "PD-01", "PD-02", "PD-03", "PD-04", "PD-05", "PD-06", "PD-07",
    ]) expect(ledger).toMatch(new RegExp(
      `data-deliverable-key="${key}"[^>]+data-deliverable-last-verified="2026-08-03 · Sam owner decision"`,
    ));
    // ID-09 was re-verified by the WS2 install proof, not by the owner decision.
    expect(ledger).toMatch(/data-deliverable-key="ID-09"[^>]+data-deliverable-last-verified="2026-08-03 · WS2 CLI install proof"/);
    // O10 approved the named WS2 and M-DF2 increments, so approval reaches them.
    for (const key of [
      "ID-06", "ID-07", "ID-08", "ID-09", "ID-10",
      "PD-01", "PD-02", "PD-03", "PD-04", "PD-05", "PD-06", "PD-07",
    ]) expect(ledger).toMatch(new RegExp(
      `data-deliverable-key="${key}"[^>]+data-deliverable-approval="APPROVED"`,
    ));
    expect(ledger).not.toContain('data-deliverable-approval="PROPOSED"');
    for (const key of ["O1", "O10"]) expect(ledger).toMatch(new RegExp(
      `data-decision-key="${key}"[^>]+data-decision-last-verified="2026-08-03 · Sam owner decision"`,
    ));
    expect(ledger).toMatch(/data-contradiction-key="C7" data-record-state="CLOSED" data-contradiction-last-verified="2026-08-03 · Sam owner decision"/);
    const restamped = {
      index: [],
      experience: ["EW3"],
      command: ["C02", "C03", "C04", "C05", "C06", "C07", "C09", "C10", "C11", "C13"],
      guarantee: ["G08", "G10", "G11", "G13"],
      deliverable: [],
      interface: ["SI5"],
    } as const;
    expect(ledger).toMatch(/data-guarantee-key="G14"[^>]+data-guarantee-last-verified="2026-08-03 · WS2 CLI install proof"/);
    for (const key of ["SI1", "SI2", "SI3", "SI4", "SI6"]) expect(ledger).toMatch(new RegExp(
      `data-interface-key="${key}"[^>]+data-interface-last-verified="2026-08-01 · repository proof \\+ WS-E review"`,
    ));
    for (const key of ["MW1", "MW2", "MW3", "MW4", "MW5", "MW6", "MW7", "MW9"]) expect(ledger).toMatch(new RegExp(
      `data-machinery-key="${key}"[^>]+data-machinery-last-verified="2026-08-01 · repository proof \\+ WS-E review"`,
    ));
    expect(ledger).toMatch(/data-deliverable-key="PD-00B"[^>]+data-deliverable-last-verified="2026-08-01 · WS0 page proof \+ WS-E privacy review"/);
    for (const key of ["EW1", "EW2", "EW4", "EW5", "EW6"]) expect(ledger).toMatch(new RegExp(
      `data-experience-key="${key}"[^>]+data-experience-last-verified="2026-08-01 · M1 product evidence \\+ WS-E review"`,
    ));
    for (const key of ["S1", "S2"]) expect(ledger).toMatch(new RegExp(
      `data-scenario-key="${key}"[^>]+data-scenario-last-verified="2026-08-01 · Sam owner decision \\+ WS-E evidence"`,
    ));
    for (const [kind, keys] of Object.entries(restamped)) {
      for (const key of keys) expect(ledger).toMatch(new RegExp(
        `data-${kind}-key="${key}"[^>]+data-${kind}-last-verified="2026-08-01 · WS-E evidence"`,
      ));
    }
  });
});
