import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

/*
 * The Angel Product Ledger is generated. `datarooms/angel-cloud.json` is the
 * source of truth and `docs/product-ledger.html` is rendered from it by
 * ~/Projects/product-ledger/bin/ledger-render. So this file tests the dataroom
 * for product truth, and tests the page only for the things rendering can break.
 *
 * WHAT THIS FILE REPLACED, AND WHY — the previous test pinned a hand-built page
 * under the retired Ledger contract v0.1. Its assertions went three ways.
 *
 *   MOVED INTO THE DATAROOM (still tested, now against JSON, not HTML greps):
 *     - the 14 laws G01–G14 and their boundaries -> commitments + `limit`
 *     - deliverable claims and evidence          -> work `description`
 *     - approval facts (O8 2026-08-01, O10 2026-08-03) -> gate `description`
 *     - WS1 blocking evals, the angels#1 merge prerequisite, registry SRI and
 *       runtime-byte parity, and the missing 0.3.0 provenance attestation
 *       -> ID-03 / ID-04 `description` and `note` (asserted in ws1-monorepo)
 *
 *   RETIRED — the shape they described no longer exists in ledger-roadmap/v0.
 *   Each is named so no assertion disappears silently:
 *     R1  the whole machine-readable data-* attribute spine
 *         (data-contract-version, data-ledger-approval, data-current-workstream,
 *         data-product-work-approval, data-evidence-work-approval,
 *         data-approved-sequence, data-next-milestone-status,
 *         data-mobile-qa-width, data-mobile-qa-scroll-width).
 *         v0 carries identity in the dataroom; the page emits no data-* spine.
 *     R2  the Project Index rows and their eight named fields (Measurable goal,
 *         Essential deliverables, Blocking evals, Dependencies and open
 *         decisions, Artifact links, Completion evidence, Linked rows, Last
 *         verified). A v0 epic has outcome + commitments + gate, nothing else.
 *     R3  truth state distinct from plan status (LIVE / PARTIAL / BROKEN /
 *         NOT BUILT). v0 has one `status`. Truth now lives in prose.
 *     R4  `Last verified` date and verifier on every record, and the
 *         machine/rendered equality check over them. v0 records no provenance
 *         and no staleness anywhere.
 *     R5  owner scenarios S1–S3 ("The fresh first Angel", "Draft, never send",
 *         "A useful multi-App assistant"). v0 has no golden-scenario surface.
 *         S1 survives only as an `exhibit` string on PD-06.
 *     R6  the three Product Anatomy windows — Experience (EW1–EW6 with six
 *         embedded base64 screenshots), Machinery (MW1–MW9), and Surface, which
 *         held both the interfaces SI1–SI6 (private www dashboard, Control
 *         browser API, Control /v1 management API, public MCP coordinate, public
 *         Angel page, public docs and agent files) and the commands C01–C13 with
 *         their side effect and human handoff. No home in v0. Two SI rows carried
 *         truth that had to survive: SI3's PARTIAL is now stated on PD-03 (the
 *         management surface issues no credential a terminal can hold) and SI6's
 *         BROKEN is stated on ID-06 (the published path failed its only real run).
 *     R7  the learning reconciliation surface: 113 learnings (DF-001–068,
 *         LR-001–028, FB-001–017), dispositions INCLUDED/PROPOSED/DEFERRED/
 *         UNRESOLVED with counts 35/49/29/0, and data-orphan-count="0".
 *         v0 has no reconciliation surface. The counts survive as a finding on
 *         GATE-M-DF1, which is asserted below.
 *     R8  the Decisions surface: O1–O10 with state, and contradictions C1–C16
 *         with state. v0 has no Decisions surface. The open one, C16, survives
 *         as a finding on GATE-WS2 and GATE-WS-E, asserted below.
 *     R9  the optional-module chooser (registry "none-v0.1", seven candidates,
 *         zero adopted). The optional-module system is not part of v0 at all.
 *     R10 "What this means to Sam" on each law. Closest v0 equivalent is the
 *         Owner voice, which is the base title/description.
 *     R11 the governance prose block ("GitHub Issues", "must not become a
 *         second roadmap", "Ledger intent PR", "adding Linear is unnecessary").
 *         The generated page renders no prose sections; that content lives in
 *         ROADMAP.md and in the product-ledger skill.
 *     R12 link resolution — every href resolves, GitHub links pin the main ref,
 *         heading fragments exist. The renderer emits no anchors at all, so
 *         there is nothing to resolve. Asserted below as a known limitation
 *         rather than dropped, so the day v0 grows links this test fails.
 *     R13 the zero-network assertions (no <link rel="stylesheet">, no remote
 *         <img>, no CDN). ledger-render links Google Fonts with a system-font
 *         fallback. Replaced below with an exact-allowlist assertion.
 *     R14 `prefers-reduced-motion`. The toolkit stylesheet has no such rule.
 *         Asserted below as a known gap so a fix flips the test, not the truth.
 *     R15 the `#sources` "Source register" and the status footer. The register
 *         listed what the Ledger reconciled — contract v0.1, dotfiles PR #307,
 *         the owner approval record, 62 committed www screenshots and manual
 *         images, and briefs 1–7 — under a "113 unique learnings · 0 orphans"
 *         footer. v0 has no register and no footer. The 113/0 half survives on
 *         GATE-M-DF1 and is asserted below; the source list does not, because v0
 *         records provenance per row (`exhibit`, `source`) rather than centrally.
 */

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const ledger = read("docs/product-ledger.html");
const dataroomText = read("datarooms/angel-cloud.json");
const dataroom = JSON.parse(dataroomText);
const roadmap = read("ROADMAP.md");
const aprdReadme = read("docs/aprd/README.md");

