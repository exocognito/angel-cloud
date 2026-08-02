import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

  test("keeps WS-E active on the exact O1 namespace-control gap", () => {
    expect(ledger).toMatch(/data-index-key="WS-E"[^>]+data-index-plan="ACTIVE"/);
    expect(ledger).toMatch(/data-deliverable-key="ID-05"[^>]+data-deliverable-truth="PARTIAL"[^>]+data-deliverable-plan="ACTIVE"/);
    for (const decision of ["O1", "O10"]) {
      expect(ledger).toMatch(new RegExp(`data-decision-key="${decision}"[^>]+data-decision-state="OPEN"`));
    }
    for (const decision of ["O2", "O3", "O4", "O5", "O6", "O7", "O9"]) {
      expect(ledger).toMatch(new RegExp(`data-decision-key="${decision}"[^>]+data-decision-state="CLOSED"`));
    }
    expect(ledger).toContain("Control of the <code>@angelmcp</code> npm scope is unverified");
    expect(ledger).toMatch(/data-decision-key="O1"[^>]+data-decision-linked="WS-E · ID-05 · WS2"/);
    expect(ledger).toContain('data-current-workstream="WS-E" data-current-workstream-status="ACTIVE"');
    expect(ledger).toMatch(/data-contradiction-key="C15" data-record-state="CLOSED"/);
    expect(ledger).toMatch(/data-contradiction-key="C16" data-record-state="OPEN"/);
    expect(ledger).toContain("disposable real Google callback/client-type journey");
    expect(ledger).toContain("APRD assumes an OS keychain on exe.dev Linux");
    expect(ledger).toContain("APRD assumes one OAuth client can serve hosted and headless consent");
    expect(ledger).toContain("The callback half of the original contradiction is carried by C16");
    expect(ledger).toMatch(/data-contradiction-key="C15"[\s\S]*?<dt>Linked Project Index rows<\/dt><dd>WS-E · WS2 · PD-02<\/dd>/);
    expect(ledger).toMatch(/data-contradiction-key="C16"[\s\S]*?<dt>Linked Project Index rows<\/dt><dd>WS2 · PD-02<\/dd>/);
    const c16 = ledger.match(/data-contradiction-key="C16"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(c16).toContain("C16 / WS2 callback execution gate");
    expect(c16).not.toContain("O2 callback execution gate");
    expect(ledger).toContain("Blocked by O1, O10, and every required WS2 proof");
    expect(ledger).toContain("O6 settled the deletion-cascade and non-resolving-handle-tombstone contract");
    expect(ledger).toContain("Seven decisions closed across six briefs");
    expect(ledger).toContain("Bun-global install proved against the current registry tarball");
    expect(ledger).toContain("O10 blocks WS2 product work; O9 is closed.");
    for (const [attribute, key] of [
      ...["MW1", "MW3", "MW4", "MW5", "MW7", "MW9"].map((key) => ["data-machinery-key", key]),
      ["data-interface-key", "SI2"],
    ]) {
      const record = ledger.match(new RegExp(`${attribute}="${key}"[\\s\\S]*?<\\/article>`))?.[0] ?? "";
      expect(record).toContain("O10 blocks WS2 product work; linked execution proof remains incomplete.");
      expect(record).not.toContain("N/A — WS-E closed the decision");
    }
    expect(ledger).toContain("O10 blocks WS2 product work; O6 is closed.");
    for (const key of ["C4", "C6", "C13"]) {
      const contradiction = ledger.match(new RegExp(`<details class="contradiction" data-contradiction-key="${key}"[\\s\\S]*?<\\/details>`))?.[0] ?? "";
      expect(contradiction).toContain("WS2 execution gate");
    }
    expect(ledger).toContain("WS-E is now active.");
  });

  test("links every brief from the Ledger and preserves the evidence-only boundary", () => {
    for (const [file] of briefs) expect(ledger).toContain(`evidence/ws-e/${file}`);
    expect(ledger).toContain("Seven briefs exist. WS-E changed no product behavior");
    expect(ledger).not.toContain(">Open source</a>");
    expect(ledger).not.toContain("oscodev@");
    expect(ledger).not.toContain("oscollins@");
    expect(ledger).toContain("first fresh identity, then a second independent identity");
    expect(ledger).toContain("The recorded WS-E bar allowed exact remaining gaps");
    expect(ledger).toContain("so the stricter bar governs, and WS-E stays active on O1");
    const c9 = ledger.match(/data-contradiction-key="C9"[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(c9).toContain("Brief 7 excludes provenance, adapter origin, and the source digest");
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
    expect(roadmap).toContain("WS-E authorizes no product implementation");
    expect(ledger).toContain("WS-E changed no product behavior, but corrected <code>docs/faq.md</code>, which understated the current public charter and guard exposure, and added an authoring cross-reference in <code>docs/user-manual.md</code>");
    expect(roadmap.replace(/\s+/g, " ")).toContain("WS-E changed no product behavior, but corrected `docs/faq.md`, which understated the current public charter and guard exposure, and added an authoring cross-reference in `docs/user-manual.md`.");
    for (const line of roadmap.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(roadmap).toMatch(/Product\/repository approval covers WS1, now complete\. Separate\s+evidence-only approval covers WS-E\. WS-E is active/);
    expect(ledger).toContain("WS1 → WS-E → WS2");
    expect(ledger).not.toContain("<strong>Linked rows</strong><div>WS1 → WS-E → O10 → WS2</div>");
    expect(ledger.split("https://github.com/exocognito/angelmcp/pull/43#issuecomment-5152675520").length - 1).toBe(5);
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const next = readFileSync(join(root, "NEXT.md"), "utf8");
    for (const document of [readme, next]) {
      expect(document).toContain("docs/product-ledger.html");
      expect(document).not.toContain("ROADMAP.md](ROADMAP.md) — plan of record");
      expect(document).not.toContain("The plan of record is [ROADMAP.md]");
    }
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
    expect(syntaxBrief).toContain("--control https://api.angelmcp.ai");
    expect(syntaxBrief).not.toContain("--control https://control.angelmcp.ai");
    expect(syntaxBrief).toContain("Reconcile the target guide's `--control` host with the settled host table");
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
    expect(publicBrief).toContain("one nonce per published Version");
    expect(publicBrief).toContain("reuse it for every public summary response for that Version");
    expect(publicBrief).toContain("remove or gate the raw `policyDigest` on every public surface for the same Version");
    expect(publicBrief).toContain("does not prevent offline confirmation while the current page publishes `policyDigest`");
    expect(publicBrief).toContain("A separate owner-opted-in public-source surface is outside `angel.public-review.v1`");
    expect(publicBrief).toContain("never include intentionally disclosed source fields in the summary");
    expect(o7).toContain("hiding only after every public surface for the same Version removes or gates the raw policy digest");
    expect(o7).toContain("Any owner-opted-in public-source disclosure is separate from the summary");
    const lr002 = ledger.match(/<tr data-learning-id="LR-002"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(lr002).toContain("hiding only after every public surface for the same Version removes or gates the raw policy digest");
    expect(lr002).toContain("Any owner-opted-in public-source disclosure is separate from the summary");
    expect(publicBrief).not.toContain('"digest": "<64 lowercase hexadecimal SHA-256 characters>"');
    const replayBrief = readFileSync(join(root, "docs/evidence/ws-e/05-replay-syntax.md"), "utf8");
    expect(replayBrief).toContain("Product Ledger command C11");
    expect(replayBrief).toContain("Product Ledger contradiction C13/LR-018");
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
    }
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
    expect(faq).toMatch(/The final privacy treatment\s+remains undecided/);
    for (const line of faq.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(faq).toMatch(/meant to stay public-safe\s+\(\[current public boundary\]\(#why-is-enforcement-not-done-by-the-model-or-a-prompt\)\)/);
    expect(faq).toContain("canonical `docs/product-ledger.html`");
    expect(faq.replace(/\s+/g, " ")).toContain("`ROADMAP.md` remains a stable pointer for old links");
    expect(faq).not.toContain("github.com/exocognito/angelmcp/blob/main/docs/product-ledger.html");
    expect(faq).not.toContain("plan-of-record `ROADMAP.md`");
    expect(ledger).toContain("Today’s basic page still exposes the raw policy digest, charter, and guard literals");
    expect(ledger).toContain("only after every public surface for the same Version removes or gates the raw policy digest");
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
    expect(proposed).toHaveLength(44);
    for (const match of proposed) {
      const destination = match[1] ?? "";
      const blocker = `O10 blocks ${destination} approval.`;
      expect(match[0]).toContain(`data-learning-blocker="${blocker}"`);
      expect(match[0]).toContain(`<strong>Decisions or blockers</strong><div>${blocker}</div>`);
    }
    expect(ledger).toContain("Approved Product Ledger · approved contract v0.1");
    const restamped = {
      index: ["WS2", "M-DF2"],
      experience: ["EW1", "EW2", "EW3", "EW4", "EW6"],
      command: ["C02", "C03", "C04", "C05", "C06", "C07", "C09", "C10", "C11", "C13"],
      guarantee: ["G08", "G10", "G11", "G13"],
      deliverable: ["ID-06", "ID-07", "ID-08", "PD-01", "PD-02", "PD-03", "PD-04"],
      interface: ["SI5"],
    } as const;
    expect(ledger).toMatch(/data-guarantee-key="G14"[^>]+data-guarantee-last-verified="2026-08-01 · WS1 release proof \+ WS-E evidence"/);
    for (const key of ["SI1", "SI2", "SI3", "SI4", "SI6"]) expect(ledger).toMatch(new RegExp(
      `data-interface-key="${key}"[^>]+data-interface-last-verified="2026-08-01 · repository proof \\+ WS-E review"`,
    ));
    for (const key of ["MW1", "MW2", "MW3", "MW4", "MW5", "MW6", "MW7", "MW9"]) expect(ledger).toMatch(new RegExp(
      `data-machinery-key="${key}"[^>]+data-machinery-last-verified="2026-08-01 · repository proof \\+ WS-E review"`,
    ));
    expect(ledger).toMatch(/data-deliverable-key="PD-00B"[^>]+data-deliverable-last-verified="2026-08-01 · WS0 page proof \+ WS-E privacy review"/);
    expect(ledger).toMatch(/data-experience-key="EW5"[^>]+data-experience-last-verified="2026-08-01 · M1 product evidence \+ WS-E review"/);
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