const TONED = new Set([
  "shipped", "passed", "live", "done",
  "active", "in-progress", "pending", "planned",
]);
const VOICES = ["engineer", "designer", "marketing", "product", "llm"] as const;

type Voiced = { voices?: Record<string, { title?: string; description?: string; absent?: true; reason?: string }> };
type Work = Voiced & { id: string; type: string; title: string; status: string; description: string; servesLaw?: string; serves?: string };
type Commitment = Voiced & { id: string; title: string; class: string; status: string; eval: string; limit: string; work?: Work[] };
type Gate = Voiced & { id: string; proof: string; status: string; description: string; findings?: { text: string; disposition: { kind: string; admits?: string } }[] };
type Epic = Voiced & { id: string; version: string; status: string; outcome: string; gate: Gate; commitments: Commitment[]; unattachedWork?: Work[] };

const epics: Epic[] = dataroom.releases;
const commitments = epics.flatMap((e) => e.commitments ?? []);
const allWork = epics.flatMap((e) => [...(e.commitments ?? []).flatMap((c) => c.work ?? []), ...(e.unattachedWork ?? [])]);
const gates = epics.map((e) => e.gate);
const everyRow: (Voiced & { id: string })[] = [...epics, ...gates, ...commitments, ...allWork];

describe("Angel Product Ledger — dataroom is the source of truth", () => {
  test("declares ledger-roadmap/v0 with the three required root keys", () => {
    expect(dataroom.$schema).toBe("ledger-roadmap/v0");
    expect(dataroom.product).toBe("Angel Cloud");
    expect(Array.isArray(dataroom.releases)).toBe(true);
    expect(epics.length).toBeGreaterThan(0);
  });

  test("the generated page is exactly this dataroom, never hand-edited", () => {
    // ledger-render inlines the dataroom verbatim. A hand edit to the HTML is
    // destroyed by the next render, so drift between the two is the one
    // failure mode that matters most.
    const inlined = ledger.match(
      /<script id="ledger" type="application\/json">\n([\s\S]*?)\n<\/script>/,
    )?.[1];
    expect(inlined).toBeDefined();
    expect(JSON.parse(inlined ?? "")).toEqual(dataroom);
  });

  test("re-rendering reproduces the committed page byte for byte", () => {
    // The check above only covers the inlined JSON: a hand edit to the markup,
    // the stylesheet or the renderer would survive it. This one re-runs the
    // generator and compares the whole file.
    //
    // The toolkit is a local clone with no remote (an open owner decision), so
    // on a machine without it this degrades to a skip with a stated reason
    // rather than a false pass or a false failure.
    const toolkit = process.env.PRODUCT_LEDGER_TOOLKIT
      ?? join(homedir(), "Projects/product-ledger");
    const renderer = join(toolkit, "bin/ledger-render");
    if (!existsSync(renderer)) {
      console.warn(
        `product-ledger toolkit not found at ${toolkit} — byte-for-byte render check skipped. `
        + "Set PRODUCT_LEDGER_TOOLKIT to enable it.",
      );
      return;
    }
    const out = join(mkdtempSync(join(tmpdir(), "ledger-render-")), "product-ledger.html");
    const run = spawnSync(renderer, [fileURLToPath(new URL("datarooms/angel-cloud.json", root)), "-o", out], {
      encoding: "utf8",
    });
    expect(run.status, `ledger-render failed: ${run.stderr}`).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(ledger);
  });

  test("keeps the epic order and identity the repository already cites", () => {
    expect(epics.map((e) => e.id)).toEqual([
      "M0", "M1", "WS0", "M-DF1", "WS1", "WS-E", "WS2", "M-DF2", "WS3", "WS4",
    ]);
    expect(epics.filter((e) => e.status === "active").map((e) => e.id)).toEqual(["WS2"]);
  });

  test("carries the fourteen laws with an eval and a limit each", () => {
    expect(commitments.map((c) => c.id).sort()).toEqual(
      Array.from({ length: 14 }, (_, i) => `G${String(i + 1).padStart(2, "0")}`),
    );
    for (const c of commitments) {
      expect(["entrenched", "amendable"]).toContain(c.class);
      expect(c.eval.length).toBeGreaterThan(20);
      expect(c.limit.length).toBeGreaterThan(20);
    }
    // `entrenched` is an unratified rename; the tag must not drift.
    expect(dataroomText).not.toMatch(/"class":\s*"(settled|fixed|load-bearing)"/);
  });

  test("gives every epic a gate with a described decision", () => {
    expect(gates).toHaveLength(epics.length);
    for (const g of gates) {
      expect(g.id).toMatch(/^GATE-/);
      expect(g.proof.length).toBeGreaterThan(10);
      expect(g.description.length).toBeGreaterThan(40);
    }
  });

  test("uses only status tokens the renderer tones, so no pill is silently grey", () => {
    // `status` is an open string in v0 and ledger-validate cannot catch this.
    // An unknown token renders a grey pill that means nothing to a reader.
    for (const row of [...epics, ...gates, ...commitments, ...allWork] as { id: string; status: string }[]) {
      expect(TONED.has(row.status), `${row.id} uses untoned status "${row.status}"`).toBe(true);
    }
    // The retired contract's vocabulary all renders grey. Do not port it back.
    for (const token of ["LIVE", "PARTIAL", "BROKEN", "NOT BUILT", "COMPLETE", "NEXT", "BLOCKED", "LATER"]) {
      expect(dataroomText).not.toContain(`"status": "${token}"`);
    }
  });

  test("keeps every id unique across the whole dataroom", () => {
    // The renderer keys voice data by id, so a duplicate silently overwrites
    // another row's readings.
    const ids = everyRow.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("attaches every feature to a law, or states what unattached work serves", () => {
    for (const epic of epics) {
      for (const c of epic.commitments ?? []) {
        for (const w of c.work ?? []) {
          expect(w.servesLaw, `${w.id} sits under ${c.id} without naming it`).toBe(c.id);
          expect(w.serves).toBeUndefined();
        }
      }
      for (const w of epic.unattachedWork ?? []) {
        // The deliberate third case: not a law-serving feature, and said so.
        // The renderer joins the distinct values into one label, so `serves` is
        // a short noun — the reasoning belongs in the description.
        expect(w.serves, `${w.id} is unattached without a stated purpose`).toBeTruthy();
        expect((w.serves ?? "").length).toBeGreaterThan(8);
        expect((w.serves ?? "").length, `${w.id}: serves is a label, not a sentence`).toBeLessThanOrEqual(24);
        expect(w.servesLaw).toBeUndefined();
      }
    }
  });
});

describe("Angel Product Ledger — the voice cascade", () => {
  test("keeps Owner out of voices, because Owner is the base fields", () => {
    for (const row of everyRow) {
      expect(row.voices == null || !("owner" in row.voices), `${row.id} declares an owner voice`).toBe(true);
    }
  });

  test("gives every row all five voices, each authored or deliberately absent", () => {
    for (const row of everyRow) {
      expect(row.voices, `${row.id} has no voices`).toBeDefined();
      for (const v of VOICES) {
        const cell = row.voices?.[v];
        expect(cell, `${row.id} is missing the ${v} voice`).toBeDefined();
        if (cell?.absent) {
          // Absent is a recorded judgment, not a gap.
          expect(cell.reason, `${row.id}/${v} is absent with no reason`).toBeTruthy();
          expect((cell.reason ?? "").length, `${row.id}/${v} reason is not a judgment`).toBeGreaterThan(10);
          expect(cell.title).toBeUndefined();
        } else {
          expect(cell?.title, `${row.id}/${v} has no title`).toBeTruthy();
          expect((cell?.description ?? "").length, `${row.id}/${v} description is thin`).toBeGreaterThan(40);
        }
      }
      expect(Object.keys(row.voices ?? {}).every((k) => (VOICES as readonly string[]).includes(k))).toBe(true);
    }
  });

  test("keeps engineer and designer as the truth floor", () => {
    // They are the eval-bearing ground truths every other voice narrows.
    // Marketing may narrow to nothing; these two may not go absent wholesale.
    const absent = (v: string) => everyRow.filter((r) => r.voices?.[v]?.absent).length;
    expect(absent("engineer")).toBeLessThan(everyRow.length / 4);
    expect(absent("designer")).toBeLessThan(everyRow.length / 3);
    // Marketing on an internal harness is the normal case, not a defect.
    expect(absent("marketing")).toBeGreaterThan(0);
  });

  test("keeps every voiced title short enough to render at 390px", () => {
    // The toolkit stylesheet has no media queries, and the header rows are
    // flex with a non-shrinking id, class tag, status pill and caret. A long
    // title — or one long word — pushes the page past 390px. Guarding the data
    // is the only lever a project has, since the CSS is shared and generated.
    for (const row of everyRow) {
      const titles = [
        ...VOICES.map((v) => row.voices?.[v]?.title).filter(Boolean),
      ] as string[];
      for (const t of titles) {
        expect(t.length, `${row.id}: title too long to render — "${t}"`).toBeLessThanOrEqual(62);
        const longest = t.split(/[\s—]+/).reduce((a, w) => (w.length > a.length ? w : a), "");
        expect(longest.length, `${row.id}: "${longest}" cannot wrap at 390px`).toBeLessThanOrEqual(18);
      }
    }
  });
});

describe("Angel Product Ledger — product truth that must not drift", () => {
  test("states what O8 and O10 approved, and does not read approval as proof", () => {
    const ws1Gate = gates.find((g) => g.id === "GATE-WS1")!;
    expect(ws1Gate.status).toBe("passed");
    expect(ws1Gate.description).toContain("2026-08-01");
    expect(ws1Gate.description).toContain("WS1");

    const ws2Gate = gates.find((g) => g.id === "GATE-WS2")!;
    expect(ws2Gate.status).toBe("pending");
    expect(ws2Gate.description).toContain("2026-08-03");
    expect(ws2Gate.description).toMatch(/approval is not proof/i);

    const df2Gate = gates.find((g) => g.id === "GATE-M-DF2")!;
    expect(df2Gate.status).toBe("pending");
    expect(df2Gate.findings ?? []).toHaveLength(0);
  });

  test("records G07 as narrowed by the 2026-08-04 run, not as holding outright", () => {
    // The evidence that proved G07 also named the exception. Recording only
    // the green half is exactly the drift this Ledger exists to prevent.
    const g07 = commitments.find((c) => c.id === "G07")!;
    expect(g07.status).toBe("in-progress");
    expect(g07.limit).toContain("claim path");
    expect(g07.limit).toContain("409");
    expect(JSON.stringify(g07)).toContain("2026-08-04");
  });

  test("keeps the unbuilt laws unbuilt", () => {
    const byId = Object.fromEntries(commitments.map((c) => [c.id, c]));
    expect(byId.G08.status).toBe("planned");
    expect(byId.G13.status).toBe("planned");
    for (const id of ["G10", "G11", "G12", "G14"]) expect(byId[id].status).toBe("in-progress");
    // Everything M0/M1 proved is live.
    for (const id of ["G01", "G02", "G03", "G04", "G05", "G06", "G09"]) expect(byId[id].status).toBe("live");
  });

  test("carries the scheduled widenings as notYet, never as a shipped claim", () => {
    const withNotYet = commitments.filter((c) => (c as { notYet?: unknown }).notYet);
    expect(withNotYet.map((c) => c.id).sort()).toEqual(["G10", "G11"]);
    for (const c of withNotYet) {
      const n = (c as unknown as { notYet: { claim: string; bindsDesign: string; claimsAt: string } }).notYet;
      expect(n.claim.length).toBeGreaterThan(20);
      expect(n.bindsDesign.length).toBeGreaterThan(20);
      expect(n.claimsAt).toBe("WS2");
    }
  });

  test("preserves the Round-1 reconciliation counts the old surface owned", () => {
    // R7: v0 has no reconciliation surface, so the 113/35/49/29/0 record lives
    // in this gate finding. If it vanishes, the migration lost real truth.
    const df1 = gates.find((g) => g.id === "GATE-M-DF1")!;
    const text = (df1.findings ?? []).map((f) => f.text).join(" ");
    expect(text).toContain("113");
    for (const n of ["35", "49", "29"]) expect(text).toContain(n);
    expect(text).toMatch(/0 unresolved/);
  });

  test("keeps C16 open rather than quietly closing it", () => {
    // R8: v0 has no Decisions surface. The one open contradiction survives as
    // a finding, and must not be recorded as settled.
    const findings = gates.flatMap((g) => (g.findings ?? []).map((f) => `${f.text} ${f.disposition.note ?? ""}`));
    const c16 = findings.filter((f) => f.includes("C16"));
    expect(c16.length).toBeGreaterThanOrEqual(1);
    for (const f of c16) expect(f).toMatch(/open|unresolved/i);
  });

  test("routes every adoption-evidence finding to a real epic", () => {
    const ids = new Set(epics.map((e) => e.id));
    for (const g of gates) {
      for (const f of g.findings ?? []) {
        if (f.disposition.kind === "adoption-evidence") {
          expect(f.disposition.admits, `${g.id} adoption evidence has no admits`).toBeTruthy();
          expect(ids.has(f.disposition.admits ?? ""), `${g.id} admits unknown epic`).toBe(true);
        }
      }
    }
  });

  test("keeps the pointer documents pointing at this one canonical Ledger", () => {
    expect(roadmap).toContain("[Angel Product Ledger](docs/product-ledger.html)");
    expect(roadmap).toContain("APRD v2 remains unapproved for implementation");
    expect(aprdReadme).toContain("**not approved for implementation**");
    expect(read("NEXT.md")).toContain("docs/product-ledger.html");
  });
});

describe("Angel Product Ledger — the generated page", () => {
  /*
   * The page is client-rendered: ledger-render inlines the dataroom, the Card
   * stylesheet and the renderer, and every row is built in the browser. So the
   * static file cannot be grepped for rows or status pills — those are checked
   * in a real browser at desktop and 390px, not here. What this block pins is
   * what the file itself must contain.
   */
  test("inlines the renderer and the stylesheet, with nothing left to fetch", () => {
    expect(ledger).toContain('<div id="ledger-root"></div>');
    expect(ledger).toContain('<script id="ledger" type="application/json">');
    expect(ledger).toContain("window.renderRoadmap");
    expect(ledger).toContain(".v-card .chead");
  });

  test("builds every row as a real control, not a click handler on a div", () => {
    // One template drives every expandable row, so pinning it once pins all of
    // them: reachable by Tab, operable by Enter and Space, state announced.
    expect(ledger).toContain('var ROW = \'data-x tabindex="0" role="button" aria-expanded="false"\'');
    expect(ledger).toMatch(/e\.key === "Enter" \|\| e\.key === " "/);
    expect(ledger).toContain('setAttribute("aria-expanded"');
  });

  test("tones only the eight known statuses, and labels all of them", () => {
    // Colour never carries meaning alone: the renderer prints label(status)
    // beside every pip. Anything outside this map renders a silent grey pill,
    // which is why the dataroom test above restricts the vocabulary.
    const toneMap = ledger.match(/var TONE = \{([^}]*)\}/)?.[1] ?? "";
    for (const token of TONED) {
      expect(toneMap, `${token} is not toned by the renderer`).toContain(token);
    }
    expect(ledger).toContain('label(w.status)');
    expect(ledger).toContain('label(e.status)');
  });

  test("loads no script or stylesheet beyond the declared font link", () => {
    // R13: the generated page is self-contained but NOT zero-network.
    expect(ledger).not.toContain("<script src=");
    expect(ledger).not.toMatch(/<img[^>]+src="https?:/);
    expect(ledger).not.toContain("cdn.jsdelivr.net");
    const stylesheets = ledger.match(/<link[^>]+rel="stylesheet"[^>]*>/g) ?? [];
    expect(stylesheets).toHaveLength(1);
    expect(stylesheets[0]).toContain("https://fonts.googleapis.com/css2?");
    // A system-font fallback must exist for when that request fails.
    expect(ledger).toMatch(/Georgia|ui-monospace|system-ui|-apple-system/);
  });

  test("documents the surfaces ledger-roadmap/v0 still cannot render", () => {
    // These are toolkit gaps, not repo defects. Each assertion fails the day
    // the toolkit grows the feature, which is when this test should be revised
    // rather than when the gap silently closes.
    expect(ledger.match(/<a\s[^>]*href=/g), "R12: v0 gained links — record evidence links again").toBeNull();
    expect(ledger.includes("prefers-reduced-motion"), "R14: v0 gained reduced-motion support").toBe(false);
    // `terms` is authored and validated, and never drawn. Asserting the absence
    // of specific markup would never flip, because the renderer would not emit
    // that markup under any implementation — so this checks that no term's
    // entity text reaches the page outside the inlined JSON.
    expect(Array.isArray(dataroom.terms)).toBe(true);
    expect(dataroom.terms.length).toBeGreaterThan(0);
    const outsideJson = ledger.replace(
      /<script id="ledger" type="application\/json">[\s\S]*?<\/script>/,
      "",
    );
    for (const t of dataroom.terms as { term: string; entity: string }[]) {
      expect(outsideJson, `R? v0 started drawing terms — ${t.term} is rendered`)
        .not.toContain(t.entity);
    }
  });
});
